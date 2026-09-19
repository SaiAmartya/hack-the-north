from types import SimpleNamespace

from phantom_host.narrator import ElevenLabsVoice, Narrator


def test_templates_without_a_model():
    n = Narrator(client=None, enabled=True, min_interval=0)
    line = n.commentate([{"kind": "hit", "text": "Bob LIGHTNING Ada -18", "v": 18}], {}, now=10)
    assert "Bob" in line and "Ada" in line
    line = n.commentate([{"kind": "over", "text": "MATCH OVER", "winner": "Ada"}], {}, now=20)
    assert "Ada" in line
    assert n.commentate([{"kind": "phase", "text": "lobby"}], {}, now=30) is None  # nothing worth saying


def test_rate_limit():
    n = Narrator(client=None, enabled=True, min_interval=7)
    assert n.ready(now=100)
    n.commentate([{"kind": "start", "text": "go"}], {}, now=100)
    assert not n.ready(now=103) and n.ready(now=107.5)


def test_model_text_is_used_and_failures_fall_back():
    calls = {}

    def create(**kw):
        calls["messages"] = kw["messages"]
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="  Bob melts Ada with a fireball!  "))])
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    n = Narrator(client=client, min_interval=0)
    assert n.commentate([{"kind": "hit", "text": "Bob FIREBALL Ada -34", "v": 34}], {"phase": "fight"}, now=1) == "Bob melts Ada with a fireball!"
    assert "Bob FIREBALL Ada -34" in calls["messages"][1]["content"]

    def boom(**kw):
        raise RuntimeError("network down")
    client.chat.completions.create = boom
    line = n.commentate([{"kind": "kill", "text": "Bob FIREBALL KO Ada!"}], {}, now=2)
    assert "Bob" in line


def test_voice_is_silent_without_key(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    v = ElevenLabsVoice(api_key=None)
    assert not v.available and v.speak("hello") is None
