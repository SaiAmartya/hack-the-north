from fastapi.testclient import TestClient

from phantom_host.narrator import Narrator
from phantom_host.server import create_app


def test_health_state_and_websocket_stream():
    app = create_app(source=None, ai=False, narrator=Narrator(client=None, min_interval=0))
    with TestClient(app) as client:
        h = client.get("/health").json()
        assert h["ok"] and h["gateway_connected"] is False and h["badges"] == 0
        with client.websocket_connect("/ws") as ws:
            first = ws.receive_json()
            assert first["type"] == "state" and first["players"] == []
            r = client.post("/api/line", json={"line": "PARX|AA:BB:CC:DD:00:01|-50|PAH00011MD1Ada"})
            assert r.json()["events"][0]["kind"] == "join"
            msg = ws.receive_json()
            assert msg["type"] == "event" and "Ada joined" in msg["event"]["text"]
        st = client.get("/api/state").json()
        assert st["players"][0]["name"] == "Ada" and st["gateway_connected"] is True
        assert client.get("/").status_code == 200


def test_hooks_receive_decrees():
    seen = []
    app = create_app(source=None, ai=False)
    app.state.hub.hooks.append(lambda ev: seen.append(ev["kind"]))
    with TestClient(app) as client:
        client.post("/api/line", json={"line": "PARX|AA:BB:CC:DD:00:01|-50|PAH00011MD1Ada"})
        client.post("/api/line", json={"line": "PARX|AA:BB:CC:DD:00:01|-50|PAED040001001502d"})
    assert seen == ["join", "decree"]
