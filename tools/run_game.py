"""Start the isolated game stack. No installs, trust changes or flashing; the pinned speech model
is downloaded on first use if it is missing.

    python3 tools/run_game.py                      # frontend + speech here, the deployed referee for multiplayer
    python3 tools/run_game.py --local-referee      # everything on this laptop (offline, LAN or scripted QA)
    python3 tools/run_game.py --save-defaults --phone-service https://... --phone-secret-file <file>
    python3 tools/run_game.py --no-phone           # badge/replay only, ignore saved phone defaults (--badge-only also skips them)
    python3 tools/run_game.py --referee https://<other-referee> [--save-defaults]   # a different deployment

The referee is the deployed one (DEFAULT_REFEREE) unless --local-referee, --referee-bind,
--serve-referee or --qa asks for a local one, or --referee names another. A previous stack
started by this launcher is stopped automatically before the new one starts; ports held by
anything else still block startup. With a hosted https referee only the frontend and the speech
helper run here; the launcher wakes the referee before printing Game ready and keeps it awake
while the stack runs.
"""
from __future__ import annotations

import argparse
import signal
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler,
    HTTPSHandler,
    ProxyHandler,
    Request,
    build_opener,
)

ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local") if os.name == "nt" else os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "wandduel"
DEFAULTS_FILE = STATE_DIR / "launcher.json"
PID_FILE = STATE_DIR / "launcher.pid"
FRONTEND_PORT = 5173
REFEREE_PORT = 8000
SPEECH_PORT = 8001
# The team's deployed referee (render.yaml). Plain runs use it so any two laptops can duel.
DEFAULT_REFEREE = "https://wandduel-referee.onrender.com"
STARTUP_TIMEOUT_SECONDS = 60.0
HEALTH_REQUEST_TIMEOUT_SECONDS = 1.0
# A hosted free-tier referee sleeps when idle and takes about a minute to wake.
HOSTED_STARTUP_TIMEOUT_SECONDS = 150.0
HOSTED_HEALTH_REQUEST_TIMEOUT_SECONDS = 5.0
HOSTED_KEEPALIVE_SECONDS = 240.0
MAX_HEALTH_BYTES = 64 * 1024


class StartupError(RuntimeError):
    pass


def _load_defaults(path: Path | None = None) -> dict[str, str]:
    """Saved launcher defaults: only the phone service origin and the secret file's path."""
    path = path or DEFAULTS_FILE
    try:
        payload = json.loads(path.read_text())
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    allowed = {"phone_service", "phone_secret_file", "referee"}
    return {key: value for key, value in payload.items() if key in allowed and isinstance(value, str) and value}


def _save_defaults(
    phone_service: str | None,
    phone_secret_file: Path | None,
    path: Path | None = None,
    *,
    referee: str | None = None,
) -> None:
    """Merge the given defaults into the launcher file; fields not given keep their saved value."""
    path = path or DEFAULTS_FILE
    saved = _load_defaults(path)
    if phone_service and phone_secret_file:
        saved["phone_service"] = phone_service
        saved["phone_secret_file"] = str(phone_secret_file.resolve())
    if referee:
        saved["referee"] = referee
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(".json.pending")
    pending.write_text(json.dumps(saved, indent=2) + "\n")
    if os.name != "nt":
        os.chmod(pending, 0o600)
    pending.replace(path)


def _referee_origin(value: str) -> str:
    """Accept laptop A's private http://IP:8000 or one public https:// origin; nothing else."""
    parts = urlsplit(value.strip())
    if parts.username or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment or not parts.hostname:
        raise ValueError("Select one referee origin without a path, query or credentials")
    if parts.scheme == "https":
        return f"https://{parts.netloc}"
    if parts.scheme == "http":
        try:
            address = ipaddress.ip_address(parts.hostname)
        except ValueError:
            raise ValueError("A plain-http referee must be a private IPv4 address on port 8000") from None
        if address.version != 4 or not address.is_private or address.is_unspecified or parts.port != REFEREE_PORT:
            raise ValueError("A plain-http referee must be a private IPv4 address on port 8000")
        return f"http://{parts.hostname}:{REFEREE_PORT}"
    raise ValueError("Referee must be http://PRIVATE_IP:8000 or an https:// origin")


def _resolve_referee(
    *,
    explicit: str | None,
    local: bool,
    saved: str | None,
) -> str | None:
    """Which referee this run talks to: an explicit one, none (run it here), a saved one, or the deployed default."""
    if explicit:
        return _referee_origin(explicit)
    if local:
        return None
    return saved or DEFAULT_REFEREE


SPEECH_MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt", ".wand-speech-model.json")


def _speech_model_complete(model_dir: Path) -> bool:
    return all((model_dir / name).is_file() for name in SPEECH_MODEL_FILES)


def _ensure_speech_model(model_dir: Path, python: Path, run=subprocess.run) -> None:
    """Download the pinned transcription model on first use so the speech helper can start."""
    if _speech_model_complete(model_dir):
        return
    print(f"Local speech model is missing at {model_dir}; downloading the pinned faster-whisper base.en model ...", flush=True)
    result = run([str(python), str(ROOT / "tools" / "setup_speech.py"), "--model-dir", str(model_dir)], cwd=ROOT)
    if getattr(result, "returncode", 1) != 0 or not _speech_model_complete(model_dir):
        raise StartupError("the local speech model could not be provisioned; check the network and rerun")


def _launcher_pid(path: Path | None = None) -> int | None:
    """PID of a live stack started by this launcher, or None. Never trusts a recycled PID."""
    path = path or PID_FILE
    try:
        pid = int(path.read_text().strip())
    except (FileNotFoundError, OSError, ValueError):
        return None
    if pid <= 0 or pid == os.getpid():
        return None
    if os.name == "nt":
        return pid
    try:
        os.kill(pid, 0)
    except OSError:
        return None
    try:
        args = subprocess.run(["ps", "-o", "args=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return pid if "run_game.py" in args else None


def _stop_previous(path: Path | None = None, wait_seconds: float = 15.0) -> bool:
    """Stop a previous stack started by this launcher so a fresh one can take its ports."""
    path = path or PID_FILE
    pid = _launcher_pid(path)
    if pid is None:
        try:
            path.unlink()
        except (FileNotFoundError, OSError):
            pass
        return False
    print(f"Stopping the previous game stack (pid {pid}) ...", flush=True)

    try:
        os.kill(pid, signal.SIGINT if os.name != "nt" else signal.SIGTERM)
    except OSError:
        return False
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline and _launcher_pid(path) is not None:
        time.sleep(0.25)
    if _launcher_pid(path) is not None:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        time.sleep(1.0)
    try:
        path.unlink()
    except (FileNotFoundError, OSError):
        pass
    return True


def _required_listeners(
    frontend_host: str, local_referee_host: str | None
) -> list[tuple[str, str, int]]:
    listeners = [
        ("frontend", frontend_host, FRONTEND_PORT),
        ("speech helper", "127.0.0.1", SPEECH_PORT),
    ]
    if local_referee_host is not None:
        listeners.append(("referee", local_referee_host, REFEREE_PORT))
    return listeners


def _preflight_ports(listeners: list[tuple[str, str, int]]) -> None:
    for label, host, port in listeners:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                    probe.setsockopt(
                        socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1
                    )
                else:
                    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                probe.bind((host, port))
                probe.listen(1)
        except OSError:
            raise StartupError(
                f"{label} cannot use {host}:{port}; the port is occupied "
                "or the selected address is unavailable. Stop the owning process "
                "or choose the correct interface, then retry."
            ) from None


def _frontend_ssl_context(certificate: Path) -> ssl.SSLContext:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    try:
        context.load_verify_locations(cafile=str(certificate))
    except (OSError, ssl.SSLError):
        raise StartupError(
            "the selected TLS certificate could not be loaded as the frontend "
            "trust anchor"
        ) from None
    if hasattr(ssl, "VERIFY_X509_PARTIAL_CHAIN"):
        context.verify_flags |= ssl.VERIFY_X509_PARTIAL_CHAIN
    return context


def _request_health(
    url: str,
    headers: dict[str, str] | None = None,
    ssl_context: ssl.SSLContext | None = None,
    timeout: float = HEALTH_REQUEST_TIMEOUT_SECONDS,
) -> dict[str, object]:
    request = Request(url, headers=headers or {})
    opener = build_opener(
        ProxyHandler({}),
        _NoRedirects(),
        HTTPSHandler(context=ssl_context),
    )
    try:
        with opener.open(request, timeout=timeout) as response:
            if response.status != 200:
                raise StartupError(f"health endpoint returned HTTP {response.status}")
            body = response.read(MAX_HEALTH_BYTES + 1)
    except StartupError:
        raise
    except Exception as error:
        tls_error = error if isinstance(error, ssl.SSLCertVerificationError) else getattr(error, "reason", None)
        if isinstance(tls_error, ssl.SSLCertVerificationError):
            raise StartupError(
                "frontend TLS trust or hostname verification failed for the "
                "selected certificate"
            ) from None
        raise StartupError("health endpoint is unreachable") from None
    if len(body) > MAX_HEALTH_BYTES:
        raise StartupError("health response exceeded the size limit")
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise StartupError("health endpoint returned invalid JSON") from None
    if not isinstance(payload, dict):
        raise StartupError("health endpoint returned an invalid payload")
    return payload


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def _readiness_issues(
    frontend_health_url: str,
    referee_health_url: str,
    speech_secret: str,
    frontend_ssl_context: ssl.SSLContext | None = None,
    game_timeout: float = HEALTH_REQUEST_TIMEOUT_SECONDS,
) -> list[str]:
    issues: list[str] = []
    for label, url in (
        ("frontend", frontend_health_url),
        ("referee", referee_health_url),
    ):
        try:
            payload = _request_health(
                url,
                ssl_context=frontend_ssl_context if label == "frontend" else None,
                timeout=game_timeout,
            )
            if not (
                payload.get("version") == 1
                and payload.get("stage") == "game"
                and payload.get("multiplayerReady") is True
            ):
                raise StartupError("health endpoint reported the wrong service")
        except StartupError as error:
            issues.append(f"{label}: {error}")
    try:
        speech = _request_health(
            f"http://127.0.0.1:{SPEECH_PORT}/health",
            {"x-wand-speech-secret": speech_secret},
        )
        if not all(
            speech.get(field) is True
            for field in ("ready", "warm", "workerAvailable")
        ):
            raise StartupError("health endpoint reported speech is not warm and ready")
    except StartupError as error:
        issues.append(f"speech helper: {error}")
    return issues


def _wait_for_readiness(
    processes: list[tuple[str, subprocess.Popen]],
    frontend_health_url: str,
    referee_health_url: str,
    speech_secret: str,
    frontend_ssl_context: ssl.SSLContext | None = None,
    game_timeout: float = HEALTH_REQUEST_TIMEOUT_SECONDS,
    startup_timeout: float = STARTUP_TIMEOUT_SECONDS,
) -> None:
    deadline = time.monotonic() + startup_timeout
    issues = ["startup checks have not completed"]
    while time.monotonic() < deadline:
        for label, process in processes:
            return_code = process.poll()
            if return_code is not None:
                raise StartupError(
                    f"{label} exited before readiness (code {return_code})"
                )
        issues = _readiness_issues(
            frontend_health_url,
            referee_health_url,
            speech_secret,
            frontend_ssl_context,
            game_timeout,
        )
        if not issues:
            for label, process in processes:
                return_code = process.poll()
                if return_code is not None:
                    raise StartupError(
                        f"{label} exited during readiness (code {return_code})"
                    )
            return
        time.sleep(0.25)
    raise StartupError(
        f"readiness timed out after {startup_timeout:.0f}s: "
        + "; ".join(issues)
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phone-host", help="Approved private laptop IP; requires trusted TLS cert/key")
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--referee", help=f"Use another referee instead of {DEFAULT_REFEREE}: laptop A's http://PRIVATE_IP:8000 or an https:// origin")
    parser.add_argument("--local-referee", action="store_true", help="Run the referee on this laptop instead of the deployed one (offline, LAN, scripted QA)")
    parser.add_argument("--referee-bind", help="Explicitly expose only the referee on this private IP; frontend stays localhost")
    parser.add_argument("--serve-referee", action="store_true", help="Explicitly expose referee on --phone-host for a second laptop")
    parser.add_argument("--allow-origin", action="append", default=[], help="Exact second laptop HTTPS origin; no wildcard")
    parser.add_argument("--qa", action="store_true", help="Enable script-only replay harness (not the player UI)")
    parser.add_argument("--badge-only", action="store_true", help="Reject phone/replay input for real-badge qualification")
    parser.add_argument("--speech-model", type=Path, help="Previously downloaded local faster-whisper model directory")
    parser.add_argument("--phone-service", help="Approved public HTTPS phone-only service origin")
    parser.add_argument("--phone-secret-file", type=Path, help="Private enrollment secret outside the repository")
    parser.add_argument("--save-defaults", action="store_true", help="Remember --phone-service/--phone-secret-file for plain runs")
    parser.add_argument("--no-phone", action="store_true", help="Ignore saved phone defaults for this run")
    parser.add_argument("--dev", action="store_true", help="Opt into hot reload; default is a stable build for human QA")
    args = parser.parse_args()
    phone_flags = bool(args.phone_service or args.phone_secret_file)
    if args.save_defaults and not (args.phone_service and args.phone_secret_file) and not args.referee:
        parser.error("--save-defaults needs --phone-service and --phone-secret-file, --referee, or both")
    if args.referee and (args.local_referee or args.referee_bind or args.serve_referee):
        parser.error("Choose exactly one referee mode")
    if not args.no_phone and not phone_flags and not args.badge_only:
        saved = _load_defaults()
        if saved.get("phone_service") and saved.get("phone_secret_file"):
            args.phone_service = saved["phone_service"]
            args.phone_secret_file = Path(saved["phone_secret_file"])
            print(f"Using saved phone defaults from {DEFAULTS_FILE}", flush=True)
    explicit_referee = args.referee
    saved_referee = _load_defaults().get("referee")
    try:
        # Scripted QA replays only through a local referee; LAN modes host one here too.
        args.referee = _resolve_referee(
            explicit=explicit_referee,
            local=bool(args.local_referee or args.referee_bind or args.serve_referee or args.qa),
            saved=saved_referee,
        )
    except ValueError as error:
        parser.error(str(error))
    if args.referee and not explicit_referee:
        source = f"saved in {DEFAULTS_FILE}" if args.referee == saved_referee else "the deployed default"
        print(f"Referee: {args.referee} ({source}; --local-referee runs one on this laptop instead)", flush=True)
    phone_secret = None
    if bool(args.phone_service) != bool(args.phone_secret_file):
        parser.error("Hosted phone needs --phone-service and --phone-secret-file")
    if args.phone_service:
        service = urlsplit(args.phone_service)
        if service.scheme != "https" or not service.hostname or service.username or service.password or service.port or service.path not in ("", "/") or service.query or service.fragment:
            parser.error("Select one public HTTPS phone service origin, without a path or credentials")
        secret_path = args.phone_secret_file.resolve()
        if secret_path.is_relative_to(ROOT) or not secret_path.is_file() or secret_path.stat().st_size > 256:
            parser.error("Keep the enrollment secret in a small private file outside the repository")
        if os.name != "nt" and secret_path.stat().st_mode & 0o077:
            parser.error("Enrollment secret file must be private to your user (mode 0600)")
        phone_secret = secret_path.read_text().strip()
        if len(phone_secret) != 64 or any(c not in "0123456789abcdef" for c in phone_secret):
            parser.error("Enrollment secret must be 32 random bytes encoded as lowercase hex")
        if args.badge_only: parser.error("Badge-only qualification cannot enable hosted phone")
        if args.save_defaults and phone_flags:
            _save_defaults(args.phone_service, args.phone_secret_file)
            print(f"Saved phone defaults to {DEFAULTS_FILE}; plain `python3 tools/run_game.py` now uses them.", flush=True)
    if bool(args.cert) != bool(args.key): parser.error("Both --cert and --key are required")
    if args.phone_host:
        address = ipaddress.ip_address(args.phone_host)
        if not address.is_private or address.is_loopback or address.is_unspecified or address.version != 4: parser.error("Select one private IPv4 interface")
        if not args.cert or not args.key: parser.error("LAN access requires separately approved trusted TLS setup")
    elif args.serve_referee: parser.error("--serve-referee requires --phone-host")
    if args.referee and args.serve_referee: parser.error("Choose host or remote referee, not both")
    if args.referee_bind:
        address = ipaddress.ip_address(args.referee_bind)
        if not address.is_private or address.is_loopback or address.is_unspecified or address.version != 4: parser.error("Select one private IPv4 referee interface")
        if args.referee or args.serve_referee: parser.error("Choose exactly one referee mode")
    for origin in args.allow_origin:
        if not origin.startswith("https://") or "*" in origin or not origin.endswith(":5173"): parser.error("Use exact HTTPS origins on port 5173")
    hosted_referee = bool(args.referee and args.referee.startswith("https://"))
    if args.save_defaults and explicit_referee:
        _save_defaults(None, None, referee=args.referee)
        print(f"Saved referee default {args.referee} to {DEFAULTS_FILE}; `--local-referee` ignores it for one run.", flush=True)
    python = ROOT / "apps/host/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not python.exists() or not npm: parser.error("Install the documented Python 3.11 environment and web dependencies first")
    env = os.environ.copy()
    for name in ("WAND_HOST", "WAND_FRONTEND_HOST", "WAND_REFEREE_URL", "WAND_TLS_CERT", "WAND_TLS_KEY", "WAND_ALLOWED_ORIGINS", "WAND_ALLOW_REPLAY", "WAND_DEV_RELAY", "WAND_ENABLE_EXPELLIARMUS", "WAND_SPELLS", "WAND_SPEECH_SECRET", "WAND_SPEECH_MODEL_DIR", "VITE_WAND_QA", "WAND_PHONE_SERVICE", "WAND_PHONE_CREATE_SECRET", "WAND_QA_PORTS", "WAND_GAME_BUILD_DIR", "WAND_ICE_SERVERS", "WAND_TURN_KEY_ID", "WAND_TURN_API_TOKEN", "PORT"):
        env.pop(name, None)
    env["WAND_SPEECH_SECRET"] = secrets.token_urlsafe(32)
    env["WAND_FRONTEND_HOST"] = args.phone_host or "127.0.0.1"
    env["WAND_ALLOW_REPLAY"] = "true" if args.qa else "false"
    env["WAND_DEV_RELAY"] = "false" if args.badge_only else "true"
    if args.badge_only: env["WAND_ALLOW_REPLAY"] = "false"
    origin = f"{'https' if args.cert else 'http'}://{env['WAND_FRONTEND_HOST']}:5173"
    # Both loopback spellings are the same laptop: a page opened at localhost must pair too.
    loopback = ["http://localhost:5173"] if env["WAND_FRONTEND_HOST"] == "127.0.0.1" and not args.cert else []
    env["WAND_ALLOWED_ORIGINS"] = ",".join([origin, *loopback, *args.allow_origin])
    if args.cert and args.key:
        env["WAND_TLS_CERT"] = str(args.cert.resolve())
        env["WAND_TLS_KEY"] = str(args.key.resolve())
    if args.serve_referee: env["WAND_HOST"] = args.phone_host
    if args.referee_bind:
        env["WAND_HOST"] = args.referee_bind
        env["WAND_REFEREE_URL"] = f"http://{args.referee_bind}:8000"
    if args.referee: env["WAND_REFEREE_URL"] = args.referee
    if args.qa: env["VITE_WAND_QA"] = "1"
    model = (args.speech_model or Path.home()/".cache/wand-speech/faster-whisper-base.en").expanduser().resolve()
    env["WAND_SPEECH_MODEL_DIR"] = str(model)
    try:
        _ensure_speech_model(model, python)
    except StartupError as error:
        print(f"Startup blocked: {error}", file=sys.stderr, flush=True)
        return 1
    local_referee_host = None if args.referee else env.get("WAND_HOST", "127.0.0.1")
    referee_url = (args.referee or f"http://{local_referee_host}:{REFEREE_PORT}").rstrip("/")
    try:
        frontend_ssl_context = (
            _frontend_ssl_context(args.cert.resolve()) if args.cert else None
        )
    except StartupError as error:
        print(f"Startup blocked: {error}", file=sys.stderr, flush=True)
        return 1
    _stop_previous()
    try:
        _preflight_ports(
            _required_listeners(env["WAND_FRONTEND_HOST"], local_referee_host)
        )
    except StartupError as error:
        print(f"Startup blocked: {error}", file=sys.stderr, flush=True)
        return 1
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(f"{os.getpid()}\n")
    except OSError:
        pass
    frontend_env = env.copy()
    if phone_secret:
        frontend_env["WAND_PHONE_SERVICE"] = args.phone_service.rstrip("/")
        frontend_env["WAND_PHONE_CREATE_SECRET"] = phone_secret
    processes: list[tuple[str, subprocess.Popen]] = []
    snapshot = None
    try:
        if not args.dev:
            snapshot = tempfile.TemporaryDirectory(prefix="wandduel-game-")
            frontend_env["WAND_GAME_BUILD_DIR"] = snapshot.name
            result = subprocess.run([npm, "run", "build"], cwd=ROOT/"apps/web", env=frontend_env)
            if result.returncode: return result.returncode
        if not args.referee:
            processes.append(("referee", subprocess.Popen([str(python), "-m", "phantom_host.duel_app"], cwd=ROOT/"apps/host", env=env)))
        processes.append(("speech helper", subprocess.Popen([str(python), "-m", "phantom_host.speech_app"], cwd=ROOT/"apps/host", env=env)))
        processes.append(("frontend", subprocess.Popen([npm, "run", "dev" if args.dev else "preview"], cwd=ROOT/"apps/web", env=frontend_env)))
        referee_health_url = f"{referee_url}/api/game/health"
        if hosted_referee:
            print(f"Waking the hosted referee at {referee_url} (a sleeping free instance takes about a minute) ...", flush=True)
        _wait_for_readiness(
            processes,
            f"{origin}/api/game/health",
            referee_health_url,
            env["WAND_SPEECH_SECRET"],
            frontend_ssl_context,
            HOSTED_HEALTH_REQUEST_TIMEOUT_SECONDS if hosted_referee else HEALTH_REQUEST_TIMEOUT_SECONDS,
            HOSTED_STARTUP_TIMEOUT_SECONDS if hosted_referee else STARTUP_TIMEOUT_SECONDS,
        )
        print(f"Game ready: {origin}", flush=True)
        if hosted_referee: print(f"Hosted referee: {referee_url} (kept awake while this stack runs).", flush=True)
        print("Hot reload enabled." if args.dev else "Stable QA build; source edits and automated tests do not replace this session.", flush=True)
        print("Ctrl+C stops this stack. No device or certificate settings were changed.", flush=True)
        next_keepalive = time.monotonic() + HOSTED_KEEPALIVE_SECONDS
        while all(process.poll() is None for _, process in processes):
            time.sleep(0.25)
            if hosted_referee and time.monotonic() >= next_keepalive:
                # Traffic keeps a free-tier instance awake; a miss only means the next connect waits.
                try: _request_health(referee_health_url, timeout=HOSTED_HEALTH_REQUEST_TIMEOUT_SECONDS)
                except StartupError: pass
                next_keepalive = time.monotonic() + HOSTED_KEEPALIVE_SECONDS
        return 1
    except KeyboardInterrupt:
        return 0
    except StartupError as error:
        print(f"Startup failed: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        for _, process in reversed(processes):
            if process.poll() is None: process.terminate()
        for _, process in processes:
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
        if snapshot: snapshot.cleanup()
        try:
            if PID_FILE.read_text().strip() == str(os.getpid()): PID_FILE.unlink()
        except (FileNotFoundError, OSError, ValueError):
            pass

if __name__ == "__main__":
    sys.exit(main())
