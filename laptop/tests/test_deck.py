import json
from types import SimpleNamespace

import pytest

from phantom_host.deck import Card, CardError, default_deck, generate, parse, serialize, validate


def fake_client(content: str):
    def create(**kw):
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def test_validate_clamps_and_cleans():
    c = validate(dict(trig="LOW", type="dmg", val=99, dur=999, title="Über|Frenzy that is far too long for the badge", text="Hits x2 | ok — really"))
    assert (c.trig, c.type, c.val, c.dur) == ("low", "dmg", 30, 30)
    assert c.title == "ber-Frenzy that is far t" and len(c.title) <= 24
    assert "|" not in c.text and len(c.text) <= 44


@pytest.mark.parametrize("raw", [
    dict(trig="never", type="dmg", val=20, dur=10, title="x", text="y"),
    dict(trig="low", type="lava", val=20, dur=10, title="x", text="y"),
    dict(trig="low", type="dmg", val="lots", dur=10, title="x", text="y"),
    dict(trig="low", type="dmg", val=20, dur=10, title="", text="y"),
])
def test_validate_rejects_unknown_mechanics(raw):
    with pytest.raises(CardError):
        validate(raw)


def test_serialize_parse_roundtrip_matches_badge_format():
    deck = default_deck()
    text = serialize(deck)
    assert text.splitlines()[0] == "low|heal|30|0|Mercy of the Veil|The Phantom pities the weak: all heal 30%."
    assert parse(text) == deck
    assert all(len(line.encode("ascii")) < 120 for line in text.splitlines())


def test_generate_uses_model_cards_and_drops_bad_ones():
    content = json.dumps({"cards": [
        dict(trig="low", type="heal", val=25, dur=0, title="Model Mercy", text="A model-written card."),
        dict(trig="timer", type="explode", val=1, dur=1, title="Nope", text="invalid mechanic"),
        dict(trig="stale", type="fog", val=0, dur=10, title="Model Fog", text="fog"),
    ]})
    cards = generate("test", n=3, client=fake_client(content))
    titles = [c.title for c in cards]
    assert "Model Mercy" in titles and "Model Fog" in titles and "Nope" not in titles
    assert any(c.trig == "timer" for c in cards) and any(c.trig == "boss" for c in cards)  # backfilled from defaults


def test_generate_falls_back_on_invalid_json_and_missing_key(monkeypatch):
    assert generate("x", client=fake_client("not json")) == default_deck()
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert generate("x") == default_deck()


def test_cli_writes_offline_deck(tmp_path):
    from phantom_host.deck import main
    out = tmp_path / "deck.txt"
    assert main(["--offline", "--out", str(out)]) == 0
    assert parse(out.read_text()) == default_deck()
