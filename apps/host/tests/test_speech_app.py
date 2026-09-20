from __future__ import annotations

import threading
import time
from collections.abc import Iterator

import numpy as np
import pytest
from fastapi.testclient import TestClient

from phantom_host.speech_app import SpeechRuntime, canonical_spell, create_app

SECRET = "test-only-per-launch-secret"


class FakeEngine:
    def __init__(self, text: str = "Stupefy!") -> None:
        self.text = text
        self.calls = 0

    def transcribe(self, _pcm: np.ndarray) -> str:
        self.calls += 1
        return "" if self.calls == 1 else self.text


class BlockingEngine(FakeEngine):
    def __init__(self) -> None:
        super().__init__()
        self.inference_started = threading.Event()
        self.release = threading.Event()

    def transcribe(self, pcm: np.ndarray) -> str:
        self.calls += 1
        if self.calls == 1:
            return ""
        self.inference_started.set()
        assert self.release.wait(timeout=2)
        return "Protego"


class SlowEngine(FakeEngine):
    def transcribe(self, pcm: np.ndarray) -> str:
        self.calls += 1
        if self.calls == 1:
            return ""
        time.sleep(0.02)
        return "Expelliarmus"


def headers(secret: str = SECRET) -> dict[str, str]:
    return {
        "X-Wand-Speech-Secret": secret,
        "Content-Type": "application/octet-stream",
        "X-Wand-Audio-Format": "pcm_s16le",
        "X-Wand-Sample-Rate": "16000",
        "X-Wand-Channels": "1",
        "X-Wand-Utterance-Id": "utterance-1",
        "X-Wand-Generation": "9",
        "X-Wand-Voice-Start-Ms": "100.0",
        "X-Wand-Voice-End-Ms": "400.0",
        "X-Wand-Deadline-Budget-Ms": "800",
    }


@pytest.fixture()
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture()
def client(engine: FakeEngine) -> Iterator[TestClient]:
    runtime = SpeechRuntime(loader=lambda: engine, generation=41)
    with TestClient(create_app(runtime=runtime, secret=SECRET)) as test_client:
        yield test_client


def test_health_requires_the_proxy_secret_and_reports_fixed_settings(
    client: TestClient,
) -> None:
    assert client.get("/health").status_code == 401
    response = client.get("/health", headers={"X-Wand-Speech-Secret": SECRET})
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "status": "ok",
        "ready": True,
        "warm": True,
        "busy": False,
        "workerAvailable": True,
        "generation": 41,
        "model": "base.en",
        "modelRepository": "Systran/faster-whisper-base.en",
        "modelRevision": "3d3d5dee26484f91867d81cb899cfcf72b96be6c",
        "device": "cpu",
        "computeType": "int8",
        "language": "en",
        "issue": "",
        "warmupMs": body["warmupMs"],
        "loadWarmMs": body["loadWarmMs"],
    }
    assert isinstance(body["warmupMs"], int)
    assert isinstance(body["loadWarmMs"], int)


def test_transcribe_accepts_only_bounded_raw_pcm_and_returns_canonical_evidence(
    client: TestClient, engine: FakeEngine
) -> None:
    response = client.post("/transcribe", headers=headers(), content=b"\x00\x00" * 1600)
    assert response.status_code == 200
    assert response.json() == {
        "utteranceId": "utterance-1",
        "generation": 9,
        "text": "stupefy",
        "spell": "stupefy",
        "helperGeneration": 41,
        "model": "base.en",
        "modelRevision": "3d3d5dee26484f91867d81cb899cfcf72b96be6c",
        "language": "en",
        "computeType": "int8",
        "beamSize": 1,
        "temperature": 0,
        "conditionOnPreviousText": False,
        "inferenceMs": response.json()["inferenceMs"],
    }
    assert engine.calls == 2, "one warmup and one fully consumed inference"


def test_noncanonical_words_never_become_a_spell() -> None:
    engine = FakeEngine("please cast stupefy")
    runtime = SpeechRuntime(loader=lambda: engine)
    with TestClient(create_app(runtime=runtime, secret=SECRET)) as client:
        response = client.post(
            "/transcribe", headers=headers(), content=b"\x00\x00" * 1600
        )
    assert response.status_code == 200
    assert response.json()["text"] == "please cast stupefy"
    assert response.json()["spell"] is None


@pytest.mark.parametrize("spell", ["stupefy", "protego", "expelliarmus", "incendio", "episkey"])
def test_all_five_incantations_require_the_exact_spell(spell: str) -> None:
    assert canonical_spell(f" {spell.upper()}! ") == spell
    assert canonical_spell(f"please cast {spell}") is None
    assert canonical_spell(f"{spell} protego") is None


def test_single_worker_rejects_a_second_request_without_queueing() -> None:
    engine = BlockingEngine()
    runtime = SpeechRuntime(loader=lambda: engine)
    with TestClient(create_app(runtime=runtime, secret=SECRET)) as client:
        first_response: list[int] = []

        def first_request() -> None:
            response = client.post(
                "/transcribe", headers=headers(), content=b"\x00\x00" * 1600
            )
            first_response.append(response.status_code)

        thread = threading.Thread(target=first_request)
        thread.start()
        assert engine.inference_started.wait(timeout=1)
        second = client.post(
            "/transcribe",
            headers={**headers(), "X-Wand-Utterance-Id": "utterance-2"},
            content=b"\x00\x00" * 1600,
        )
        assert second.status_code == 409
        engine.release.set()
        thread.join(timeout=2)
        assert not thread.is_alive()
        assert first_response == [200]
        assert engine.calls == 2


def test_deadline_miss_makes_the_worker_unhealthy() -> None:
    runtime = SpeechRuntime(loader=lambda: SlowEngine(), generation=17)
    request_headers = {**headers(), "X-Wand-Deadline-Budget-Ms": "1"}
    with TestClient(create_app(runtime=runtime, secret=SECRET)) as client:
        response = client.post(
            "/transcribe", headers=request_headers, content=b"\x00\x00" * 1600
        )
        assert response.status_code == 504
        health = client.get(
            "/health", headers={"X-Wand-Speech-Secret": SECRET}
        ).json()
        assert health["status"] == "unhealthy"
        assert health["workerAvailable"] is False
        assert health["issue"] == "Speech inference missed its caller deadline"


def test_request_limits_are_enforced_before_inference(client: TestClient) -> None:
    too_large = client.post(
        "/transcribe", headers=headers(), content=b"\x00" * (128 * 1024 + 2)
    )
    assert too_large.status_code == 413
    wrong_rate = client.post(
        "/transcribe",
        headers={**headers(), "X-Wand-Sample-Rate": "48000"},
        content=b"\x00\x00" * 1600,
    )
    assert wrong_rate.status_code == 415


def test_missing_model_is_a_clear_unhealthy_health_state(tmp_path) -> None:
    runtime = SpeechRuntime(model_dir=tmp_path / "missing", generation=23)
    with TestClient(create_app(runtime=runtime, secret=SECRET)) as client:
        health = client.get(
            "/health", headers={"X-Wand-Speech-Secret": SECRET}
        ).json()
    assert health["status"] == "unhealthy"
    assert health["ready"] is False
    assert health["issue"] == "Provisioned speech model directory is missing"


def test_launch_refuses_to_start_without_a_secret(
    monkeypatch: pytest.MonkeyPatch, engine: FakeEngine
) -> None:
    monkeypatch.delenv("WAND_SPEECH_SECRET", raising=False)
    runtime = SpeechRuntime(loader=lambda: engine)
    with pytest.raises(RuntimeError, match="WAND_SPEECH_SECRET is required"):
        with TestClient(create_app(runtime=runtime)):
            pass
