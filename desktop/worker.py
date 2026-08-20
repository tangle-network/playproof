"""Generic native desktop worker for Playproof.

The worker intentionally does not implement DLL injection, process patching,
anti-cheat bypasses, or shell commands. A game integration declares a launch or
attach rule plus authorized helper executables for input/capture/read-only
state. Save files, event logs, frame text, and helper JSON are normalized into
the existing WorkerEvidence shape.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO, TextIO

DEFAULT_FILE_LIMIT = 4 << 20
DEFAULT_STDERR_LIMIT = 64 << 10


class DesktopWorker:
    def __init__(self) -> None:
        self.raw_spec: dict[str, Any] | None = None
        self.spec: dict[str, Any] | None = None
        self.seed = 0
        self.gen = 0
        self.frame = 0
        self.run_dir: str | None = None
        self.launcher: subprocess.Popen[str] | None = None
        self.process_group_id: int | None = None
        self.target_pid: int | None = None
        self.stdout_lines: list[str] = []
        self.stderr_lines: list[str] = []
        self.stdout_revision = 0
        self.output_lock = threading.Lock()
        self.events: list[str] = []

    def boot(self, spec: dict[str, Any], seed: int) -> dict[str, int]:
        self._stop_game()
        self.raw_spec = copy.deepcopy(spec)
        self.seed = int(seed)
        self.gen += 1
        self.frame = 0
        self.events = []
        self.stdout_lines = []
        self.stderr_lines = []
        self.stdout_revision = 0
        self.run_dir = tempfile.mkdtemp(prefix='playproof-desktop-run-')
        resolved = self._expand(copy.deepcopy(spec))
        self.spec = resolved
        launch = resolved.get('launch')
        if launch:
            command = self._command(launch)
            env = os.environ.copy()
            env.update({str(k): str(v) for k, v in launch.get('env', {}).items()})
            env['PLAYPROOF_RUN_DIR'] = self.run_dir
            env['PLAYPROOF_SEED'] = str(self.seed)
            input_kind = resolved.get('input', {}).get('kind')
            self.launcher = subprocess.Popen(
                command,
                cwd=launch.get('cwd') or None,
                env=env,
                stdin=subprocess.PIPE if input_kind == 'stdin-line' else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                start_new_session=(os.name == 'posix'),
            )
            self.process_group_id = self.launcher.pid if os.name == 'posix' else None
            self._start_reader(self.launcher.stdout, self.stdout_lines, stdout=True)
            self._start_reader(self.launcher.stderr, self.stderr_lines, stdout=False)
        selector = resolved.get('process') or {'kind': 'spawned'}
        self.target_pid = self._resolve_pid(selector)
        self._wait_ready(resolved.get('ready') or {})
        return {'gen': self.gen, 'frame': self.frame}

    def reset(self) -> dict[str, int]:
        if self.raw_spec is None:
            raise RuntimeError('desktop worker is not booted')
        return self.boot(copy.deepcopy(self.raw_spec), self.seed)

    def step_once(self, word: str) -> dict[str, Any]:
        spec = self._required_spec()
        if not isinstance(word, str):
            raise ValueError('input must be a string')
        # Unknown values are no-ops. Control characters are swallowed as no-ops
        # so one signed turn cannot smuggle several line-oriented commands.
        allowed = spec.get('allowedInputs')
        if any(char in word for char in ('\n', '\r', '\0')) or (allowed is not None and word not in allowed):
            return self._current_result()

        input_spec = spec['input']
        revision = self._output_revision()
        if input_spec['kind'] == 'stdin-line':
            if self.launcher is None or self.launcher.stdin is None:
                raise RuntimeError('stdin input requires an owned launched process')
            suffix = str(input_spec.get('suffix', '\n'))
            if suffix not in ('', '\n', '\r\n'):
                raise ValueError('stdin-line suffix must be empty, LF, or CRLF')
            self.launcher.stdin.write(word + suffix)
            self.launcher.stdin.flush()
        elif input_spec['kind'] == 'helper':
            self._run_helper(input_spec['bridge'], {'method': 'input', 'input': word})
        else:
            raise ValueError(f"unknown input kind {input_spec.get('kind')}")
        self._wait_for_observation(revision)
        return self._finish_step()

    def _current_result(self) -> dict[str, Any]:
        frame_text = self.frame_text()
        return {'frame': self.frame, 'frameText': frame_text, 'evidence': self.evidence(frame_text)}

    def _finish_step(self) -> dict[str, Any]:
        self.frame += 1
        frame_text = self.frame_text()
        evidence = self.evidence(frame_text)
        return {'frame': self.frame, 'frameText': frame_text, 'evidence': evidence}

    def frame_text(self) -> str:
        spec = self._required_spec()
        observation = spec['observation']
        if observation['kind'] == 'stdout':
            with self.output_lock:
                text = ''.join(self.stdout_lines)
            max_chars = max(int(observation.get('maxChars', 200_000)), 0)
            return text[-max_chars:] if max_chars else ''
        if observation['kind'] == 'helper':
            result = self._run_helper(observation['bridge'], {'method': 'frame'})
            if isinstance(result, dict) and isinstance(result.get('frameText'), str):
                return result['frameText']
            if isinstance(result, str):
                return result
            raise RuntimeError('observation helper must return a string or {frameText}')
        raise ValueError(f"unknown observation kind {observation.get('kind')}")

    def evidence(self, frame_text: str | None = None) -> dict[str, Any]:
        spec = self._required_spec()
        frame_text = self.frame_text() if frame_text is None else frame_text
        evidence_spec = spec.get('evidence') or {}
        engine_state: dict[str, float] = {
            'processAlive': 1 if self._alive(self.target_pid) else 0,
            'step': self.frame,
            'pid': int(self.target_pid or 0),
        }
        save_state: dict[str, float] = {}
        save_hasher = hashlib.sha256()
        save_count = 0
        for probe in evidence_spec.get('saveFiles', []):
            path = Path(probe['path'])
            if not path.exists():
                continue
            data = self._read_bytes_bounded(path, int(probe.get('maxBytes', DEFAULT_FILE_LIMIT)))
            probe_id = str(probe['id']).encode()
            save_hasher.update(len(probe_id).to_bytes(4, 'big'))
            save_hasher.update(probe_id)
            save_hasher.update(len(data).to_bytes(8, 'big'))
            save_hasher.update(data)
            save_count += 1
            if probe['format'] == 'json':
                parsed = json.loads(data.decode('utf-8'))
                self._flatten_numbers(parsed, probe['id'], save_state)
        for probe in evidence_spec.get('eventFiles', []):
            path = Path(probe['path'])
            if not path.exists():
                continue
            data = self._read_bytes_bounded(path, int(probe.get('maxBytes', DEFAULT_FILE_LIMIT)))
            for line in data.decode('utf-8', errors='replace').splitlines():
                event = f"{probe['id']}:{line}" if probe['id'] else line
                if event not in self.events:
                    self.events.append(event)
        frame_state: dict[str, float] = {}
        for key, pattern in (evidence_spec.get('framePatterns') or {}).items():
            matches = list(re.finditer(pattern, frame_text, re.MULTILINE))
            if matches:
                frame_state[key] = float(matches[-1].group(1))
        helper_spec = evidence_spec.get('helper')
        if helper_spec:
            raw = self._run_helper(helper_spec, {'method': 'evidence'})
            if not isinstance(raw, dict):
                raise RuntimeError('evidence helper must return an object')
            engine_state.update(self._numeric_map(raw.get('engineState')))
            save_state.update(self._numeric_map(raw.get('saveState')))
            frame_state.update(self._numeric_map(raw.get('frameState')))
            for event in raw.get('logEvents') or []:
                if isinstance(event, str) and event not in self.events:
                    self.events.append(event)
        if evidence_spec.get('promoteSaveToEngine'):
            engine_state.update(save_state)
        result: dict[str, Any] = {
            'engineState': engine_state,
            'logEvents': list(self.events),
            'frameHash': hashlib.sha256(frame_text.encode()).hexdigest(),
            'frameState': frame_state,
        }
        if save_count:
            result['saveBlobHash'] = save_hasher.hexdigest()
            result['saveState'] = save_state
        return result

    def shutdown(self) -> None:
        self._stop_game()

    def _required_spec(self) -> dict[str, Any]:
        if self.spec is None:
            raise RuntimeError('desktop worker is not booted')
        return self.spec

    def _resolve_pid(self, selector: dict[str, Any]) -> int:
        kind = selector.get('kind', 'spawned')
        timeout = float(selector.get('timeoutMs', 15_000)) / 1000.0
        deadline = time.monotonic() + timeout
        if kind == 'spawned':
            if self.launcher is None:
                raise RuntimeError('spawned selector requires launch')
            return self.launcher.pid
        if kind == 'existing-pid':
            pid = int(selector['pid'])
            if not self._alive(pid):
                raise RuntimeError(f'existing pid {pid} is not alive')
            return pid
        if kind == 'resolver':
            result = self._run_helper(selector['bridge'], {'method': 'resolve-process'})
            if not isinstance(result, dict) or not isinstance(result.get('pid'), int):
                raise RuntimeError('process resolver must return {pid: integer}')
            pid = result['pid']
            if not self._alive(pid):
                raise RuntimeError(f'process resolver returned dead pid {pid}')
            return pid
        if kind == 'pid-file':
            path = Path(selector['path'])
            while time.monotonic() < deadline:
                if path.exists():
                    try:
                        pid = int(self._read_bytes_bounded(path, 128).decode().strip())
                    except (ValueError, UnicodeDecodeError):
                        pid = 0
                    if self._alive(pid):
                        return pid
                time.sleep(0.05)
            raise TimeoutError(f'pid file did not resolve a live process: {path}')
        if kind == 'descendant-name':
            if self.launcher is None:
                raise RuntimeError('descendant-name selector requires launch')
            if os.name != 'posix' or not Path('/proc').exists():
                raise RuntimeError('descendant-name selector currently requires Linux /proc; use resolver on this OS')
            while time.monotonic() < deadline:
                matches = self._matching_descendants(self.launcher.pid, selector['name'])
                if matches:
                    return max(matches)
                time.sleep(0.05)
            raise TimeoutError(f"no descendant named {selector['name']!r}")
        raise ValueError(f'unknown process selector {kind}')

    def _wait_ready(self, ready: dict[str, Any]) -> None:
        timeout = float(ready.get('timeoutMs', 15_000)) / 1000.0
        deadline = time.monotonic() + timeout
        pattern = re.compile(ready['stdoutPattern']) if ready.get('stdoutPattern') else None
        path = Path(ready['filePath']) if ready.get('filePath') else None
        while time.monotonic() < deadline:
            alive = self._alive(self.target_pid)
            with self.output_lock:
                stdout = ''.join(self.stdout_lines)
            pattern_ok = pattern.search(stdout) is not None if pattern else True
            file_ok = path.exists() if path else True
            if alive and pattern_ok and file_ok:
                return
            if self.launcher is not None and self.launcher.poll() is not None:
                raise RuntimeError(f'game exited during startup with code {self.launcher.returncode}: {self._stderr_tail()}')
            time.sleep(0.05)
        raise TimeoutError('desktop game did not satisfy readiness conditions')

    def _wait_for_observation(self, previous_revision: int) -> None:
        spec = self._required_spec()
        wait_ms = max(float(spec.get('settleMs', 20)), 0.0)
        if wait_ms <= 0:
            return
        observation = spec['observation']
        if observation.get('kind') != 'stdout':
            time.sleep(wait_ms / 1000.0)
            return
        deadline = time.monotonic() + wait_ms / 1000.0
        while time.monotonic() < deadline:
            if self._output_revision() > previous_revision:
                return
            if self.launcher is not None and self.launcher.poll() is not None:
                raise RuntimeError(f'game exited while waiting for output: {self._stderr_tail()}')
            time.sleep(0.002)

    def _output_revision(self) -> int:
        with self.output_lock:
            return self.stdout_revision

    def _run_helper(self, spec: dict[str, Any], request: dict[str, Any]) -> Any:
        env = os.environ.copy()
        env.update({str(k): str(v) for k, v in spec.get('env', {}).items()})
        env['PLAYPROOF_PID'] = str(self.target_pid or 0)
        env['PLAYPROOF_RUN_DIR'] = str(self.run_dir or '')
        payload = json.dumps({**request, 'pid': self.target_pid, 'runDir': self.run_dir}).encode()
        max_bytes = int(spec.get('maxBytes', DEFAULT_FILE_LIMIT))
        timeout = float(spec.get('timeoutMs', 15_000)) / 1000.0
        process = subprocess.Popen(
            self._command(spec),
            cwd=spec.get('cwd') or None,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
        )
        stdout, stderr, overflow = self._communicate_bounded(
            process,
            payload,
            timeout=timeout,
            stdout_limit=max_bytes,
            stderr_limit=DEFAULT_STDERR_LIMIT,
        )
        if overflow:
            raise RuntimeError(f'helper response exceeds {max_bytes} bytes')
        if process.returncode != 0:
            raise RuntimeError(f"helper exited {process.returncode}: {stderr.decode(errors='replace')[-300:]}")
        text = stdout.decode('utf-8', errors='strict')
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    @staticmethod
    def _communicate_bounded(
        process: subprocess.Popen[bytes],
        payload: bytes,
        *,
        timeout: float,
        stdout_limit: int,
        stderr_limit: int,
    ) -> tuple[bytes, bytes, bool]:
        stdout = bytearray()
        stderr = bytearray()
        overflow = threading.Event()

        def read_bounded(stream: BinaryIO | None, target: bytearray, limit: int) -> None:
            if stream is None:
                return
            try:
                while True:
                    chunk = stream.read(8192)
                    if not chunk:
                        return
                    remaining = limit + 1 - len(target)
                    if remaining > 0:
                        target.extend(chunk[:remaining])
                    if len(target) > limit or len(chunk) > remaining:
                        overflow.set()
                        try:
                            process.kill()
                        except OSError:
                            pass
                        return
            finally:
                try:
                    stream.close()
                except OSError:
                    pass

        threads = [
            threading.Thread(target=read_bounded, args=(process.stdout, stdout, stdout_limit), daemon=True),
            threading.Thread(target=read_bounded, args=(process.stderr, stderr, stderr_limit), daemon=True),
        ]
        for thread in threads:
            thread.start()
        if process.stdin is not None:
            try:
                process.stdin.write(payload)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.wait(timeout=2)
            raise TimeoutError(f'helper exceeded {timeout:.3f}s') from error
        for thread in threads:
            thread.join(timeout=2)
        return bytes(stdout), bytes(stderr), overflow.is_set()

    def _stop_game(self) -> None:
        launcher = self.launcher
        group_id = self.process_group_id
        if group_id is not None and os.name == 'posix':
            self._signal_process_group(group_id, signal.SIGTERM)
            if launcher is not None:
                try:
                    launcher.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._signal_process_group(group_id, signal.SIGKILL)
                    try:
                        launcher.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        pass
        elif launcher is not None and launcher.poll() is None:
            launcher.terminate()
            try:
                launcher.wait(timeout=2)
            except subprocess.TimeoutExpired:
                launcher.kill()
                try:
                    launcher.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
        self.launcher = None
        self.process_group_id = None
        self.target_pid = None
        if self.run_dir:
            shutil.rmtree(self.run_dir, ignore_errors=True)
        self.run_dir = None
        self.spec = None

    @staticmethod
    def _signal_process_group(group_id: int, sig: signal.Signals) -> None:
        try:
            os.killpg(group_id, sig)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    def _start_reader(self, stream: TextIO | None, target: list[str], *, stdout: bool) -> None:
        if stream is None:
            return

        def read() -> None:
            for line in stream:
                with self.output_lock:
                    target.append(line)
                    if stdout:
                        self.stdout_revision += 1
                    if len(target) > 10_000:
                        del target[:1_000]

        threading.Thread(target=read, daemon=True).start()

    def _expand(self, value: Any) -> Any:
        if isinstance(value, str):
            return value.replace('{runDir}', str(self.run_dir or '')).replace('{seed}', str(self.seed))
        if isinstance(value, list):
            return [self._expand(item) for item in value]
        if isinstance(value, dict):
            return {key: self._expand(item) for key, item in value.items()}
        return value

    @staticmethod
    def _command(spec: dict[str, Any]) -> list[str]:
        command = str(spec.get('command', ''))
        if not command or '\0' in command:
            raise ValueError('invalid command')
        args = [str(arg) for arg in spec.get('args', [])]
        if any('\0' in arg for arg in args):
            raise ValueError('command argument contains NUL')
        return [command, *args]

    @staticmethod
    def _read_bytes_bounded(path: Path, limit: int) -> bytes:
        if limit <= 0:
            raise ValueError('file maxBytes must be positive')
        size = path.stat().st_size
        if size > limit:
            raise RuntimeError(f'file {path} exceeds {limit} bytes')
        with path.open('rb') as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError(f'file {path} exceeds {limit} bytes')
        return data

    @staticmethod
    def _flatten_numbers(value: Any, prefix: str, out: dict[str, float]) -> None:
        if isinstance(value, bool):
            out[prefix] = 1.0 if value else 0.0
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            out[prefix] = float(value)
        elif isinstance(value, dict):
            for key, child in value.items():
                DesktopWorker._flatten_numbers(child, f'{prefix}.{key}' if prefix else str(key), out)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                DesktopWorker._flatten_numbers(child, f'{prefix}.{index}' if prefix else str(index), out)

    @staticmethod
    def _numeric_map(value: Any) -> dict[str, float]:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise RuntimeError('helper numeric state must be an object')
        out: dict[str, float] = {}
        for key, raw in value.items():
            if isinstance(raw, bool):
                out[str(key)] = 1.0 if raw else 0.0
            elif isinstance(raw, (int, float)):
                out[str(key)] = float(raw)
            else:
                raise RuntimeError(f'helper state {key} is not numeric')
        return out

    @staticmethod
    def _alive(pid: int | None) -> bool:
        if not pid or pid <= 0:
            return False
        if os.name == 'posix' and Path('/proc').exists():
            try:
                stat = Path(f'/proc/{pid}/stat').read_text()
                close = stat.rfind(')')
                state = stat[close + 2:].split()[0]
                if state in {'Z', 'X', 'x'}:
                    return False
            except (OSError, IndexError):
                pass
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    @staticmethod
    def _matching_descendants(root: int, name: str) -> list[int]:
        parents: dict[int, int] = {}
        names: dict[int, set[str]] = {}
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / 'stat').read_text()
                close = stat.rfind(')')
                fields = stat[close + 2:].split()
                pid = int(entry.name)
                parents[pid] = int(fields[1])
                candidates = {(entry / 'comm').read_text().strip()}
                cmdline = (entry / 'cmdline').read_bytes().split(b'\0', 1)[0]
                if cmdline:
                    candidates.add(Path(os.fsdecode(cmdline)).name)
                names[pid] = candidates
            except (OSError, ValueError, IndexError):
                continue
        descendants: set[int] = {root}
        changed = True
        while changed:
            changed = False
            for pid, parent in parents.items():
                if parent in descendants and pid not in descendants:
                    descendants.add(pid)
                    changed = True
        return [pid for pid in descendants if pid != root and name in names.get(pid, set())]

    def _stderr_tail(self) -> str:
        with self.output_lock:
            return ''.join(self.stderr_lines)[-300:]


def serve(fin: TextIO, fout: TextIO) -> None:
    worker = DesktopWorker()
    for line in fin:
        line = line.strip()
        if not line:
            continue
        request: dict[str, Any] = {}
        try:
            request = json.loads(line)
            method = request['method']
            params = request.get('params') or {}
            if method == 'boot':
                result = worker.boot(params['spec'], params.get('seed', 0))
            elif method == 'reset':
                result = worker.reset()
            elif method == 'step':
                result = worker.step_once(params['input'])
            elif method == 'frame':
                result = {'text': worker.frame_text()}
            elif method == 'evidence':
                result = worker.evidence()
            elif method in ('checkpoint', 'restore'):
                raise RuntimeError('native desktop worker does not claim checkpoint support')
            elif method == 'shutdown':
                worker.shutdown()
                result = {'bye': True}
                fout.write(json.dumps({'id': request.get('id'), 'ok': True, 'result': result}) + '\n')
                fout.flush()
                return
            else:
                raise ValueError(f'unknown method {method}')
            fout.write(json.dumps({'id': request.get('id'), 'ok': True, 'result': result}) + '\n')
            fout.flush()
        except Exception as error:
            fout.write(json.dumps({'id': request.get('id', -1), 'ok': False, 'error': f'{type(error).__name__}: {error}'}) + '\n')
            fout.flush()


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit('usage: worker.py FIFO_IN FIFO_OUT')
    fifo_in, fifo_out = sys.argv[1], sys.argv[2]
    os.mkfifo(fifo_in)
    os.mkfifo(fifo_out)
    Path(fifo_in).with_name('ready').touch()
    with open(fifo_in, 'r') as fin, open(fifo_out, 'w') as fout:
        serve(fin, fout)


if __name__ == '__main__':
    main()
