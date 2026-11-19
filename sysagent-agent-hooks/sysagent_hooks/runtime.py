"""Hook entry point: sysagent_hook <agent> [native-event] < payload.json

Never blocks or fails the agent: every error is swallowed and the exit status is always 0.
"""

import json
import os
import sys

from . import context, event, spool
from .adapters import ADAPTERS

MAX_INPUT = 16 * 1024 * 1024


def _read_payload(stream):
    data = stream.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        while stream.read(1024 * 1024):
            pass
        return {}
    try:
        value = json.loads(data.decode('utf-8')) if data.strip() else {}
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _agent_name(package):
    """Use verified Linux host executable names for Qoder labels; otherwise keep the package label."""
    if package not in ('qoder', 'qoder-ide') or not sys.platform.startswith('linux'):
        return package
    pid = os.getppid()
    for _ in range(8):
        if pid <= 1:
            break
        try:
            executable = os.path.basename(os.readlink('/proc/%d/exe' % pid))
        except OSError:
            executable = None
        if executable in ('qoder', 'qoder-ide'):
            return executable
        try:
            with open('/proc/%d/stat' % pid, encoding='utf-8') as file:
                pid = int(file.read(4096).rsplit(')', 1)[1].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return package


def run(argv, stdin, stdout, env=None):
    adapter = ADAPTERS.get(argv[0]) if argv else None
    if adapter is None:
        return
    payload = _read_payload(stdin)
    native = argv[1] if len(argv) > 1 else payload.get('hook_event_name')
    if not isinstance(native, str):
        return
    fields = adapter.normalize(native, payload)
    if fields is not None:
        # Agent-independent identity of this event occurrence, so the Qoder app and IDE packages
        # (or a package installed twice) record and inject it once. Empty payloads carry no identity.
        family = 'qoder' if adapter.name in ('qoder', 'qoder-ide') else adapter.name
        fingerprint = json.dumps([family, native, payload], sort_keys=True, separators=(',', ':')).encode('ascii') if payload else None
        try:
            if not spool.append(event.build(_agent_name(adapter.name), **fields), spool.spool_directory(env), fingerprint):
                return
        except Exception:
            pass
    if adapter.wants_context(native):
        text = context.local_health_context(env)
        rendered = adapter.render_context(native, text) if text else None
        if rendered:
            stdout.write(rendered + '\n')
            stdout.flush()


def main(argv=None, stdin=None, stdout=None, env=None):
    try:
        run(sys.argv[1:] if argv is None else argv,
            sys.stdin.buffer if stdin is None else stdin,
            sys.stdout if stdout is None else stdout, env)
    except Exception:
        pass
    return 0
