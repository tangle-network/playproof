"""RetroArch worker driven over the shared Playproof line-JSON protocol.

Playproof does not link a libretro core. It launches the RetroArch binary as a
black box and drives it over the two UDP interfaces RetroArch already
publishes, so every core RetroArch can load becomes a Playproof game with no
Playproof code per console:

  network command interface (`network_cmd_port`, text)
    GET_STATUS, FRAMEADVANCE, PAUSE_TOGGLE, RESET, SAVE_STATE, LOAD_STATE,
    SCREENSHOT, READ_CORE_MEMORY <hexaddr> <n>, QUIT.
  network remote gamepad (`network_remote_base_port`, binary)
    one 20-byte `struct remote_message { int port, device, index, id;
    uint16_t state; }` per button transition, little-endian on every platform
    Playproof supports.

Protocol methods:
  boot       {binary, core, content, channels?, inputs?, frames?, pressFrames?,
              bootFrames?, systemDir?, videoDriver?, seed?}
  reset      {seed?}          restore the boot save state
  step       {input}          one input word over `frames` emulator frames
  evidence   {}
  frame      {}
  inputs     {}
  snapshot   {}               RetroArch save state, deflate + base64
  checkpoint {}               same blob, shaped for the shared WorkerRpc
  restore    {state}
  shutdown   {}

Determinism comes from frame stepping, not from a seed: libretro cores take no
seed, so `reset(seed)` restores a boot save state and the seed is recorded but
nominal. Every transition after that is an explicit, counted frame advance
from a pinned state, which is what makes a replay reproducible.

Measured facts about RetroArch 1.22.2 that this worker is built on. Each one
was verified against the real binary; changing them needs a new measurement.

  1. Every directory setting must name an existing absolute path. RetroArch
     copies unset path settings with strlcpy during the first `retro_run` and
     segfaults on the NULL. A partial config crashes the emulator, so
     `_config` writes the whole directory surface into the run directory.
  2. `video_driver = "null"` runs headless, opens no window, and still serves
     SCREENSHOT, because the screenshot is taken from the core framebuffer
     rather than the display.
  3. FRAMEADVANCE is edge triggered (`pressed && !old_pressed`). Two
     FRAMEADVANCE datagrams in consecutive polls advance ONE frame, so each
     frame needs an advance poll and then a poll without it.
  4. While paused RetroArch throttles the run loop to the core frame rate.
     Holding FAST_FORWARD in the advance datagram removes the throttle from
     the advancing iteration and raises stepping from ~59 to ~80 frames per
     second. It changes throttling only, never how many frames the core runs.
  5. SAVE_STATE and LOAD_STATE are checked far enough down the hotkey path
     that a paused iteration never reaches them. Both work when they travel
     in the same datagram as FRAMEADVANCE. Measured offsets: SAVE_STATE
     samples the state before that frame runs, LOAD_STATE consumes the frame.
     `snapshot` and `restore` therefore both leave the emulator one frame
     past the snapshotted instant, which is what makes the round trip exact.
  6. One READ_CORE_MEMORY reply must fit one UDP datagram, so a request is
     capped at 2048 bytes. Several requests travel in one datagram and are
     matched back to their block by the address RetroArch echoes.
  7. The remote gamepad holds its button bitmask until a later message
     changes it, and RetroArch reads at most one remote message per poll, so
     this worker sends a message only when a button changes state.

`screenImage` publishes the screen for a vision agent. This worker is the one
that needs no encoder: RetroArch already writes a PNG for SCREENSHOT and the
evidence path already reads it, so the option republishes those exact bytes and
costs nothing beyond the base64. There is no upscale knob here, unlike the ALE,
PyBoy and stable-retro workers: this worker has no array library, and repeating
pixels and re-encoding a PNG in pure Python every turn would cost more than the
option is worth. The channel is off by default.

stdout carries only protocol lines. Diagnostics belong on stderr.
"""
import atexit
import base64
import glob
import hashlib
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
import zlib

# libretro RETRO_DEVICE_JOYPAD ids (libretro.h). RetroArch's remote gamepad
# accepts ids below 16 and stores them as a bitmask per port.
RETRO_DEVICE_JOYPAD = 1
JOYPAD_IDS = {
    'b': 0, 'y': 1, 'select': 2, 'start': 3, 'up': 4, 'down': 5, 'left': 6,
    'right': 7, 'a': 8, 'x': 9, 'l': 10, 'r': 11, 'l2': 12, 'r2': 13,
    'l3': 14, 'r3': 15,
}
# `int port, device, index, id; uint16_t state;` padded to the struct's
# 4-byte alignment. RetroArch drops any datagram that is not exactly 20 bytes.
REMOTE_MESSAGE = struct.Struct('<iiiiHxx')

NOOP = 'NOOP'
DIRECTIONS = ('up', 'down', 'left', 'right')
NON_ACTION_BUTTONS = ('start', 'select', 'l', 'r', 'l2', 'r2', 'l3', 'r3')
MAX_VOCABULARY_ACTIONS = 3

MAX_READ_BYTES = 2048
COMMAND_TIMEOUT = 5.0
SOCKET_POLL = 0.25
BOOT_TIMEOUT = 15.0
# A launch can lose its race with the host window system and come up without
# a run loop, so the process lives but answers nothing. It is never a mid-run
# stall: once a boot answers GET_STATUS, the same process serves tens of
# thousands of frame advances. A bounded relaunch is therefore the whole fix.
BOOT_ATTEMPTS = 6
# Save and load state are hotkeys with no reply, so both are retried until
# RetroArch shows the work in its own log or writes the file.
STATE_ATTEMPTS = 8
# A state load makes RetroArch reinitialise its video, input, and audio
# drivers, and that reinitialisation sometimes ends the process. A reset can
# therefore replace the emulator, because a reset returns to the pinned boot
# state and has no evidence to invalidate. A death mid-run ends the run.

# macOS only. AppKit saves restorable window state for an application that
# does not exit cleanly, and Playproof kills RetroArch to guarantee no
# emulator outlives a run. Once that state exists every later launch blocks
# inside -[NSApplication _reopenWindowsAsNecessaryIncludingRestorableState:]
# before RetroArch runs any of its own code, which looks exactly like a hung
# emulator. Deleting the saved state keeps launches clean; the user default
# below is the permanent fix and the error message names it.
MACOS_DEFAULTS_HINT = (
    'On macOS, set both of these once for RetroArch:\n'
    '  defaults write %s ApplePersistenceIgnoreState -bool YES\n'
    '  defaults write %s NSAppSleepDisabled -bool YES\n'
    'The first stops AppKit from blocking every launch that follows an\n'
    'unclean exit while it restores windows. The second stops App Nap from\n'
    'throttling the run loop of a windowless background application, which\n'
    'stalls frame advance for seconds at a time.'
)

# Advance one emulator frame, then confirm the poll that consumed it. The
# confirming poll also clears the edge so the next advance triggers.
ADVANCE_MSG = 'FAST_FORWARD_HOLD\nFRAMEADVANCE\nGET_STATUS'
GAP_MSG = 'FAST_FORWARD_HOLD\nGET_STATUS'

SNAPSHOT_MAGIC = b'PPRA'
SNAPSHOT_VERSION = 1
SNAPSHOT_HEADER = struct.Struct('<4sHQ')

FRAME_ROWS = 18
FRAME_COLS = 40
GLYPHS = ' .:-=+*#%@'
# Console screens vary in polarity: a Game Boy screen is bright with dark
# sprites, a Genesis screen is dark with bright sprites. The ramp is indexed
# by darkness so the dense glyphs always mark the drawn pixels, and a square
# root curve keeps detail without per-frame normalization, which would make
# the observation jump between frames.
GLYPH_RAMP = tuple(
    min(len(GLYPHS) - 1, int((((255 - value) / 255.0) ** 0.5) * (len(GLYPHS) - 1) + 0.5))
    for value in range(256)
)
MAX_SUMMARY_CHANNELS = 8
# The edge a model provider resizes an observation image down to.
MAX_SCREEN_DIMENSION = 2048

FILE_KEYS = {
    'core_options_path': 'config/core-options.cfg',
    'content_history_path': 'playlists/history.lpl',
    'content_favorites_path': 'playlists/favorites.lpl',
    'content_image_history_path': 'playlists/image.lpl',
    'content_music_history_path': 'playlists/music.lpl',
    'content_video_history_path': 'playlists/video.lpl',
}
FIXED_SETTINGS = {
    'audio_driver': 'null',
    'audio_enable': 'false',
    # The null video driver initialises no input driver of its own, and on a
    # headless Linux host RetroArch then fails to pick one and exits with
    # "Cannot initialize input driver". Playproof never uses local input:
    # buttons arrive over the network remote gamepad and hotkeys over the
    # network command interface, both of which are independent of these.
    'input_driver': 'null',
    'input_joypad_driver': 'null',
    'video_vsync': 'false',
    'video_threaded': 'false',
    'video_fullscreen': 'false',
    'video_windowed_fullscreen': 'false',
    'video_window_save_positions': 'false',
    'video_scale': '1',
    'video_gpu_screenshot': 'false',
    'video_font_enable': 'false',
    'video_shader_enable': 'false',
    'menu_driver': 'rgui',
    'pause_nonactive': 'false',
    'rewind_enable': 'false',
    'run_ahead_enabled': 'false',
    'preemptive_frames_enable': 'false',
    'savestate_auto_save': 'false',
    'savestate_auto_load': 'false',
    'savestate_auto_index': 'false',
    'savestate_thumbnail_enable': 'false',
    'config_save_on_exit': 'false',
    'fps_show': 'false',
    'cheevos_enable': 'false',
    'history_list_enable': 'false',
    'notification_show_screenshot': 'false',
    'sort_savefiles_enable': 'false',
    'sort_savestates_enable': 'false',
    # A ratio below 1 means "no frame limit" (runloop_set_frame_limit), which
    # is what makes FAST_FORWARD_HOLD remove the throttle in fact 4.
    'fastforward_ratio': '0.0',
}


class RetroArchError(RuntimeError):
    pass


def _free_port():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]
    finally:
        sock.close()


def _decode_png(data):
    """Minimal PNG reader for the 8-bit non-interlaced images RetroArch writes.

    RetroArch picks a filter per scanline, so all five filter types appear;
    the decoder is complete for grayscale, RGB and RGBA at 8 bits.
    """
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('screenshot is not a PNG')
    offset = 8
    width = height = color_type = 0
    chunks = []
    while offset + 8 <= len(data):
        length = int.from_bytes(data[offset:offset + 4], 'big')
        kind = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        if kind == b'IHDR':
            width, height, depth, color_type, _comp, _filt, interlace = struct.unpack('>IIBBBBB', body[:13])
            if depth != 8 or interlace != 0 or color_type not in (0, 2, 6):
                raise ValueError('unsupported PNG: depth %d colour %d interlace %d' % (depth, color_type, interlace))
        elif kind == b'IDAT':
            chunks.append(body)
        elif kind == b'IEND':
            break
        offset += 12 + length
    raw = zlib.decompress(b''.join(chunks))
    bpp = {0: 1, 2: 3, 6: 4}[color_type]
    stride = width * bpp
    pixels = bytearray(height * stride)
    prior = bytearray(stride)
    pos = 0
    for row in range(height):
        kind = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if kind == 1:
            for x in range(bpp, stride):
                line[x] = (line[x] + line[x - bpp]) & 0xFF
        elif kind == 2:
            for x in range(stride):
                line[x] = (line[x] + prior[x]) & 0xFF
        elif kind == 3:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                line[x] = (line[x] + ((left + prior[x]) >> 1)) & 0xFF
        elif kind == 4:
            for x in range(stride):
                left = line[x - bpp] if x >= bpp else 0
                up = prior[x]
                upleft = prior[x - bpp] if x >= bpp else 0
                estimate = left + up - upleft
                da = abs(estimate - left)
                db = abs(estimate - up)
                dc = abs(estimate - upleft)
                if da <= db and da <= dc:
                    best = left
                elif db <= dc:
                    best = up
                else:
                    best = upleft
                line[x] = (line[x] + best) & 0xFF
        elif kind != 0:
            raise ValueError('unknown PNG filter %d' % kind)
        pixels[row * stride:(row + 1) * stride] = line
        prior = line
    return width, height, bpp, bytes(pixels)


def _luminance(width, height, bpp, pixels):
    if bpp == 1:
        return pixels
    red = pixels[0::bpp]
    green = pixels[1::bpp]
    blue = pixels[2::bpp]
    return bytes((2 * r + 5 * g + b) // 8 for r, g, b in zip(red, green, blue))


def _cells(width, height, lum):
    """Block-mean downsample to FRAME_ROWS x FRAME_COLS for any resolution."""
    rows = []
    for ry in range(FRAME_ROWS):
        y0 = ry * height // FRAME_ROWS
        y1 = max(y0 + 1, (ry + 1) * height // FRAME_ROWS)
        row = []
        for rx in range(FRAME_COLS):
            x0 = rx * width // FRAME_COLS
            x1 = max(x0 + 1, (rx + 1) * width // FRAME_COLS)
            total = 0
            for y in range(y0, y1):
                base = y * width
                total += sum(lum[base + x0:base + x1])
            row.append(total // ((y1 - y0) * (x1 - x0)))
        rows.append(row)
    return rows


def _bcd(byte):
    return (byte >> 4) * 10 + (byte & 0x0F)


class RetroArch:
    """Owns the RetroArch process and the two UDP interfaces."""

    def __init__(self, binary, core, content, system_dir=None, video_driver='null'):
        if not os.path.exists(binary):
            raise RetroArchError('RetroArch binary not found: %s' % binary)
        if not os.path.exists(core):
            raise RetroArchError('libretro core not found: %s' % core)
        if not os.path.exists(content):
            raise RetroArchError('content not found: %s' % content)
        self.binary = binary
        self.core = core
        self.content = content
        self.run_dir = tempfile.mkdtemp(prefix='playproof-retroarch-')
        self.log_path = os.path.join(self.run_dir, 'retroarch.log')
        # RetroArch's own log only exists once it parses its arguments, so its
        # standard streams are kept too: a binary that cannot start at all
        # says why there and nowhere else.
        self.console_path = os.path.join(self.run_dir, 'retroarch-console.log')
        self.state_path = None
        self.process = None
        self.attempts = 0
        self.system_dir = system_dir
        self.video_driver = video_driver
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(SOCKET_POLL)
        atexit.register(self.kill)
        self._boot(system_dir, video_driver)

    def _bundle_id(self):
        """Bundle identifier when the binary lives inside a macOS .app."""
        path = os.path.abspath(self.binary)
        while path not in ('/', ''):
            if path.endswith('.app'):
                plist = os.path.join(path, 'Contents', 'Info.plist')
                try:
                    with open(plist, 'rb') as handle:
                        import plistlib
                        return plistlib.load(handle).get('CFBundleIdentifier')
                except Exception:
                    return None
            path = os.path.dirname(path)
        return None

    def _clear_saved_state(self):
        bundle = self._bundle_id()
        if not bundle:
            return
        saved = os.path.expanduser('~/Library/Saved Application State/%s.savedState' % bundle)
        if os.path.isdir(saved):
            shutil.rmtree(saved, ignore_errors=True)

    def relaunch(self):
        """Replace the emulator process, keeping this run's directories.

        A state load makes RetroArch reinitialise its video, input, and audio
        drivers, and that reinitialisation sometimes ends the process. The
        emulator is disposable: the boot state Playproof pinned is the source
        of truth, and the caller restores it into the new process, so a
        replacement is invisible to the run.
        """
        self.kill(keep_run_dir=True)
        self.state_path = None
        self._boot(self.system_dir, self.video_driver)

    def _boot(self, system_dir, video_driver):
        failures = []
        for attempt in range(BOOT_ATTEMPTS):
            self.attempts = attempt + 1
            self.cmd_port = _free_port()
            self.remote_port = _free_port()
            self._cmd_addr = ('127.0.0.1', self.cmd_port)
            self._remote_addr = ('127.0.0.1', self.remote_port)
            try:
                if sys.platform == 'darwin':
                    self._clear_saved_state()
                self._launch(system_dir, video_driver)
                return
            except RetroArchError as error:
                failures.append('attempt %d: %s' % (attempt + 1, str(error).splitlines()[0]))
                self.kill(keep_run_dir=True)
        hint = ''
        if sys.platform == 'darwin':
            bundle = self._bundle_id() or 'com.libretro.RetroArch'
            hint = '\n' + MACOS_DEFAULTS_HINT % (bundle, bundle)
        raise RetroArchError(
            'RetroArch never came up in %d attempts:\n%s%s\nLog tail:\n%s'
            % (BOOT_ATTEMPTS, '\n'.join(failures), hint, self.log_tail()))

    # ---- process ---------------------------------------------------------

    def _config(self, system_dir, video_driver):
        directories = {
            'libretro_directory': 'cores',
            'libretro_info_path': 'info',
            'savestate_directory': 'states',
            'screenshot_directory': 'screenshots',
            'system_directory': 'system',
            'savefile_directory': 'saves',
            'cache_directory': 'cache',
            'assets_directory': 'assets',
            'bottom_assets_directory': 'assets/bottom',
            'core_assets_directory': 'assets/core',
            'log_dir': 'logs',
            'input_remapping_directory': 'remaps',
            'rgui_config_directory': 'menu',
            'rgui_browser_directory': 'browse',
            'overlay_directory': 'overlays',
            'osk_overlay_directory': 'overlays/osk',
            'video_shader_dir': 'shaders',
            'video_filter_dir': 'filters/video',
            'audio_filter_dir': 'filters/audio',
            'joypad_autoconfig_dir': 'autoconfig',
            'thumbnails_directory': 'thumbnails',
            'dynamic_wallpapers_directory': 'wallpapers',
            'runtime_log_directory': 'runtime',
            'recording_output_directory': 'records',
            'recording_config_directory': 'records/config',
            'playlist_directory': 'playlists',
            'content_favorites_directory': 'playlists',
            'content_history_directory': 'playlists',
            'content_image_history_directory': 'playlists',
            'content_music_history_directory': 'playlists',
            'content_video_directory': 'playlists',
            'content_database_path': 'database',
            'cheat_database_path': 'cheats',
        }
        settings = {}
        for key, relative in directories.items():
            path = os.path.join(self.run_dir, relative)
            os.makedirs(path, exist_ok=True)
            settings[key] = path
        if system_dir:
            settings['system_directory'] = os.path.abspath(system_dir)
        os.makedirs(os.path.join(self.run_dir, 'config'), exist_ok=True)
        for key, relative in FILE_KEYS.items():
            settings[key] = os.path.join(self.run_dir, relative)
        # RetroArch resolves a core against `libretro_directory` and its
        # metadata against `libretro_info_path` while the core is running.
        # Loading a core from outside that pair segfaults inside `retro_run`
        # on the first environment callback, so the run directory owns copies
        # of both and the caller's files are only ever read.
        self.core_path = os.path.join(settings['libretro_directory'], os.path.basename(self.core))
        shutil.copy(self.core, self.core_path)
        info_name = os.path.basename(os.path.splitext(self.core)[0] + '.info')
        core_dir = os.path.dirname(os.path.abspath(self.core))
        for candidate in (os.path.join(core_dir, info_name),
                          os.path.join(os.path.dirname(core_dir), 'info', info_name)):
            if os.path.exists(candidate):
                shutil.copy(candidate, settings['libretro_info_path'])
                break
        settings.update(FIXED_SETTINGS)
        settings['video_driver'] = video_driver
        settings['network_cmd_enable'] = 'true'
        settings['network_cmd_port'] = str(self.cmd_port)
        settings['network_remote_enable'] = 'true'
        settings['network_remote_base_port'] = str(self.remote_port)
        settings['network_remote_enable_user_p1'] = 'true'
        self.screenshot_dir = settings['screenshot_directory']
        self.savestate_dir = settings['savestate_directory']
        path = os.path.join(self.run_dir, 'config', 'retroarch.cfg')
        with open(path, 'w') as handle:
            for key in sorted(settings):
                handle.write('%s = "%s"\n' % (key, settings[key]))
        return path

    def _launch(self, system_dir, video_driver):
        config = self._config(system_dir, video_driver)
        console = open(self.console_path, 'ab')
        try:
            self.process = subprocess.Popen(
                [self.binary, '--config', config, '--libretro', self.core_path,
                 self.content, '--verbose', '--log-file', self.log_path],
                stdout=console, stderr=console,
            )
        finally:
            console.close()
        deadline = time.time() + BOOT_TIMEOUT
        status = None
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RetroArchError(
                    'RetroArch exited during boot (code %s). Log tail:\n%s'
                    % (self.process.returncode, self.log_tail()))
            status = self.command('GET_STATUS', timeout=0.5)
            if status and not status.startswith('GET_STATUS CONTENTLESS'):
                break
            status = None
        if not status:
            raise RetroArchError(
                'RetroArch loaded but never answered GET_STATUS within %.0fs'
                % BOOT_TIMEOUT)
        self.status = status

    def log_tail(self, limit=2000):
        parts = []
        for label, path in (('log', self.log_path), ('console', self.console_path)):
            try:
                with open(path, errors='replace') as handle:
                    text = handle.read()[-limit:]
            except OSError:
                text = ''
            if text.strip():
                parts.append('--- RetroArch %s ---\n%s' % (label, text))
        return '\n'.join(parts) if parts else '(RetroArch produced no output at all)'

    def kill(self, keep_run_dir=False):
        process = self.process
        self.process = None
        if process is not None and process.poll() is None:
            try:
                self.sock.sendto(b'QUIT', self._cmd_addr)
            except OSError:
                pass
            try:
                process.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                process.kill()
                try:
                    process.wait(timeout=5.0)
                except subprocess.TimeoutExpired:
                    pass
        if keep_run_dir or os.environ.get('PLAYPROOF_RETROARCH_KEEP') == '1':
            return
        try:
            shutil.rmtree(self.run_dir, ignore_errors=True)
        except OSError:
            pass

    def _alive(self):
        if self.process is None or self.process.poll() is not None:
            raise RetroArchError('RetroArch is no longer running. Log tail:\n%s' % self.log_tail())

    # ---- command interface ----------------------------------------------

    def send(self, message):
        self.sock.sendto(message.encode('ascii'), self._cmd_addr)

    def command(self, message, timeout=COMMAND_TIMEOUT, replies=1):
        """Send a datagram and collect `replies` answers, resending on loss.

        UDP on loopback is reliable in practice but not guaranteed, and the
        run loop only reads the socket once per iteration, so a resend loop
        is what makes the transport dependable.
        """
        deadline = time.time() + timeout
        out = []
        while time.time() < deadline:
            self.sock.sendto(message.encode('ascii'), self._cmd_addr)
            while len(out) < replies:
                try:
                    data, _ = self.sock.recvfrom(65535)
                except socket.timeout:
                    break
                out.append(data.decode('utf-8', 'replace').strip())
            if len(out) >= replies:
                return out[0] if replies == 1 else out
            out = []
            if self.process is not None and self.process.poll() is not None:
                self._alive()
        return None if replies == 1 else []

    def status_line(self):
        reply = self.command('GET_STATUS')
        if reply is None:
            self._alive()
            raise RetroArchError('RetroArch stopped answering GET_STATUS')
        return reply

    def pause(self):
        for _ in range(60):
            if 'PAUSED' in self.status_line():
                return
            self.send('PAUSE_TOGGLE')
            self.command('GET_STATUS')
        raise RetroArchError('RetroArch never reported PAUSED')

    def gap(self):
        """One run loop iteration with no frame advance.

        This is a BARRIER, not a courtesy. `FRAMEADVANCE` returns as soon as
        RetroArch accepts it, so without an intervening run-loop iteration the
        next advance can be issued while the previous frame is still settling.

        `command` returns None when it gives up, and this return used to be
        discarded, so a barrier that did not happen looked exactly like one
        that did. MEASURED: two same-process replays of the same boot state and
        the same inputs agreed byte for byte to emuFrame 811 and then differed
        on the channel values at IDENTICAL frame numbers, which is a run loop
        that did not settle rather than a frame that was miscounted.

        A missed barrier is now a failure with a name, because a replay that
        diverges silently is worse than one that stops.
        """
        if self.command(GAP_MSG) is None:
            self._alive()
            raise RetroArchError(
                'RetroArch stopped answering between frame advances, so the run loop was not'
                ' synchronised and a replay of this run would not reproduce it.%s'
                % self._stall_hint())

    def advance(self, frames):
        for _ in range(frames):
            if self.command(ADVANCE_MSG) is None:
                self._alive()
                raise RetroArchError(
                    'RetroArch is running but stopped answering during a frame advance.%s'
                    % self._stall_hint())
            self.gap()

    def _stall_hint(self):
        if sys.platform != 'darwin':
            return ''
        bundle = self._bundle_id() or 'com.libretro.RetroArch'
        return '\n' + MACOS_DEFAULTS_HINT % (bundle, bundle)

    def reset_core(self):
        self.send('RESET')
        for _ in range(3):
            self.command('GET_STATUS')

    # ---- memory ----------------------------------------------------------

    def read_blocks(self, blocks):
        """Read several memory blocks with one datagram.

        RetroArch echoes the address in every reply, so replies are matched
        back to blocks by address and their arrival order does not matter.
        """
        if not blocks:
            return {}
        message = '\n'.join('READ_CORE_MEMORY %x %d' % (start, length) for start, length in blocks)
        wanted = {start: length for start, length in blocks}
        deadline = time.time() + COMMAND_TIMEOUT
        while time.time() < deadline:
            found = {}
            self.sock.sendto(message.encode('ascii'), self._cmd_addr)
            while len(found) < len(wanted):
                try:
                    data, _ = self.sock.recvfrom(65535)
                except socket.timeout:
                    break
                parts = data.decode('ascii', 'replace').split()
                if len(parts) < 2 or parts[0] != 'READ_CORE_MEMORY':
                    continue
                try:
                    address = int(parts[1], 16)
                except ValueError:
                    continue
                if address not in wanted:
                    continue
                payload = parts[2:]
                if len(payload) != wanted[address]:
                    raise RetroArchError(
                        'READ_CORE_MEMORY %x %d refused by the core: %s'
                        % (address, wanted[address], ' '.join(payload) or 'no data'))
                found[address] = bytes(int(token, 16) for token in payload)
            if len(found) == len(wanted):
                return found
            self._alive()
        raise RetroArchError('RetroArch did not answer READ_CORE_MEMORY for %d blocks' % len(blocks))

    def write_zeros(self, start, size):
        """Zero a mapped region with WRITE_CORE_MEMORY, in datagram-sized runs.

        RetroArch reads a command datagram into a 2048-byte buffer, so each
        request carries at most a few hundred bytes written as hex pairs.
        A core that maps none of the region answers with a refusal, which is
        not fatal: the caller only asks for regions it wants cleared.
        """
        written = 0
        chunk = 512
        for offset in range(0, size, chunk):
            length = min(chunk, size - offset)
            message = 'WRITE_CORE_MEMORY %x%s' % (start + offset, ' 00' * length)
            reply = self.command(message)
            if reply is None:
                self._alive()
                raise RetroArchError('RetroArch stopped answering WRITE_CORE_MEMORY')
            parts = reply.split()
            if len(parts) >= 3 and parts[2].isdigit():
                written += int(parts[2])
            else:
                return written
        return written

    # ---- screenshot ------------------------------------------------------

    def screenshot(self):
        for stale in glob.glob(os.path.join(self.screenshot_dir, '*.png')):
            try:
                os.remove(stale)
            except OSError:
                pass
        deadline = time.time() + COMMAND_TIMEOUT
        self.send('SCREENSHOT')
        while time.time() < deadline:
            for path in glob.glob(os.path.join(self.screenshot_dir, '*.png')):
                try:
                    with open(path, 'rb') as handle:
                        data = handle.read()
                except OSError:
                    continue
                # RetroArch writes the file from a task, so a partial read is
                # possible; the IEND chunk marks a finished PNG.
                if data.endswith(b'IEND\xaeB`\x82'):
                    try:
                        os.remove(path)
                    except OSError:
                        pass
                    return data
            self._alive()
            time.sleep(0.004)
        raise RetroArchError('RetroArch wrote no screenshot into %s' % self.screenshot_dir)

    # ---- save states -----------------------------------------------------

    def _state_files(self):
        return sorted(
            path for path in glob.glob(os.path.join(self.savestate_dir, '**', '*'), recursive=True)
            if os.path.isfile(path))

    def _log_size(self):
        try:
            return os.path.getsize(self.log_path)
        except OSError:
            return 0

    def _log_since(self, offset):
        try:
            with open(self.log_path) as handle:
                handle.seek(offset)
                return handle.read()
        except OSError:
            return ''

    def save_state(self):
        """Save the current state, and report how many frames that cost.

        SAVE_STATE only fires when it travels with FRAMEADVANCE (measured fact
        5), and even then a datagram can be dropped, so this retries. Each
        attempt runs exactly one frame, so the caller is told the total: the
        saved state is the one that held `advanced - 1` frames after the call,
        and the emulator is left `advanced` frames after it.

        FAST_FORWARD_HOLD is deliberately absent here. It speeds plain frame
        advance up, but on a datagram that also carries SAVE_STATE the hotkey
        was measured not to fire at all.
        """
        for stale in self._state_files():
            try:
                os.remove(stale)
            except OSError:
                pass
        advanced = 0
        for _ in range(STATE_ATTEMPTS):
            self.command('FRAMEADVANCE\nSAVE_STATE\nGET_STATUS')
            self.gap()
            advanced += 1
            blob = self._await_state_file()
            if blob is not None:
                return blob, advanced
            self._alive()
        raise RetroArchError(
            'RetroArch wrote no save state into %s after %d attempts. Log tail:\n%s'
            % (self.savestate_dir, STATE_ATTEMPTS, self.log_tail()))

    def _await_state_file(self, timeout=1.5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            found = self._state_files()
            if found:
                self.state_path = found[0]
                # The save runs as a task; wait until the size settles so a
                # partly written file is never read back as a checkpoint.
                previous = -1
                for _ in range(400):
                    size = os.path.getsize(self.state_path)
                    if size == previous and size > 0:
                        with open(self.state_path, 'rb') as handle:
                            return handle.read()
                    previous = size
                    time.sleep(0.005)
            self.gap()
        return None

    def load_state(self, blob):
        """Restore a saved state and land on the same frame `save_state` left.

        RetroArch's own log line is the acknowledgement the command interface
        does not give. Frames consumed by a dropped attempt do not matter,
        because the successful load discards whatever they produced.
        """
        if self.state_path is None:
            raise RetroArchError('no save state has been written yet, so none can be restored')
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, 'wb') as handle:
            handle.write(blob)
        for _ in range(STATE_ATTEMPTS):
            mark = self._log_size()
            self.command('FRAMEADVANCE\nLOAD_STATE\nGET_STATUS')
            self.gap()
            deadline = time.time() + 1.5
            while time.time() < deadline:
                if 'Loading state' in self._log_since(mark):
                    # LOAD_STATE consumes the frame that carried it; one more
                    # advance puts the emulator where save_state left it.
                    self.advance(1)
                    return
                self.gap()
            self._alive()
        raise RetroArchError(
            'RetroArch did not load the save state after %d attempts. Log tail:\n%s'
            % (STATE_ATTEMPTS, self.log_tail()))

    # ---- remote gamepad --------------------------------------------------

    def pad(self, button_id, pressed):
        self.sock.sendto(
            REMOTE_MESSAGE.pack(0, RETRO_DEVICE_JOYPAD, 0, button_id, 1 if pressed else 0),
            self._remote_addr)


class Worker:
    def __init__(self):
        self.emulator = None
        self.channels = []
        self.blocks = []
        self.buttons = []
        self.screen_image = False
        self.frames = 4
        self.press_frames = 2
        self.boot_frames = 60
        self.clear_regions = []
        self.seed = 0
        self.gen = 0
        self.frame = 0
        self.boot_blob = None
        self.boot_frame = 0
        self.history = []
        self.held = set()
        self._cache = None
        self._shot = None
        self._content_sha = None

    # ---- lifecycle -------------------------------------------------------

    def boot(self, binary, core, content, channels=None, inputs=None, frames=4,
             press_frames=None, boot_frames=60, system_dir=None,
             video_driver='null', seed=0, clear_regions=None, screen_image=False):
        self.screen_image = bool(screen_image)
        self.frames = max(1, int(frames))
        self.press_frames = max(1, min(self.frames, int(press_frames) if press_frames is not None else min(2, self.frames)))
        self.boot_frames = max(0, int(boot_frames))
        self.seed = int(seed)
        self.clear_regions = [(int(a), int(b)) for a, b in (clear_regions or [])]
        self.channels = self._normalize_channels(channels or [])
        self.blocks = self._plan_reads(self.channels)
        self.buttons = self._normalize_buttons(inputs)
        with open(content, 'rb') as handle:
            self._content_sha = hashlib.sha256(handle.read()).hexdigest()
        self.emulator = RetroArch(binary, core, content, system_dir=system_dir, video_driver=video_driver)
        self.emulator.pause()
        self._power_on()
        return self.identity()

    def _power_on(self):
        """Pin the boot state the whole run replays from.

        RetroArch starts emulating the moment content loads, so the instant a
        PAUSE_TOGGLE lands depends on wall clock. RESET returns the core to
        power on and `boot_frames` fixed advances give the game its own
        initialisation, which is what makes the boot state equal across
        processes rather than equal to whatever the launch race produced.

        The result is saved once, and every reset restores that save. Re-running
        the reset instead is NOT equivalent: a core reset does not clear video
        memory or the picture-processing state, so a second reset lands the
        title-screen animation at a phase that depends on the run before it.
        Measured over 41 evidence snapshots between two separately launched
        emulators, re-running the reset reproduces work RAM 40 times but the
        screen only twice, while restoring this save reproduces both every time.
        """
        self._release_all()
        # A core reset does not clear the memory the console powered on with,
        # so without this the boot state inherits whatever the launch race
        # left behind and two processes can pin two different boot states.
        # Zeroing the caller-named regions first makes the boot state a
        # function of the content alone.
        for start, size in self.clear_regions:
            self.emulator.write_zeros(start, size)
        self.emulator.reset_core()
        self.emulator.advance(self.boot_frames)
        self.boot_blob, advanced = self.emulator.save_state()
        # The saved state held one frame before the emulator now is.
        self.boot_frame = self.boot_frames + advanced - 1
        self.frame = self.boot_frame + 1
        self.gen += 1
        self._cache = None

    def reset(self, seed=None):
        if seed is not None:
            self.seed = int(seed)
        if self.boot_blob is None:
            raise RetroArchError('reset before boot')
        self._restore_boot()
        self.frame = self.boot_frame + 1
        self.gen += 1
        self._cache = None
        return {'gen': self.gen, 'frame': self.frame}

    def _relaunch_onto_boot(self):
        self.held = set()
        self.emulator.relaunch()
        self.emulator.pause()
        self.emulator.reset_core()
        self.emulator.advance(self.boot_frames)
        # Establishes the path RetroArch names this content's state.
        self.emulator.save_state()
        self.held = set()
        self.emulator.load_state(self.boot_blob)
        self.frame = self.boot_frame + 1
        self.history = []

    def _restore_boot(self):
        """Put the emulator back on the pinned boot state.

        Every reset returns to the same instant, so an emulator that died
        serving the last one can simply be replaced: the new process is reset,
        run forward far enough to own a save-state path, and then given the
        SAME pinned blob. The run never sees a different boot state, which is
        what keeps a replacement out of the evidence.
        """
        self.held = set()
        try:
            self._release_all()
            self.emulator.load_state(self.boot_blob)
        except RetroArchError:
            self._relaunch_onto_boot()
        self.history = []

    def identity(self):
        return {
            'gen': self.gen,
            'frame': self.frame,
            'core': os.path.basename(self.emulator.core),
            'content': os.path.basename(self.emulator.content),
            'contentSha': self._content_sha,
            # Live status, not the one the launch saw: identity() is
            # reported after the boot state is pinned, so a caller can
            # see that the emulator really is paused and frame stepped.
            'status': self.emulator.status_line(),
            'buttons': list(self.buttons),
            'inputs': self.vocabulary(),
            'channels': [channel['id'] for channel in self.channels],
            'frames': self.frames,
            'pressFrames': self.press_frames,
            'bootFrames': self.boot_frames,
            'clearRegions': [[start, size] for start, size in self.clear_regions],
            'seed': self.seed,
            'pid': self.emulator.process.pid if self.emulator.process else None,
            'screenImage': self.screen_image,
            'frameText': self.frame_text(),
            **({} if not self.screen_image else {'frameImage': self.screen_rgb()}),
        }

    def close(self):
        if self.emulator is not None:
            self.emulator.kill()
            self.emulator = None

    # ---- channels --------------------------------------------------------

    @staticmethod
    def _normalize_channels(channels):
        out = []
        for channel in channels:
            if 'addresses' in channel:
                addresses = [int(a) for a in channel['addresses']]
                if not addresses:
                    raise ValueError('channel %r declares no addresses' % channel.get('id'))
                span = list(range(addresses[0], addresses[0] + len(addresses)))
                if addresses != span:
                    raise ValueError(
                        'channel %r reads non-contiguous addresses %s; RetroArch reads a block'
                        % (channel.get('id'), addresses))
                address, size = addresses[0], len(addresses)
            else:
                address = int(channel['address'])
                size = int(channel.get('size', 1))
            decode = channel.get('decode', 'bin')
            if decode not in ('bin', 'bcd'):
                raise ValueError('channel %r has unknown decode %r' % (channel.get('id'), decode))
            if size < 1 or size > MAX_READ_BYTES:
                raise ValueError('channel %r reads %d bytes; 1..%d allowed' % (channel.get('id'), size, MAX_READ_BYTES))
            identifier = channel.get('id') or 'ch_%x' % address
            out.append({'id': identifier, 'address': address, 'size': size, 'decode': decode})
        return out

    @staticmethod
    def _plan_reads(channels):
        """Cover every channel with as few capped block reads as possible."""
        if not channels:
            return []
        spans = sorted((c['address'], c['address'] + c['size']) for c in channels)
        blocks = []
        start, end = spans[0]
        for lo, hi in spans[1:]:
            if hi - start <= MAX_READ_BYTES:
                end = max(end, hi)
            else:
                blocks.append((start, end - start))
                start, end = lo, hi
        blocks.append((start, end - start))
        return blocks

    def _read_channels(self):
        if not self.channels:
            return {}
        found = self.emulator.read_blocks(self.blocks)
        starts = sorted(found)
        state = {}
        for channel in self.channels:
            block = None
            for start in starts:
                if start <= channel['address'] and channel['address'] + channel['size'] <= start + len(found[start]):
                    block = (start, found[start])
                    break
            if block is None:
                raise RetroArchError('no memory block covers channel %s' % channel['id'])
            offset = channel['address'] - block[0]
            raw = block[1][offset:offset + channel['size']]
            total = 0
            base = 100 if channel['decode'] == 'bcd' else 256
            for byte in raw:
                total = total * base + (_bcd(byte) if channel['decode'] == 'bcd' else byte)
            state[channel['id']] = total
        return state

    # ---- inputs ----------------------------------------------------------

    @staticmethod
    def _normalize_buttons(inputs):
        if not inputs:
            return ['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select']
        out = []
        for name in inputs:
            key = str(name).strip().lower()
            if key not in JOYPAD_IDS:
                raise ValueError('unknown libretro button %r; known: %s' % (name, ', '.join(sorted(JOYPAD_IDS))))
            if key not in out:
                out.append(key)
        if not out:
            raise ValueError('the input vocabulary is empty')
        return out

    def vocabulary(self):
        """Advertised words. Any `+`-joined button subset is also accepted."""
        directions = [b for b in self.buttons if b in DIRECTIONS]
        actions = [b for b in self.buttons if b not in DIRECTIONS and b not in NON_ACTION_BUTTONS]
        words = [NOOP] + list(self.buttons)
        for direction in directions:
            for action in actions[:MAX_VOCABULARY_ACTIONS]:
                words.append('%s+%s' % (direction, action))
        return words

    def _wanted(self, word):
        """Unknown names are no-ops: Playproof never treats an agent typo as a cheat."""
        wanted = set()
        if not isinstance(word, str):
            return wanted
        for part in word.lower().split('+'):
            part = part.strip()
            if part in ('', NOOP.lower()):
                continue
            if part in self.buttons:
                wanted.add(JOYPAD_IDS[part])
        return wanted

    def _set_pad(self, wanted):
        """Send one message per button that changes, then drain the queue.

        RetroArch reads at most one remote message per poll, so a combo needs
        one poll per changed button before the first frame it should affect.
        """
        changed = (self.held | wanted) - (self.held & wanted)
        for button_id in sorted(changed):
            self.emulator.pad(button_id, button_id in wanted)
        for _ in range(len(changed)):
            self.emulator.gap()
        self.held = set(wanted)

    def _release_all(self):
        self._set_pad(set())

    # ---- evidence --------------------------------------------------------

    def _evidence(self):
        key = (self.gen, self.frame)
        if self._cache is not None and self._cache[0] == key:
            # KNOWN DEFECT, deliberately left alone here: this returns the whole
            # cache entry rather than its evidence member, so a SECOND evidence
            # call at one emulator instant answers with a list. `makeRetroArch`
            # reads the boot evidence through exactly that path, so today the
            # contract baseline is empty and `channelMarks` falls back to the
            # discovery document's declared value.
            #
            # Correcting it is a one-line change that alters which milestones
            # this adapter derives — measured on gambatte with Libbet, a
            # correct baseline makes `ch_c581_c582` stop firing at all, because
            # that channel never leaves the value gambatte powers on with.
            # That is a benchmark change and belongs in its own commit with its
            # own cross-emulator measurement, not in a change about what the
            # agent can see.
            return self._cache[1]
        engine = self._read_channels()
        engine['emuFrame'] = self.frame
        shot = self.emulator.screenshot()
        width, height, bpp, pixels = _decode_png(shot)
        # The hash covers decoded pixels, never the PNG file: RetroArch picks
        # filters per scanline, so two builds can encode one image two ways.
        frame_hash = hashlib.sha256(pixels).hexdigest()
        lum = _luminance(width, height, bpp, pixels)
        cells = _cells(width, height, lum)
        flat = [value for row in cells for value in row]
        evidence = {
            'engineState': engine,
            'frameHash': frame_hash,
            'frameState': {
                'lumMean': sum(flat) // len(flat),
                'lumMin': min(flat),
                'darkCells': sum(1 for value in flat if value <= 128),
                'inkCells': sum(1 for value in flat if value <= 64),
            },
        }
        self._cache = (key, (evidence, cells))
        self._shot = (key, shot, int(width), int(height))
        return evidence

    def screen_rgb(self):
        """The screenshot RetroArch already wrote, republished byte for byte.

        The evidence path hashes the DECODED pixels rather than this file,
        because RetroArch picks a filter per scanline and two builds can encode
        one image two ways. That is exactly why republishing the file is safe:
        the bytes an agent sees are not the bytes a verifier recomputes.
        """
        if not self.screen_image:
            return None
        self._evidence()
        _key, shot, width, height = self._shot
        if max(width, height) > MAX_SCREEN_DIMENSION:
            raise ValueError(
                'core renders %dx%d, over the %dpx observation bound'
                % (width, height, MAX_SCREEN_DIMENSION))
        return {
            'mediaType': 'image/png',
            'base64': base64.b64encode(shot).decode('ascii'),
            'width': width,
            'height': height,
        }

    def frame_text(self):
        self._evidence()
        cells = self._cache[1][1]
        engine = self._cache[1][0]['engineState']
        lines = [''.join(GLYPHS[GLYPH_RAMP[min(255, value)]] for value in row) for row in cells]
        shown = [(k, v) for k, v in engine.items() if k != 'emuFrame'][:MAX_SUMMARY_CHANNELS]
        lines.append(' '.join('%s=%s' % (k, v) for k, v in shown)[:160])
        return '\n'.join(lines)

    # ---- transitions -----------------------------------------------------

    def _apply(self, word):
        wanted = self._wanted(word)
        self._set_pad(wanted)
        self.emulator.advance(self.press_frames)
        self._release_all()
        self.emulator.advance(self.frames - self.press_frames)
        self.frame += self.frames
        self.history.append(word)
        self._cache = None

    def step(self, word):
        """Advance one Playproof input.

        An emulator that dies here ends the run. Replacing it and replaying the
        inputs so far LOOKS equivalent — the position is a function of the boot
        state and the input log — but it was measured not to be: runs that
        replaced an emulator mid-flight produced evidence that a second replay
        in the same worker did not reproduce. Evidence a verifier cannot
        recompute is worse than no evidence, so this fails loudly instead.
        A reset may still replace the emulator, because a reset returns to the
        pinned boot state and has no evidence to invalidate.
        """
        self._apply(word)
        evidence = self._evidence()
        result = {'frame': self.frame, 'evidence': evidence, 'frameText': self.frame_text()}
        if self.screen_image:
            result['frameImage'] = self.screen_rgb()
        return result

    def snapshot(self):
        self._release_all()
        blob, advanced = self.emulator.save_state()
        frame = self.frame + advanced - 1
        # The save and the matching restore both leave the emulator one frame
        # past the snapshotted instant, so a round trip keeps the counter true.
        self.frame = frame + 1
        self._cache = None
        header = SNAPSHOT_HEADER.pack(SNAPSHOT_MAGIC, SNAPSHOT_VERSION, frame)
        return {
            'bytes': base64.b64encode(zlib.compress(header + blob, 6)).decode('ascii'),
            'frame': frame,
            'encoding': 'deflate',
        }

    def restore(self, blob):
        if isinstance(blob, dict):
            blob = blob.get('bytes', '')
        try:
            raw = zlib.decompress(base64.b64decode(blob))
        except (zlib.error, ValueError) as error:
            raise ValueError('blob is not a Playproof RetroArch checkpoint: %s' % error)
        if len(raw) < SNAPSHOT_HEADER.size:
            raise ValueError('blob is not a Playproof RetroArch checkpoint')
        magic, version, frame = SNAPSHOT_HEADER.unpack_from(raw)
        if magic != SNAPSHOT_MAGIC or version != SNAPSHOT_VERSION:
            raise ValueError('blob is not a Playproof RetroArch checkpoint')
        self._release_all()
        self.emulator.load_state(raw[SNAPSHOT_HEADER.size:])
        self.frame = frame + 1
        self._cache = None
        return {'gen': self.gen, 'frame': self.frame}


def dispatch(worker, method, params):
    if method == 'boot':
        return worker.boot(
            binary=params['binary'],
            core=params['core'],
            content=params['content'],
            channels=params.get('channels'),
            inputs=params.get('inputs'),
            frames=params.get('frames', 4),
            press_frames=params.get('pressFrames'),
            boot_frames=params.get('bootFrames', 60),
            system_dir=params.get('systemDir'),
            video_driver=params.get('videoDriver', 'null'),
            seed=params.get('seed', 0),
            clear_regions=params.get('clearRegions'),
            screen_image=params.get('screenImage', False),
        )
    if method == 'reset':
        return worker.reset(params.get('seed'))
    if method == 'step':
        return worker.step(params.get('input'))
    if method == 'evidence':
        return worker._evidence()
    if method == 'frame':
        image = worker.screen_rgb()
        return {'text': worker.frame_text(), **({} if image is None else {'image': image})}
    if method == 'inputs':
        return {'inputs': worker.vocabulary(), 'buttons': list(worker.buttons)}
    if method in ('snapshot', 'checkpoint'):
        return worker.snapshot()
    if method == 'restore':
        return worker.restore(params.get('state'))
    raise ValueError('unknown method %s' % method)


def serve(transport):
    fin, fout = transport
    worker = Worker()
    for line in fin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            method = request['method']
            params = request.get('params') or {}
            if method == 'shutdown':
                # Kill RetroArch BEFORE replying. The client kills this process
                # as soon as the reply arrives, and an emulator killed after
                # that reply would outlive the run.
                worker.close()
                fout.write(json.dumps({'id': request.get('id'), 'ok': True, 'result': {'bye': True}}) + '\n')
                fout.flush()
                return
            result = dispatch(worker, method, params)
            fout.write(json.dumps({'id': request.get('id'), 'ok': True, 'result': result}) + '\n')
            fout.flush()
        except Exception as error:  # noqa: BLE001 - every failure is a protocol reply
            fout.write(json.dumps({
                'id': request.get('id', -1), 'ok': False,
                'error': '%s: %s' % (type(error).__name__, error),
            }) + '\n')
            fout.flush()
    worker.close()


def main():
    worker_holder = {}

    def terminate(_signum, _frame):
        holder = worker_holder.get('worker')
        if holder is not None:
            holder.close()
        sys.exit(1)

    for name in ('SIGTERM', 'SIGINT', 'SIGHUP'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), terminate)

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


if __name__ == '__main__':
    main()
