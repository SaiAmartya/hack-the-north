"""Repeatable software QA. No Bluetooth, microphone, flashing, or LAN changes."""
from pathlib import Path
import os
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
python = ROOT / "apps/host/.venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
if not python.exists() or not npm:
    sys.exit("Set up the documented Python environment and Node dependencies first.")

checks = [
    (ROOT/"apps/host", [str(python), "-m", "pytest", "-q"]),
    (ROOT, [str(python), "-m", "pytest", "-q", "tools/tests"]),
    (ROOT/"apps/web", [npm, "run", "typecheck"]),
    (ROOT/"apps/web", [npm, "test"]),
    (ROOT/"apps/web", [npm, "run", "build"]),
    (ROOT/"apps/web", [npm, "run", "test:e2e"]),
]
for cwd, command in checks:
    print(f"QA: {cwd.relative_to(ROOT)} — {' '.join(command[1:])}", flush=True)
    result = subprocess.run(command, cwd=cwd)
    if result.returncode:
        sys.exit(result.returncode)
print("Software QA passed. Physical badge, speech, camera and Windows gates remain separate.")
