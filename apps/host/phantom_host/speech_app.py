"""Fixed-loopback, offline speech helper for one bounded browser PCM clip."""

from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import re
import secrets
import threading
import time
import unicodedata
from collections.abc import AsyncIterator, Callable, Iterable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Protocol, cast

import numpy as np
from fastapi import FastAPI, HTTPException, Request

SAMPLE_RATE = 16_000
CHANNELS = 1
MAX_PCM_BYTES = SAMPLE_RATE * 3 * 2
MAX_PROXY_BYTES = 128 * 1024
MAX_VOICE_MS = 2_200  # two-word incantations; matches the browser endpointer cap
MAX_DEADLINE_MS = 1_500
DEADLINE_MISS_LIMIT = 3  # consecutive misses before the worker declares itself unhealthy
SECRET_ENV = "WAND_SPEECH_SECRET"
MODEL_DIR_ENV = "WAND_SPEECH_MODEL_DIR"
SECRET_HEADER = "x-wand-speech-secret"
MODEL_NAME = "base.en"
MODEL_REPOSITORY = "Systran/faster-whisper-base.en"
MODEL_REVISION = "3d3d5dee26484f91867d81cb899cfcf72b96be6c"
FASTER_WHISPER_VERSION = "1.2.1"
MODEL_METADATA = ".wand-speech-model.json"
GLOSSARY = (
    "Stupefy. Protego. Expelliarmus. Incendio. Sectumsempra. "
    "Petrificus Totalus. Expecto Patronum."
)
# Exact spoken incantation (after normalization) -> game spell identifier.
INCANTATIONS: dict[str, str] = {
    "stupefy": "stupefy",
    "protego": "protego",
    "expelliarmus": "expelliarmus",
    "incendio": "incendio",
    "sectumsempra": "sectumsempra",
    "petrificus totalus": "petrificus-totalus",
    "expecto patronum": "expecto-patronum",
}
SPELLS = frozenset(INCANTATIONS.values())
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class SpeechEngine(Protocol):
    def transcribe(self, pcm: np.ndarray) -> str: ...


class RuntimeBusy(Exception):
    pass


class RuntimeUnavailable(Exception):
    pass


class InferenceDeadlineMissed(Exception):
    pass


class SpeechConfigurationError(Exception):
    pass


@dataclass(frozen=True)
class InferenceResult:
    text: str
    inference_ms: int


class FasterWhisperEngine:
    def __init__(self, model_dir: Path) -> None:
        from faster_whisper import WhisperModel

        self._model = WhisperModel(
            str(model_dir),
            device="cpu",
            compute_type="int8",
            local_files_only=True,
            num_workers=1,
            cpu_threads=inference_threads(),
        )

    def transcribe(self, pcm: np.ndarray) -> str:
        call = cast(Callable[..., tuple[Iterable[object], object]], self._model.transcribe)
        segments, _info = call(
            pcm,
            language="en",
            task="transcribe",
            beam_size=1,
            best_of=1,
            temperature=0.0,
            condition_on_previous_text=False,
            initial_prompt=GLOSSARY,
            vad_filter=False,
            without_timestamps=True,
        )
        return " ".join(
            str(getattr(segment, "text", "")).strip() for segment in list(segments)
        ).strip()


def inference_threads() -> int:
    """Encoder threads for one greedy base.en pass.

    Measured on a 12-logical-core laptop: default 0 -> ~620 ms, 8 -> ~510 ms, 12 -> ~600 ms
    (hyper-thread contention). Half the logical cores plus two, clamped to 2..8.
    """
    return max(2, min(8, (os.cpu_count() or 4) // 2 + 2))


class SpeechRuntime:
    def __init__(
        self,
        model_dir: Path | None = None,
        loader: Callable[[], SpeechEngine] | None = None,
        generation: int | None = None,
    ) -> None:
        self.model_dir = model_dir
        self._loader = loader
        self.generation = generation or secrets.randbelow(2**31 - 1) + 1
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="wand-speech"
        )
        self._worker = threading.Lock()
        self._state = threading.Lock()
        self._engine: SpeechEngine | None = None
        self._warm = False
        self._ready = False
        self._busy = False
        self._issue = "Speech model has not been loaded"
        self._warmup_ms: int | None = None
        self._load_warm_ms: int | None = None
        self._deadline_misses = 0
        self._last_inference_ms: int | None = None
        self._started = False

    @classmethod
    def from_environment(cls) -> SpeechRuntime:
        value = os.environ.get(MODEL_DIR_ENV, "").strip()
        return cls(model_dir=Path(value).expanduser() if value else None)

    async def start(self) -> None:
        if self._started:
            return
        self._started = True
        loop = asyncio.get_running_loop()
        try:
            engine, warmup_ms, load_warm_ms = await loop.run_in_executor(
                self._executor, self._load_and_warm
            )
        except SpeechConfigurationError as error:
            self._set_unhealthy(str(error))
            return
        except Exception:
            self._set_unhealthy("Speech model could not be loaded from local files")
            return
        with self._state:
            self._engine = engine
            self._warm = True
            self._ready = True
            self._issue = ""
            self._warmup_ms = warmup_ms
            self._load_warm_ms = load_warm_ms

    async def stop(self) -> None:
        self._ready = False
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None,
            lambda: self._executor.shutdown(wait=True, cancel_futures=True),
        )

    def health(self) -> dict[str, object]:
        with self._state:
            ready = self._ready
            warm = self._warm
            busy = self._busy
            issue = self._issue
            deadline_misses = self._deadline_misses
            last_inference_ms = self._last_inference_ms
        return {
            "status": "ok" if ready and warm and not issue else "unhealthy",
            "ready": ready,
            "warm": warm,
            "busy": busy,
            "workerAvailable": ready and warm and not busy and not issue,
            "generation": self.generation,
            "model": MODEL_NAME,
            "modelRepository": MODEL_REPOSITORY,
            "modelRevision": MODEL_REVISION,
            "device": "cpu",
            "computeType": "int8",
            "language": "en",
            "issue": issue,
            "warmupMs": self._warmup_ms,
            "loadWarmMs": self._load_warm_ms,
            "deadlineMisses": deadline_misses,
            "deadlineMissLimit": DEADLINE_MISS_LIMIT,
            "lastInferenceMs": last_inference_ms,
        }

    async def transcribe(
        self, pcm: np.ndarray, deadline_budget_ms: int
    ) -> InferenceResult:
        with self._state:
            available = self._ready and self._warm and not self._issue
        if not available:
            raise RuntimeUnavailable
        if not self._worker.acquire(blocking=False):
            raise RuntimeBusy
        with self._state:
            self._busy = True

        future = self._executor.submit(self._infer, pcm)
        future.add_done_callback(
            lambda completed: self._inference_done(completed, deadline_budget_ms)
        )
        wrapped = asyncio.wrap_future(future)
        result = await asyncio.shield(wrapped)
        if result.inference_ms > deadline_budget_ms:
            raise InferenceDeadlineMissed
        return result

    def _load_and_warm(self) -> tuple[SpeechEngine, int, int]:
        load_started = time.perf_counter()
        engine = self._loader() if self._loader else self._load_local_engine()
        warm_started = time.perf_counter()
        engine.transcribe(np.zeros(SAMPLE_RATE // 4, dtype=np.float32))
        warmup_ms = round((time.perf_counter() - warm_started) * 1000)
        load_warm_ms = round((time.perf_counter() - load_started) * 1000)
        return engine, warmup_ms, load_warm_ms

    def _load_local_engine(self) -> SpeechEngine:
        if self.model_dir is None:
            raise SpeechConfigurationError(
                f"{MODEL_DIR_ENV} must point to the provisioned model directory"
            )
        if not self.model_dir.is_dir():
            raise SpeechConfigurationError("Provisioned speech model directory is missing")
        metadata_path = self.model_dir / MODEL_METADATA
        try:
            model_metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise SpeechConfigurationError(
                "Speech model metadata is missing; run the explicit setup script"
            ) from None
        if (
            model_metadata.get("repository") != MODEL_REPOSITORY
            or model_metadata.get("revision") != MODEL_REVISION
        ):
            raise SpeechConfigurationError("Speech model revision does not match the build")
        try:
            installed = metadata.version("faster-whisper")
        except metadata.PackageNotFoundError:
            raise SpeechConfigurationError(
                f"faster-whisper {FASTER_WHISPER_VERSION} is not installed"
            ) from None
        if installed != FASTER_WHISPER_VERSION:
            raise SpeechConfigurationError(
                f"faster-whisper {FASTER_WHISPER_VERSION} is required"
            )
        return FasterWhisperEngine(self.model_dir)

    def _infer(self, pcm: np.ndarray) -> InferenceResult:
        engine = self._engine
        if engine is None:
            raise RuntimeUnavailable
        started = time.perf_counter()
        text = engine.transcribe(pcm)
        elapsed = round((time.perf_counter() - started) * 1000)
        return InferenceResult(text=text, inference_ms=elapsed)

    def _inference_done(
        self, future: Future[InferenceResult], deadline_budget_ms: int
    ) -> None:
        issue = ""
        missed = False
        inference_ms: int | None = None
        try:
            result = future.result()
            inference_ms = result.inference_ms
            missed = result.inference_ms > deadline_budget_ms
        except Exception:
            issue = "Speech inference worker failed"
        with self._state:
            self._busy = False
            self._last_inference_ms = inference_ms
            if missed:
                # One slow pass is a 504 for that utterance only; a run of them
                # means the machine cannot keep up and the player must be told.
                self._deadline_misses += 1
                if self._deadline_misses >= DEADLINE_MISS_LIMIT:
                    issue = "Speech inference missed its caller deadline"
            elif not issue:
                self._deadline_misses = 0
            if issue:
                self._ready = False
                self._issue = issue
        self._worker.release()

    def _set_unhealthy(self, issue: str) -> None:
        with self._state:
            self._ready = False
            self._warm = False
            self._issue = issue


def create_app(
    runtime: SpeechRuntime | None = None, secret: str | None = None
) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        active_secret = secret or os.environ.get(SECRET_ENV, "")
        if not active_secret:
            raise RuntimeError(f"{SECRET_ENV} is required for every helper launch")
        active_runtime = runtime or SpeechRuntime.from_environment()
        app.state.speech_secret = active_secret
        app.state.speech_runtime = active_runtime
        await active_runtime.start()
        try:
            yield
        finally:
            await active_runtime.stop()

    app = FastAPI(
        title="Wand Speech Helper",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health(request: Request) -> dict[str, object]:
        authenticate(request)
        return active_runtime(request).health()

    @app.post("/transcribe")
    async def transcribe(request: Request) -> dict[str, object]:
        authenticate(request)
        utterance_id = required_header(request, "x-wand-utterance-id")
        if not ID_PATTERN.fullmatch(utterance_id):
            raise HTTPException(status_code=400, detail="Invalid utterance ID")
        generation = integer_header(request, "x-wand-generation", 1, 2**31 - 1)
        if required_header(request, "x-wand-audio-format") != "pcm_s16le":
            raise HTTPException(status_code=415, detail="Expected pcm_s16le")
        if integer_header(request, "x-wand-sample-rate", 1, 192_000) != SAMPLE_RATE:
            raise HTTPException(status_code=415, detail="Expected 16000 Hz PCM")
        if integer_header(request, "x-wand-channels", 1, 8) != CHANNELS:
            raise HTTPException(status_code=415, detail="Expected mono PCM")
        voice_start = decimal_header(request, "x-wand-voice-start-ms")
        voice_end = decimal_header(request, "x-wand-voice-end-ms")
        if voice_start < 0 or voice_end < voice_start:
            raise HTTPException(status_code=400, detail="Invalid voice interval")
        if voice_end - voice_start > MAX_VOICE_MS + 10:
            raise HTTPException(status_code=400, detail="Voice interval exceeds 2.2 s")
        deadline_budget = integer_header(
            request, "x-wand-deadline-budget-ms", 1, MAX_DEADLINE_MS
        )
        content_type = request.headers.get("content-type", "").split(";", 1)[0]
        if content_type != "application/octet-stream":
            raise HTTPException(status_code=415, detail="Expected raw PCM body")
        body = await bounded_body(request)
        if not body or len(body) % 2 or len(body) > MAX_PCM_BYTES:
            raise HTTPException(status_code=400, detail="Invalid bounded PCM body")
        pcm = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
        if not np.isfinite(pcm).all():
            raise HTTPException(status_code=400, detail="PCM contains invalid samples")
        speech_runtime = active_runtime(request)
        try:
            result = await speech_runtime.transcribe(pcm, deadline_budget)
        except RuntimeBusy:
            raise HTTPException(status_code=409, detail="Speech worker is busy") from None
        except RuntimeUnavailable:
            raise HTTPException(status_code=503, detail="Speech worker is unhealthy") from None
        except InferenceDeadlineMissed:
            raise HTTPException(
                status_code=504, detail="Speech inference missed its deadline"
            ) from None
        except Exception:
            raise HTTPException(
                status_code=503, detail="Speech inference worker failed"
            ) from None
        spell = canonical_spell(result.text)
        return {
            "utteranceId": utterance_id,
            "generation": generation,
            "text": normalize_text(result.text),
            "spell": spell,
            "helperGeneration": speech_runtime.generation,
            "model": MODEL_NAME,
            "modelRevision": MODEL_REVISION,
            "language": "en",
            "computeType": "int8",
            "beamSize": 1,
            "temperature": 0,
            "conditionOnPreviousText": False,
            "inferenceMs": result.inference_ms,
        }

    return app


def active_runtime(request: Request) -> SpeechRuntime:
    return cast(SpeechRuntime, request.app.state.speech_runtime)


def authenticate(request: Request) -> None:
    expected = cast(str, request.app.state.speech_secret)
    provided = request.headers.get(SECRET_HEADER, "")
    if not provided or not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


def required_header(request: Request, name: str) -> str:
    value = request.headers.get(name, "").strip()
    if not value:
        raise HTTPException(status_code=400, detail=f"Missing {name}")
    return value


def integer_header(request: Request, name: str, minimum: int, maximum: int) -> int:
    try:
        value = int(required_header(request, name))
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {name}") from None
    if value < minimum or value > maximum:
        raise HTTPException(status_code=400, detail=f"Invalid {name}")
    return value


def decimal_header(request: Request, name: str) -> float:
    try:
        value = float(required_header(request, name))
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid {name}") from None
    if not math.isfinite(value):
        raise HTTPException(status_code=400, detail=f"Invalid {name}")
    return value


async def bounded_body(request: Request) -> bytes:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_PROXY_BYTES:
                raise HTTPException(status_code=413, detail="PCM body is too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid content length") from None
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_PROXY_BYTES:
            raise HTTPException(status_code=413, detail="PCM body is too large")
    return bytes(body)


def normalize_text(text: str) -> str:
    """Case, punctuation and whitespace normalization only: never an alias or fuzzy match."""
    normalized = unicodedata.normalize("NFKC", text).casefold()
    words = [word.strip(".,!?;:'\"“”‘’-") for word in normalized.split()]
    return " ".join(word for word in words if word)


def canonical_spell(text: str) -> str | None:
    return INCANTATIONS.get(normalize_text(text))


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run(
        "phantom_host.speech_app:app",
        host="127.0.0.1",
        port=8001,
        access_log=False,
    )


if __name__ == "__main__":
    main()
