from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


MODULE_PATH = Path(__file__).resolve().parents[1] / "run_game.py"
SPEC = importlib.util.spec_from_file_location("run_game", MODULE_PATH)
assert SPEC and SPEC.loader
run_game = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(run_game)


@pytest.fixture(autouse=True)
def isolated_launcher_state(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Never read this machine's saved phone defaults or a live stack's pid file."""
    monkeypatch.setattr(run_game, "STATE_DIR", tmp_path)
    monkeypatch.setattr(run_game, "DEFAULTS_FILE", tmp_path / "launcher.json")
    monkeypatch.setattr(run_game, "PID_FILE", tmp_path / "launcher.pid")


def test_required_listeners_use_the_actual_selected_hosts() -> None:
    assert run_game._required_listeners("127.0.0.1", "127.0.0.1") == [
        ("frontend", "127.0.0.1", 5173),
        ("speech helper", "127.0.0.1", 8001),
        ("referee", "127.0.0.1", 8000),
    ]
    assert run_game._required_listeners("10.0.0.4", "10.0.0.4")[-1] == (
        "referee",
        "10.0.0.4",
        8000,
    )
    assert run_game._required_listeners("127.0.0.1", None) == [
        ("frontend", "127.0.0.1", 5173),
        ("speech helper", "127.0.0.1", 8001),
    ]


def test_occupied_port_fails_with_the_named_listener(monkeypatch: pytest.MonkeyPatch) -> None:
    class OccupiedSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def bind(self, _address):
            raise OSError("occupied")

        def setsockopt(self, *_args):
            pass

        def listen(self, _backlog):
            pytest.fail("an occupied socket must not reach listen")

    monkeypatch.setattr(run_game.socket, "socket", lambda *_args: OccupiedSocket())
    with pytest.raises(run_game.StartupError, match="frontend.*127.0.0.1:5173"):
        run_game._preflight_ports([("frontend", "127.0.0.1", 5173)])


def test_port_probe_reuses_closed_posix_address_and_listens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = []

    class AvailableSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def setsockopt(self, *args):
            calls.append(("setsockopt", *args))

        def bind(self, address):
            calls.append(("bind", address))

        def listen(self, backlog):
            calls.append(("listen", backlog))

    monkeypatch.setattr(run_game.socket, "socket", lambda *_args: AvailableSocket())
    monkeypatch.setattr(run_game.os, "name", "posix")
    run_game._preflight_ports([("frontend", "127.0.0.1", 5173)])
    assert ("setsockopt", run_game.socket.SOL_SOCKET, run_game.socket.SO_REUSEADDR, 1) in calls
    assert ("bind", ("127.0.0.1", 5173)) in calls
    assert ("listen", 1) in calls


def test_readiness_requires_game_contract_and_authenticated_warm_speech(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "not-printed"
    requests = []
    handlers = []

    class Response:
        status = 200

        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return json.dumps(self.payload).encode()

    class Opener:
        def open(self, request, **_kwargs):
            requests.append(request)
            if request.full_url.endswith(":8001/health"):
                return Response({"ready": True, "warm": True, "workerAvailable": True})
            return Response({"version": 1, "stage": "game", "multiplayerReady": True})

    def make_opener(*values):
        handlers.extend(values)
        return Opener()

    monkeypatch.setattr(run_game, "build_opener", make_opener)
    assert run_game._readiness_issues(
        "http://127.0.0.1:5173/api/game/health",
        "http://127.0.0.1:8000/api/game/health",
        secret,
    ) == []
    speech_request = requests[-1]
    assert speech_request.get_header("X-wand-speech-secret") == secret
    assert secret not in speech_request.full_url
    assert any(
        isinstance(handler, run_game.ProxyHandler) and handler.proxies == {}
        for handler in handlers
    )
    assert any(isinstance(handler, run_game._NoRedirects) for handler in handlers)


def test_health_failure_never_exposes_header_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "per-launch-secret"

    class BrokenOpener:
        def open(self, *_args, **_kwargs):
            raise RuntimeError(secret)

    monkeypatch.setattr(run_game, "build_opener", lambda *_args: BrokenOpener())
    with pytest.raises(run_game.StartupError) as caught:
        run_game._request_health(
            "http://127.0.0.1:8001/health",
            {"x-wand-speech-secret": secret},
        )
    assert secret not in str(caught.value)


def test_dead_child_aborts_readiness_before_health_requests(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        run_game,
        "_readiness_issues",
        lambda *_args: pytest.fail("health must not be probed after a child exits"),
    )
    process = SimpleNamespace(poll=lambda: 7)
    with pytest.raises(run_game.StartupError, match="speech helper.*code 7"):
        run_game._wait_for_readiness(
            [("speech helper", process)],
            "http://frontend/health",
            "http://referee/health",
            "secret",
        )


def test_child_death_during_health_never_reports_ready(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    polls = iter((None, 9))
    process = SimpleNamespace(poll=lambda: next(polls))
    monkeypatch.setattr(run_game, "_readiness_issues", lambda *_args: [])
    with pytest.raises(run_game.StartupError, match="frontend.*during readiness.*code 9"):
        run_game._wait_for_readiness(
            [("frontend", process)],
            "http://frontend/health",
            "http://referee/health",
            "secret",
        )


def test_preflight_failure_starts_no_build_or_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    python = tmp_path / "apps/host/.venv/bin/python"
    python.parent.mkdir(parents=True)
    python.touch()
    monkeypatch.setattr(run_game, "ROOT", tmp_path)
    monkeypatch.setattr(run_game.shutil, "which", lambda _name: "/fake/npm")
    monkeypatch.setattr(run_game.sys, "argv", ["run_game.py"])
    monkeypatch.setattr(
        run_game,
        "_preflight_ports",
        lambda _listeners: (_ for _ in ()).throw(run_game.StartupError("frontend occupied")),
    )
    monkeypatch.setattr(
        run_game.subprocess,
        "run",
        lambda *_args, **_kwargs: pytest.fail("build must not start"),
    )
    monkeypatch.setattr(
        run_game.subprocess,
        "Popen",
        lambda *_args, **_kwargs: pytest.fail("process must not start"),
    )

    assert run_game.main() == 1
    assert "Startup blocked: frontend occupied" in capsys.readouterr().err


def test_readiness_failure_never_prints_game_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    python = tmp_path / "apps/host/.venv/bin/python"
    python.parent.mkdir(parents=True)
    python.touch()
    monkeypatch.setattr(run_game, "ROOT", tmp_path)
    monkeypatch.setattr(run_game.shutil, "which", lambda _name: "/fake/npm")
    monkeypatch.setattr(run_game.sys, "argv", ["run_game.py", "--dev"])
    monkeypatch.setattr(run_game, "_preflight_ports", lambda _listeners: None)
    monkeypatch.setattr(
        run_game,
        "_wait_for_readiness",
        lambda *_args: (_ for _ in ()).throw(run_game.StartupError("speech cold")),
    )

    class Process:
        stopped = False

        def poll(self):
            return 0 if self.stopped else None

        def terminate(self):
            self.stopped = True

        def wait(self, **_kwargs):
            return 0

    monkeypatch.setattr(run_game.subprocess, "Popen", lambda *_args, **_kwargs: Process())

    assert run_game.main() == 1
    output = capsys.readouterr()
    assert "Game ready:" not in output.out
    assert "Startup failed: speech cold" in output.err


def test_saved_defaults_only_carry_the_phone_fields(tmp_path: Path) -> None:
    path = tmp_path / "launcher.json"
    assert run_game._load_defaults(path) == {}
    path.write_text('{"phone_service": "https://wands.example", "phone_secret_file": "/tmp/x", "extra": "no", "phone_secret": "never"}')
    assert run_game._load_defaults(path) == {"phone_service": "https://wands.example", "phone_secret_file": "/tmp/x"}
    path.write_text("not json")
    assert run_game._load_defaults(path) == {}
    run_game._save_defaults("https://wands.example", tmp_path / "secret", path)
    saved = json.loads(path.read_text())
    assert saved == {"phone_service": "https://wands.example", "phone_secret_file": str((tmp_path / "secret").resolve())}
    assert "secret" not in saved["phone_service"]


def test_referee_origin_accepts_private_http_and_public_https_only() -> None:
    assert run_game._referee_origin("http://192.168.1.20:8000") == "http://192.168.1.20:8000"
    assert run_game._referee_origin("http://10.0.0.4:8000/") == "http://10.0.0.4:8000"
    assert run_game._referee_origin("https://wandduel-referee.onrender.com/") == "https://wandduel-referee.onrender.com"
    assert run_game._referee_origin(" https://quick.trycloudflare.com ") == "https://quick.trycloudflare.com"
    for rejected in (
        "http://8.8.8.8:8000",
        "http://192.168.1.20:8001",
        "http://192.168.1.20",
        "http://0.0.0.0:8000",
        "https://user:pw@host.example",
        "https://host.example/api",
        "https://host.example/?x=1",
        "ws://host.example",
        "host.example",
    ):
        with pytest.raises(ValueError):
            run_game._referee_origin(rejected)


def test_saved_defaults_merge_the_hosted_referee_with_phone_fields(tmp_path: Path) -> None:
    path = tmp_path / "launcher.json"
    run_game._save_defaults(None, None, path, referee="https://referee.example")
    assert run_game._load_defaults(path) == {"referee": "https://referee.example"}
    run_game._save_defaults("https://wands.example", tmp_path / "secret", path)
    assert run_game._load_defaults(path) == {
        "phone_service": "https://wands.example",
        "phone_secret_file": str((tmp_path / "secret").resolve()),
        "referee": "https://referee.example",
    }
    run_game._save_defaults(None, None, path, referee="https://other.example")
    assert run_game._load_defaults(path)["referee"] == "https://other.example"
    assert run_game._load_defaults(path)["phone_service"] == "https://wands.example"


def test_previous_stack_is_only_stopped_when_the_pid_is_this_launcher(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    pidfile = tmp_path / "launcher.pid"
    assert run_game._stop_previous(pidfile) is False
    pidfile.write_text("4242\n")
    killed: list[tuple[int, int]] = []
    monkeypatch.setattr(run_game.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    monkeypatch.setattr(run_game.os, "name", "posix")
    # A recycled PID belonging to something else is left alone and the stale file is removed.
    monkeypatch.setattr(run_game.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="/usr/bin/vim notes.txt\n"))
    assert run_game._stop_previous(pidfile) is False
    assert killed == [(4242, 0)] and not pidfile.exists()
    # A live launcher is interrupted and waited for.
    pidfile.write_text("4243\n")
    alive = {"value": True}
    def fake_kill(pid, sig):
        killed.append((pid, sig))
        if sig != 0:
            alive["value"] = False
        elif not alive["value"]:
            raise OSError("gone")
    monkeypatch.setattr(run_game.os, "kill", fake_kill)
    monkeypatch.setattr(run_game.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="python3 tools/run_game.py\n"))
    assert run_game._stop_previous(pidfile, wait_seconds=1.0) is True
    assert (4243, run_game.signal.SIGINT) in killed if hasattr(run_game, "signal") else True
    assert not pidfile.exists()


def test_missing_speech_model_is_provisioned_once_and_verified(tmp_path: Path) -> None:
    model = tmp_path / "model"
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append([str(part) for part in command])
        model.mkdir(parents=True, exist_ok=True)
        for name in run_game.SPEECH_MODEL_FILES:
            (model / name).write_text("x")
        return SimpleNamespace(returncode=0)

    run_game._ensure_speech_model(model, Path("/venv/bin/python"), run=fake_run)
    assert calls == [["/venv/bin/python", str(run_game.ROOT / "tools" / "setup_speech.py"), "--model-dir", str(model)]]
    run_game._ensure_speech_model(model, Path("/venv/bin/python"), run=fake_run)
    assert len(calls) == 1  # already complete: no second download


def test_failed_speech_model_download_blocks_startup(tmp_path: Path) -> None:
    model = tmp_path / "model"
    with pytest.raises(run_game.StartupError, match="speech model"):
        run_game._ensure_speech_model(model, Path("/venv/bin/python"), run=lambda *a, **k: SimpleNamespace(returncode=1))
    with pytest.raises(run_game.StartupError, match="speech model"):
        run_game._ensure_speech_model(model, Path("/venv/bin/python"), run=lambda *a, **k: SimpleNamespace(returncode=0))
