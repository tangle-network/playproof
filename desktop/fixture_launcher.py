"""Launcher fixture whose child must be killed with the owned process group."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
pid_path = Path(os.environ['PLAYPROOF_CHILD_PID_PATH'])
pid_path.parent.mkdir(parents=True, exist_ok=True)
pid_path.write_text(str(child.pid))
print('READY', flush=True)
try:
    time.sleep(60)
finally:
    if child.poll() is None:
        child.terminate()
