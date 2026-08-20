"""Gymnasium worker driven over the shared Playproof line-JSON protocol.

One worker serves any registered Gymnasium environment with a `Discrete`
action space: classic control, toy text, procedurally generated suites, and
text environments. Nothing in this file is environment-specific. The action
vocabulary, the observation projection, and the readable frame all come from
the environment the caller names.

Protocol methods:
  boot       {envId, seed?, kwargs?, maxEpisodeSteps?}
  reset      {seed?}
  step       {input}          one action word
  evidence   {}
  frame      {}
  inputs     {}               the advertised action vocabulary
  snapshot   {mode?}          `engine` (default when available) or `replay`
  checkpoint {}               same payload, shaped for the shared WorkerRpc
  restore    {state}
  shutdown   {}

Scales, declared once and reported in `boot`:
  REWARD_SCALE  cumulative reward and every numeric `info` entry are
                multiplied by 1000 and rounded, because Playproof evidence
                is integer-only. Reward 1.0 is `cumulativeReward` 1000.
  OBS_SCALE     each published observation component is multiplied by 1000
                and rounded into `frameState`.
`steps`, `terminated`, and `truncated` are counts and flags, never scaled.

Honest evidence limit: a generic Gymnasium environment has no privileged
channel the agent cannot author. Reward, `info`, and the observation are all
derived from what the environment itself returns to the policy, so this
adapter's evidence is weaker than the RAM-backed engine state an emulator
adapter reads. Verification still rests on replay: the verifier re-executes
the environment from the seed and the input log and recomputes every
milestone, so a claimed milestone that the environment does not produce is
rejected. What this adapter cannot offer is a progress signal that is hidden
from the agent.

Determinism: an environment reproduces across processes only when
`reset(seed=...)` fixes the whole trajectory. That holds for deterministic
dynamics (CartPole-v1) and for stochastic dynamics whose randomness comes
from the seeded `np_random` (FrozenLake-v1 with `is_slippery=False` has no
randomness at all after reset). An environment that reads an unseeded clock,
a global RNG, or external state is not replay-verifiable and must not be
given a contract.

stdout carries only protocol lines. Diagnostics belong on stderr.
"""
import hashlib
import json
import os
import re
import sys
import warnings

warnings.filterwarnings('ignore')

REWARD_SCALE = 1000
OBS_SCALE = 1000
MAX_INFO_ENTRIES = 16
MAX_FRAME_STATE_DIMS = 8
MAX_FRAME_TEXT_DIMS = 16
MAX_FRAME_TEXT_CHARS = 4096
# The generic checkpoint replays the run from its seed, so the input list
# travels with it. The bound keeps one protocol line inside the transport cap.
MAX_REPLAY_INPUTS = 20000
NOOP = 'NOOP'
CHECKPOINT_MAGIC = 'playproof-gym-checkpoint'
CHECKPOINT_VERSION = 1
# Environments whose current position lives in one plain attribute of the
# unwrapped environment. Restoring it is exact for deterministic dynamics and
# far cheaper than replaying the whole run.
STATE_ATTRS = ('state', 's')
ANSI_SGR = re.compile(r'\x1b\[[0-9;]*m')
# A toy-text `ansi` render marks the agent's own cell with a colour escape
# and nothing else, so the colours are converted to brackets before they
# are removed. Dropping them would delete the position from the frame.
ANSI_HIGHLIGHT = re.compile(r'\x1b\[[1-9][0-9;]*m(.*?)\x1b\[0m')


def _plain(value):
    """Convert numpy containers and scalars into JSON-safe Python values."""
    import numpy as np
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    return value


def _encode(value):
    """Encode one attribute so `_decode` rebuilds its exact runtime type."""
    import numpy as np
    if isinstance(value, np.ndarray):
        return {'type': 'ndarray', 'dtype': str(value.dtype), 'value': value.tolist()}
    if isinstance(value, np.generic):
        return {'type': 'scalar', 'dtype': str(value.dtype), 'value': value.item()}
    if isinstance(value, bool) or isinstance(value, int) or isinstance(value, float):
        return {'type': 'number', 'value': value}
    if isinstance(value, str):
        return {'type': 'text', 'value': value}
    if isinstance(value, (list, tuple)):
        return {'type': 'list', 'value': [_encode(item) for item in value]}
    if value is None:
        return {'type': 'none'}
    raise TypeError(f'cannot checkpoint a {type(value).__name__} attribute')


def _decode(blob):
    import numpy as np
    kind = blob['type']
    if kind == 'ndarray':
        return np.array(blob['value'], dtype=np.dtype(blob['dtype']))
    if kind == 'scalar':
        return np.dtype(blob['dtype']).type(blob['value'])
    if kind in ('number', 'text'):
        return blob['value']
    if kind == 'list':
        return [_decode(item) for item in blob['value']]
    if kind == 'none':
        return None
    raise ValueError(f'unknown checkpoint attribute type {kind!r}')


def _numeric_components(obs):
    """Flatten an observation into a bounded list of numbers, or None."""
    import numpy as np
    if isinstance(obs, np.ndarray):
        if obs.dtype.kind not in 'fiub':
            return None
        return [float(x) for x in obs.reshape(-1)[:MAX_FRAME_TEXT_DIMS]]
    if isinstance(obs, np.generic):
        return [float(obs.item())]
    if isinstance(obs, bool) or isinstance(obs, (int, float)):
        return [float(obs)]
    if isinstance(obs, (list, tuple)):
        out = []
        for item in obs[:MAX_FRAME_TEXT_DIMS]:
            if isinstance(item, (bool, int, float)):
                out.append(float(item))
            elif isinstance(item, np.generic):
                out.append(float(item.item()))
            else:
                return None
        return out
    return None


class Worker:
    def __init__(self):
        self.env = None
        self.env_id = None
        self.kwargs = {}
        self.max_episode_steps = None
        self.render_mode = None
        self.seed = 0
        self.actions = []
        self.gen = 0
        self.steps = 0
        self.reward = 0.0
        self.terminated = False
        self.truncated = False
        self.obs = None
        self.info = {}
        self.history = []
        self.history_complete = True
        self._cache = None

    # ---- lifecycle -------------------------------------------------------

    def boot(self, env_id, seed=0, kwargs=None, max_episode_steps=None):
        import gymnasium
        self.env_id = str(env_id)
        self.kwargs = dict(kwargs or {})
        self.max_episode_steps = None if max_episode_steps is None else int(max_episode_steps)
        self.seed = int(seed)
        self._make(gymnasium)
        self.actions = self._action_names()
        self._reset_env()
        return self.identity()

    def _make(self, gymnasium):
        """Build the environment, asking for the `ansi` renderer when the
        environment advertises one and the caller has not chosen otherwise."""
        extra = {} if self.max_episode_steps is None else {'max_episode_steps': self.max_episode_steps}
        env = gymnasium.make(self.env_id, **self.kwargs, **extra)
        self.render_mode = self.kwargs.get('render_mode')
        if 'render_mode' not in self.kwargs and 'ansi' in (env.metadata or {}).get('render_modes', []):
            env.close()
            env = gymnasium.make(self.env_id, render_mode='ansi', **self.kwargs, **extra)
            self.render_mode = 'ansi'
        self.env = env

    def _action_names(self):
        import gymnasium
        space = self.env.action_space
        if not isinstance(space, gymnasium.spaces.Discrete):
            raise ValueError(
                f'{self.env_id} has action space {space}; this adapter supports Discrete only. '
                'MultiDiscrete, MultiBinary, and Box actions need a word-to-vector encoding '
                'that Playproof does not declare in v1.'
            )
        count = int(space.n)
        meanings = None
        getter = getattr(self.env.unwrapped, 'get_action_meanings', None)
        if callable(getter):
            try:
                meanings = [str(name) for name in getter()]
            except Exception:
                meanings = None
        if meanings is None or len(meanings) != count:
            return [f'a{i}' for i in range(count)]
        names = []
        for index, name in enumerate(meanings):
            names.append(name if name not in names else f'{name}#{index}')
        return names

    def _reset_env(self):
        obs, info = self.env.reset(seed=self.seed)
        self.obs = obs
        self.info = info or {}
        self.steps = 0
        self.reward = 0.0
        self.terminated = False
        self.truncated = False
        self.history = []
        self.history_complete = True
        self.gen += 1
        self._cache = None

    def reset(self, seed=None):
        if seed is not None:
            self.seed = int(seed)
        self._reset_env()
        return {'gen': self.gen, 'frame': self.steps}

    def identity(self):
        return {
            'gen': self.gen,
            'frame': self.steps,
            'envId': self.env_id,
            'seed': self.seed,
            'kwargs': _plain(self.kwargs),
            'actions': list(self.actions),
            'inputs': self.vocabulary(),
            'actionSpace': str(self.env.action_space),
            'observationSpace': str(self.env.observation_space),
            'maxEpisodeSteps': self.env.spec.max_episode_steps if self.env.spec else None,
            'renderMode': self.render_mode,
            'rewardScale': REWARD_SCALE,
            'obsScale': OBS_SCALE,
            'frameText': self.frame_text(),
        }

    # ---- inputs ----------------------------------------------------------

    def vocabulary(self):
        words = list(self.actions)
        if NOOP not in words:
            words.insert(0, NOOP)
        return words

    def _action_index(self, word):
        """Resolve one word to an action index, or None for a no-op.

        Unknown words are no-ops because an agent typo is not a cheat. A
        `Discrete` environment has no guaranteed idle action, so a no-op here
        does NOT repeat an action and does NOT advance the environment: the
        worker simply does not call `env.step`, and the state is unchanged.
        `NOOP` is advertised and behaves the same way, unless the environment
        itself names an action `NOOP` (ALE does), in which case that real
        action wins.
        """
        if not isinstance(word, str):
            return None
        needle = word.strip()
        if needle == '':
            return None
        for index, name in enumerate(self.actions):
            if name == needle or name.lower() == needle.lower():
                return index
        return None

    # ---- evidence --------------------------------------------------------

    def _info_state(self):
        import numpy as np
        out = {}
        for key in sorted(str(k) for k in self.info.keys()):
            value = self.info[key]
            if isinstance(value, np.generic):
                value = value.item()
            if isinstance(value, bool):
                value = int(value)
            if not isinstance(value, (int, float)):
                continue
            out[f'info.{key}'] = int(round(float(value) * REWARD_SCALE))
            if len(out) >= MAX_INFO_ENTRIES:
                break
        return out

    def _frame_state(self):
        components = _numeric_components(self.obs)
        if components is None:
            return {}
        return {
            f'obs{i}': int(round(value * OBS_SCALE))
            for i, value in enumerate(components[:MAX_FRAME_STATE_DIMS])
        }

    def _frame_hash(self):
        """Hash the whole observation, not the bounded projection of it.

        A dense array is hashed over its dtype, its shape, and its raw bytes,
        which is exact and stays cheap for an image observation. Anything else
        is hashed over its canonical JSON.
        """
        import numpy as np
        obs = self.obs
        if isinstance(obs, np.ndarray):
            digest = hashlib.sha256()
            digest.update(f'{obs.dtype.str}|{obs.shape}|'.encode('utf8'))
            digest.update(np.ascontiguousarray(obs).tobytes())
            return digest.hexdigest()
        canonical = json.dumps(_plain(obs), sort_keys=True, separators=(',', ':'))
        return hashlib.sha256(canonical.encode('utf8')).hexdigest()

    def _evidence(self):
        key = (self.gen, self.steps, self.terminated, self.truncated)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        engine = {
            'cumulativeReward': int(round(self.reward * REWARD_SCALE)),
            'steps': self.steps,
            'terminated': 1 if self.terminated else 0,
            'truncated': 1 if self.truncated else 0,
        }
        engine.update(self._info_state())
        ev = {
            'engineState': engine,
            'frameState': self._frame_state(),
            'frameHash': self._frame_hash(),
        }
        self._cache = (key, ev)
        return ev

    def frame_text(self):
        lines = []
        if self.render_mode == 'ansi':
            try:
                rendered = self.env.render()
            except Exception:
                rendered = None
            if isinstance(rendered, str):
                # The frame is read by a language model, not by a terminal.
                marked = ANSI_HIGHLIGHT.sub(r'[\1]', rendered)
                lines.append(ANSI_SGR.sub('', marked).strip('\n'))
        if not lines and isinstance(self.obs, str):
            lines.append(self.obs)
        if not lines:
            components = _numeric_components(self.obs)
            if components is not None:
                lines.append(' '.join(f'obs{i}={value:.6f}' for i, value in enumerate(components)))
            else:
                lines.append(f'observation type {type(self.obs).__name__} has no readable projection')
        lines.append(
            f'steps={self.steps} reward={self.reward:.3f} '
            f'terminated={1 if self.terminated else 0} truncated={1 if self.truncated else 0}'
        )
        return '\n'.join(lines)[:MAX_FRAME_TEXT_CHARS]

    # ---- transitions -----------------------------------------------------

    def step(self, word):
        index = self._action_index(word)
        # An unknown word and a finished episode both leave the environment
        # exactly where it was. Neither is an error.
        if index is not None and not (self.terminated or self.truncated):
            obs, reward, terminated, truncated, info = self.env.step(index)
            self.obs = obs
            self.info = info or {}
            self.reward += float(reward)
            self.steps += 1
            self.terminated = bool(terminated)
            self.truncated = bool(truncated)
            if len(self.history) < MAX_REPLAY_INPUTS:
                self.history.append(self.actions[index])
            else:
                self.history_complete = False
            self._cache = None
        return {'frame': self.steps, 'evidence': self._evidence(), 'frameText': self.frame_text()}

    # ---- checkpoints -----------------------------------------------------

    def _engine_payload(self):
        """A JSON copy of the environment's own position, when it lives in one
        readable attribute. `pickle` is never used: a checkpoint stays a plain
        protocol value that a verifier can read."""
        unwrapped = self.env.unwrapped
        for attr in STATE_ATTRS:
            value = getattr(unwrapped, attr, None)
            if value is None:
                continue
            try:
                payload = {'attr': attr, 'value': _encode(value), 'obs': _encode(self.obs)}
            except TypeError:
                return None
            for extra in ('lastaction', 'steps_beyond_terminated', 'steps_beyond_done'):
                if hasattr(unwrapped, extra):
                    try:
                        payload[extra] = _encode(getattr(unwrapped, extra))
                    except TypeError:
                        return None
            limiter = self._time_limit()
            if limiter is not None:
                payload['elapsedSteps'] = limiter._elapsed_steps
            # Only plain scalars travel. Everything the evidence reads out of
            # `info` is numeric, so nothing a milestone can pin is lost.
            payload['info'] = {
                key: value for key, value in _plain(self.info).items()
                if isinstance(value, (bool, int, float, str))
            }
            return payload
        return None

    def _time_limit(self):
        node = self.env
        while node is not None:
            if hasattr(node, '_elapsed_steps'):
                return node
            node = getattr(node, 'env', None)
        return None

    def snapshot(self, mode=None):
        engine = None if mode == 'replay' else self._engine_payload()
        if engine is None and not self.history_complete:
            raise ValueError(
                f'run exceeds {MAX_REPLAY_INPUTS} inputs and this environment exposes no readable '
                'state attribute, so no checkpoint can be taken'
            )
        return {
            'playproof': CHECKPOINT_MAGIC,
            'version': CHECKPOINT_VERSION,
            'kind': 'replay' if engine is None else 'engine',
            'envId': self.env_id,
            'gen': self.gen,
            'seed': self.seed,
            'frame': self.steps,
            'steps': self.steps,
            'reward': self.reward,
            'terminated': self.terminated,
            'truncated': self.truncated,
            'inputs': list(self.history),
            'engine': engine,
        }

    def restore(self, blob):
        if not isinstance(blob, dict) or blob.get('playproof') != CHECKPOINT_MAGIC:
            raise ValueError('blob is not a Playproof Gymnasium checkpoint')
        if blob.get('version') != CHECKPOINT_VERSION:
            raise ValueError(f'unsupported checkpoint version {blob.get("version")!r}')
        if blob.get('envId') != self.env_id:
            raise ValueError(f'checkpoint belongs to {blob.get("envId")!r}, worker runs {self.env_id!r}')
        if blob.get('kind') == 'engine' and blob.get('engine'):
            self._restore_engine(blob)
        else:
            self._restore_by_replay(blob)
        self._cache = None
        return {'gen': self.gen, 'frame': self.steps}

    def _restore_engine(self, blob):
        engine = blob['engine']
        unwrapped = self.env.unwrapped
        setattr(unwrapped, engine['attr'], _decode(engine['value']))
        for extra in ('lastaction', 'steps_beyond_terminated', 'steps_beyond_done'):
            if extra in engine and hasattr(unwrapped, extra):
                setattr(unwrapped, extra, _decode(engine[extra]))
        limiter = self._time_limit()
        if limiter is not None and 'elapsedSteps' in engine:
            limiter._elapsed_steps = engine['elapsedSteps']
        self.obs = _decode(engine['obs'])
        self.info = engine.get('info') or {}
        self.steps = int(blob['steps'])
        self.reward = float(blob['reward'])
        self.terminated = bool(blob['terminated'])
        self.truncated = bool(blob['truncated'])
        self.history = list(blob['inputs'])
        self.history_complete = True
        # The RNG stream is not part of this payload. The fast path is exact
        # for environments whose `step` is a deterministic function of the
        # restored attribute; anything else must checkpoint with mode
        # `replay`, which rebuilds the environment from its seed.

    def _restore_by_replay(self, blob):
        self.seed = int(blob['seed'])
        # `gen` marks an emulator generation the caller may hold state against,
        # and a restore lands inside the same generation, so it is preserved
        # across the rebuild that `_reset_env` performs.
        generation = self.gen
        self._reset_env()
        self.gen = generation
        for word in blob['inputs']:
            self.step(word)
        if self.steps != int(blob['steps']):
            raise ValueError(
                f'replay checkpoint landed on step {self.steps}, expected {blob["steps"]}; '
                f'{self.env_id} is not deterministic under its seed'
            )

    def close(self):
        if self.env is not None:
            self.env.close()
            self.env = None


def main():
    if len(sys.argv) >= 3:
        fifo_in, fifo_out = sys.argv[1], sys.argv[2]
        os.mkfifo(fifo_in)
        os.mkfifo(fifo_out)
        ready = os.path.join(os.path.dirname(fifo_in), 'ready')
        with open(ready, 'w'):
            pass
        fin = open(fifo_in, 'r')
        fout = open(fifo_out, 'w')
        transport = (fin, fout)
    else:
        transport = (sys.stdin, sys.stdout)
    serve(transport)


def dispatch(worker, method, params):
    if method == 'boot':
        return worker.boot(
            env_id=params['envId'],
            seed=params.get('seed', 0),
            kwargs=params.get('kwargs'),
            max_episode_steps=params.get('maxEpisodeSteps'),
        )
    if method == 'reset':
        return worker.reset(params.get('seed'))
    if method == 'step':
        return worker.step(params.get('input'))
    if method == 'evidence':
        return worker._evidence()
    if method == 'frame':
        return {'text': worker.frame_text()}
    if method == 'inputs':
        return {'inputs': worker.vocabulary(), 'actions': list(worker.actions)}
    if method in ('snapshot', 'checkpoint'):
        return worker.snapshot(params.get('mode'))
    if method == 'restore':
        return worker.restore(params.get('state'))
    raise ValueError(f'unknown method {method}')


def serve(transport):
    fin, fout = transport
    worker = Worker()
    for line in fin:
        line = line.strip()
        if not line:
            continue
        req = {}
        try:
            req = json.loads(line)
            method = req['method']
            params = req.get('params') or {}
            if method == 'shutdown':
                fout.write(json.dumps({'id': req.get('id'), 'ok': True, 'result': {'bye': True}}) + '\n')
                fout.flush()
                worker.close()
                return
            result = dispatch(worker, method, params)
            fout.write(json.dumps({'id': req.get('id'), 'ok': True, 'result': result}) + '\n')
            fout.flush()
        except Exception as e:
            fout.write(json.dumps({'id': req.get('id', -1), 'ok': False, 'error': f'{type(e).__name__}: {e}'}) + '\n')
            fout.flush()


if __name__ == '__main__':
    main()
