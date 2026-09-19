#!/usr/bin/env python3
"""Explicitly provision the pinned local speech model outside the repository."""

from __future__ import annotations

import argparse
import json
import os
from importlib import metadata
from pathlib import Path

FASTER_WHISPER_VERSION = "1.2.1"
MODEL_NAME = "base.en"
MODEL_REPOSITORY = "Systran/faster-whisper-base.en"
MODEL_REVISION = "3d3d5dee26484f91867d81cb899cfcf72b96be6c"
MODEL_METADATA = ".wand-speech-model.json"
REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download the pinned faster-whisper base.en files for an explicitly "
            "approved local setup. This script does not install Python packages."
        )
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        required=True,
        help="Destination outside this repository for the pinned model files",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    target = args.model_dir.expanduser().resolve()
    repository = Path(__file__).resolve().parents[1]
    if target.is_relative_to(repository):
        raise SystemExit("Choose a model directory outside the repository")

    try:
        installed = metadata.version("faster-whisper")
    except metadata.PackageNotFoundError:
        raise SystemExit(
            f"Install faster-whisper=={FASTER_WHISPER_VERSION} in the helper's "
            "isolated Python environment, then rerun this explicit setup"
        ) from None
    if installed != FASTER_WHISPER_VERSION:
        raise SystemExit(
            f"Expected faster-whisper=={FASTER_WHISPER_VERSION}; found {installed}"
        )

    from faster_whisper.utils import download_model

    target.mkdir(parents=True, exist_ok=True)
    download_model(
        MODEL_NAME,
        output_dir=str(target),
        revision=MODEL_REVISION,
        local_files_only=False,
    )
    missing = [name for name in REQUIRED_FILES if not (target / name).is_file()]
    if missing:
        raise SystemExit(f"Model download is incomplete: {', '.join(missing)}")

    model_metadata = {
        "model": MODEL_NAME,
        "repository": MODEL_REPOSITORY,
        "revision": MODEL_REVISION,
        "fasterWhisperVersion": FASTER_WHISPER_VERSION,
    }
    temporary = target / f"{MODEL_METADATA}.tmp"
    temporary.write_text(
        json.dumps(model_metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, target / MODEL_METADATA)
    print(f"Pinned local speech model is ready at {target}")
    print("Set WAND_SPEECH_MODEL_DIR to this path when launching the helper.")
    print("Create a fresh WAND_SPEECH_SECRET for each launch; do not save or print it.")


if __name__ == "__main__":
    main()
