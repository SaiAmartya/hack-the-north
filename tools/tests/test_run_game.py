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
