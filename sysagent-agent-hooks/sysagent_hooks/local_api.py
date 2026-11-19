"""Read-only client for the SysAgent local query API (cache only, never triggers collection)."""

import glob
import json
import os
import re
import stat
import urllib.request

_BASE_URL = re.compile(r'^http://127\.0\.0\.1:([1-9][0-9]{0,4})$')
_TOKEN = re.compile(r'^[\x21-\x7e]{16,512}$')
_UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
_MAX_DISCOVERY = 16 * 1024
_MAX_RESPONSE = 1024 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


# No proxy: environment proxies would forward the Bearer token off the loopback interface.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def discovery_directories(env=None):
    env = os.environ if env is None else env
    config = env.get('XDG_CONFIG_HOME') or ''
    if not os.path.isabs(config):
        config = os.path.join(os.path.expanduser('~'), '.config')
    pattern = os.path.join(config, '*', 'User', 'globalStorage', 'sysagent-local.sysagent-ide', 'local-api')
    return [os.path.join(config, 'sysagent-idc', 'local-api')] + sorted(glob.glob(pattern))


def _private(info, kind):
    return kind(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077


def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _read_endpoint(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'rb') as file:
        info = os.fstat(file.fileno())
        if not _private(info, stat.S_ISREG) or info.st_nlink != 1:
            return None
        data = file.read(_MAX_DISCOVERY + 1)
    if len(data) > _MAX_DISCOVERY:
        return None
    value = json.loads(data.decode('utf-8'))
    if not isinstance(value, dict):
        return None
    base_url, token, pid = value.get('base_url'), value.get('token'), value.get('pid')
    instance = value.get('instance_id')
    match = _BASE_URL.fullmatch(base_url) if isinstance(base_url, str) else None
    if (not match or int(match.group(1)) > 65535 or not isinstance(token, str) or not _TOKEN.fullmatch(token)
            or not isinstance(instance, str) or not _UUID.fullmatch(instance)
            or not isinstance(pid, int) or isinstance(pid, bool) or pid < 1 or not _alive(pid)):
        return None
    started = value.get('started_at') if isinstance(value.get('started_at'), str) else ''
    return started, {'base_url': base_url, 'token': token, 'instance_id': instance}


def endpoints(env=None):
    """Live endpoints, newest first. Unsafe or stale discovery files are ignored."""
    found = []
    for directory in discovery_directories(env):
        try:
            parent = os.lstat(os.path.dirname(directory))
            if (not _private(os.lstat(directory), stat.S_ISDIR) or not stat.S_ISDIR(parent.st_mode)
                    or parent.st_uid != os.getuid() or parent.st_mode & 0o022):
                continue
            names = sorted(os.listdir(directory))
        except OSError:
            continue
        for name in names:
            if not name.endswith('.json'):
                continue
            try:
                endpoint = _read_endpoint(os.path.join(directory, name))
            except (OSError, ValueError):
                continue
            if endpoint:
                found.append(endpoint)
    found.sort(key=lambda item: item[0], reverse=True)
    return [endpoint for _, endpoint in found]


def get(endpoint, route, timeout=1.0):
    request = urllib.request.Request(endpoint['base_url'] + route, headers={
        'Authorization': 'Bearer ' + endpoint['token'], 'Accept': 'application/json',
    })
    with _OPENER.open(request, timeout=timeout) as response:
        data = response.read(_MAX_RESPONSE + 1)
    if len(data) > _MAX_RESPONSE:
        raise ValueError('local API response too large')
    value = json.loads(data.decode('utf-8'))
    if (not isinstance(value, dict) or value.get('schema_version') != '1.0'
            or not isinstance(value.get('meta'), dict) or value['meta'].get('instance_id') != endpoint['instance_id']):
        raise ValueError('incompatible local API response')
    return value
