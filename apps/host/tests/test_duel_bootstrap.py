import os
import subprocess
import sys

from fastapi.testclient import TestClient

from phantom_host.duel_app import create_app


def test_new_entrypoint_never_imports_legacy_workers():
    code = """
import sys
from phantom_host.duel_app import create_app
create_app()
assert not any(name in sys.modules for name in (
    'phantom_host.main', 'phantom_host.serial_gateway', 'phantom_host.vision',
    'phantom_host.arena_director', 'openai', 'cv2', 'serial'
))
"""
    env = {key: value for key, value in os.environ.items() if not key.startswith("OPENAI")}
    subprocess.run([sys.executable, "-c", code], env=env, check=True, timeout=10)


def test_bootstrap_exposes_isolated_game_authority_and_no_legacy_reset():
    with TestClient(create_app()) as client:
        assert client.get("/api/game/health").json() == {
            "version": 1,
            "stage": "game",
            "multiplayerReady": True,
            "devRelayEnabled": False,
            "allowReplay": False,
        }
        assert client.post("/match/reset").status_code == 404
        rules = client.get("/api/game/rules").json()
        assert (rules["roundMs"], rules["maxHp"], rules["offensiveRecoveryMs"]) == (60000, 100, 600)
        assert [spell["spell"] for spell in rules["spells"] if spell["enabled"]] == ["stupefy", "protego"]
