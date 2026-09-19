"""phantom-host: the laptop side of Phantom Arena.

    phantom-host --port auto          # base-station badge on USB, arena at http://127.0.0.1:8000
    phantom-host --sim                # no hardware: runs the real badge Lua in the simulator
    phantom-host --replay logs/x.txt  # replay a saved serial log
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="phantom-host", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", default="auto", help="serial port of the pa_base badge (default: auto-detect Espressif)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--sim", action="store_true", help="run the badge app in the simulator instead of reading serial")
    ap.add_argument("--sim-players", type=int, default=3)
    ap.add_argument("--sim-raid", action="store_true", help="simulator: one bot becomes the Phantom and a raid starts")
    ap.add_argument("--replay", help="replay a saved serial log file (PARX lines)")
    ap.add_argument("--deck", default=str(ROOT / "badge" / "phantom_arena" / "deck.txt"), help="deck.txt installed on the badges")
    ap.add_argument("--no-ai", action="store_true", help="disable the OpenAI commentator and ElevenLabs voice")
    ap.add_argument("--altar-port", help="serial port of the Oracle Altar Arduino (optional)")
    ap.add_argument("--http-host", default="127.0.0.1")
    ap.add_argument("--http-port", type=int, default=8000)
    ap.add_argument("--log", help="append every serial line to this file (for replays and Devpost stats)")
    a = ap.parse_args(argv)

    try:
        from dotenv import load_dotenv
        load_dotenv(ROOT / "laptop" / ".env")
    except Exception:
        pass

    from .server import create_app
    from .sources import ReplaySource, SerialSource, SimSource

    if a.sim:
        source = SimSource(ROOT / "badge" / "phantom_arena", players=a.sim_players, raid=a.sim_raid)
    elif a.replay:
        source = ReplaySource(a.replay)
    else:
        source = SerialSource(a.port, a.baud)

    if a.log:
        logf = open(a.log, "a", encoding="utf-8")
        orig_start = source.start

        def start_logged(on_line):
            def wrapped(line: str) -> None:
                logf.write(line + "\n")
                logf.flush()
                on_line(line)
            orig_start(wrapped)
        source.start = start_logged  # type: ignore[assignment]

    app = create_app(source, deck_path=a.deck, ai=not a.no_ai)
    if a.altar_port:
        from .altar import AltarBridge
        altar = AltarBridge(a.altar_port)
        try:
            altar.open()
            app.state.hub.hooks.append(altar.hook)
            print(f"[altar] connected on {a.altar_port}", file=sys.stderr)
        except Exception as e:
            print(f"[altar] not connected: {e}", file=sys.stderr)

    ai = "on" if (not a.no_ai and os.environ.get("OPENAI_API_KEY")) else "templates"
    voice = "ElevenLabs" if (not a.no_ai and os.environ.get("ELEVENLABS_API_KEY")) else "browser speech"
    print(f"Phantom Arena at http://{a.http_host}:{a.http_port}   source={type(source).__name__}   commentary={ai}   voice={voice}")
    import uvicorn
    uvicorn.run(app, host=a.http_host, port=a.http_port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
