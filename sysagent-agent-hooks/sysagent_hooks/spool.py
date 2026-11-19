"""Append-only, per-user, metadata-only spool shared by every agent adapter."""

import fcntl
import hashlib
import hmac
import json
import os
import re
import stat
import time

MAX_BYTES = 1024 * 1024
MAX_LINE = 2048
CURRENT = 'events.jsonl'
ROTATED = 'events.1.jsonl'
LOCK = '.lock'
# Several enabled copies of the plugin (Qoder app + IDE, or one package installed twice) each receive
# the same payload for one event; a short-lived keyed ledger lets only the first copy record it.
DEDUP = '.dedup'
DEDUP_KEY = '.dedup-key'
DEDUP_WINDOW = 5.0
DEDUP_ENTRIES = 256
_DEDUP_LINE = re.compile(r'^(\d{1,12}(?:\.\d{1,6})?) ([0-9a-f]{32})$')


def spool_directory(env=None):
    env = os.environ if env is None else env
    base = env.get('XDG_STATE_HOME') or ''
    if not os.path.isabs(base):
        base = os.path.join(os.path.expanduser('~'), '.local', 'state')
    return os.path.join(base, 'sysagent', 'agent-hooks')


def _owned_directory(path, forbidden):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    # Never repair existing permissions; the reader applies the same rule and rejects them.
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & forbidden:
        raise PermissionError('unsafe spool directory')


def _prepare(directory):
    parent = os.path.dirname(directory)
    os.makedirs(os.path.dirname(parent), mode=0o700, exist_ok=True)
    _owned_directory(parent, 0o022)
    _owned_directory(directory, 0o077)


def _open(path, flags):
    return os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)


def _private_file(descriptor):
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise PermissionError('unsafe spool file')


def _write_all(descriptor, data):
    while data:
        written = os.write(descriptor, data)
        if written <= 0:
            raise OSError('incomplete spool write')
        data = data[written:]


def _secret(directory):
    descriptor = _open(os.path.join(directory, DEDUP_KEY), os.O_RDWR | os.O_CREAT | os.O_NONBLOCK)
    try:
        _private_file(descriptor)
        secret = os.read(descriptor, 33)
        if not secret:
            secret = os.urandom(32)
            _write_all(descriptor, secret)
        if len(secret) != 32:
            raise ValueError('invalid dedup key')
        return secret
    finally:
        os.close(descriptor)


def _first_seen(directory, fingerprint, commit=False):
    """Check under the spool lock; commit the identity only after its record was appended."""
    key = hmac.new(_secret(directory), fingerprint, hashlib.sha256).hexdigest()[:32]
    now = int(time.time() * 1000) / 1000.0
    descriptor = _open(os.path.join(directory, DEDUP), os.O_RDWR | os.O_CREAT | os.O_NONBLOCK)
    try:
        _private_file(descriptor)
        seen = {}
        for line in os.read(descriptor, DEDUP_ENTRIES * 64).decode('ascii', 'replace').splitlines():
            match = _DEDUP_LINE.match(line)
            # Drop expired entries and ones beyond the window (clock moved back or tampered).
            if match and now < float(match.group(1)) <= now + DEDUP_WINDOW:
                seen[match.group(2)] = float(match.group(1))
        if key in seen:
            return False
        if not commit:
            return True
        seen[key] = now + DEDUP_WINDOW
        kept = sorted(seen.items(), key=lambda item: item[1])[-DEDUP_ENTRIES:]
        os.ftruncate(descriptor, 0)
        os.lseek(descriptor, 0, os.SEEK_SET)
        _write_all(descriptor, ''.join('%.3f %s\n' % (expires, name) for name, expires in kept).encode('ascii'))
        return True
    finally:
        os.close(descriptor)


def append(record, directory, fingerprint=None):
    """Append one record; returns False if `fingerprint` shows another plugin copy already recorded it."""
    from . import event, history

    record = event.validate(record)
    line = (json.dumps(record, ensure_ascii=True, separators=(',', ':')) + '\n').encode('ascii')
    if len(line) > MAX_LINE:
        raise ValueError('spool record too large')
    _prepare(directory)
    lock = _open(os.path.join(directory, LOCK), os.O_RDWR | os.O_CREAT | os.O_NONBLOCK)
    connection = None
    try:
        _private_file(lock)
        fcntl.flock(lock, fcntl.LOCK_EX)
        connection = history.connect(directory)
        # Recover an appended-but-not-counted line, and migrate ALL existing details before rotation or dedup.
        history.import_spool(connection, directory)
        history.check_event(connection, record)
        remember = fingerprint is not None
        if remember:
            try:
                if not _first_seen(directory, fingerprint):
                    return False
            except (OSError, ValueError):
                remember = False  # An unusable ledger must not lose events: record, at worst, a duplicate.
        current = os.path.join(directory, CURRENT)
        separator = b''
        try:
            existing = _open(current, os.O_RDONLY | os.O_NONBLOCK)
            try:
                _private_file(existing)
                info = os.fstat(existing)
                if info.st_size and os.pread(existing, 1, info.st_size - 1) != b'\n':
                    separator = b'\n'
            finally:
                os.close(existing)
            if info.st_size + len(separator) + len(line) > MAX_BYTES:
                rotated = os.path.join(directory, ROTATED)
                try:
                    previous = _open(rotated, os.O_RDONLY | os.O_NONBLOCK)
                    try:
                        _private_file(previous)
                    finally:
                        os.close(previous)
                except FileNotFoundError:
                    pass
                os.replace(current, rotated)
                separator = b''
        except FileNotFoundError:
            pass
        descriptor = _open(current, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NONBLOCK)
        try:
            _private_file(descriptor)
            _write_all(descriptor, separator + line)
            os.fsync(descriptor)
            history._sync_directory(directory)
            history.record_append(connection, directory, record, descriptor)
        finally:
            os.close(descriptor)
        if remember:
            try:
                _first_seen(directory, fingerprint, commit=True)
            except (OSError, ValueError):
                pass  # The record is already saved; failed bookkeeping permits a future duplicate.
    finally:
        if connection is not None:
            connection.close()
        os.close(lock)
    return True
