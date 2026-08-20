"""Deterministic real child-process fixture for the native desktop adapter."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

save_path = Path(os.environ['PLAYPROOF_SAVE_PATH'])
event_path = Path(os.environ['PLAYPROOF_EVENT_PATH'])
state = {
    'steps': 0,
    'score': 0,
    'finished': False,
    'seed': int(os.environ.get('PLAYPROOF_SEED', '0')),
}


def persist() -> None:
    save_path.parent.mkdir(parents=True, exist_ok=True)
    save_path.write_text(json.dumps(state, sort_keys=True))
    print(
        f"FRAME steps={state['steps']} score={state['score']} "
        f"finished={1 if state['finished'] else 0}",
        flush=True,
    )


persist()
print('READY', flush=True)
for raw in sys.stdin:
    command = raw.strip()
    if command == 'step':
        state['steps'] += 1
        state['score'] += 1
    elif command == 'bonus':
        state['steps'] += 1
        state['score'] += 5
    elif command == 'finish':
        state['steps'] += 1
        state['finished'] = True
        event_path.parent.mkdir(parents=True, exist_ok=True)
        with event_path.open('a') as file:
            file.write('finished\n')
    elif command == 'quit':
        break
    persist()
