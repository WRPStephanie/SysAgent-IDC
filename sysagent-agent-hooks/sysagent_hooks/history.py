"""Unbounded, metadata-only cumulative history. Writers hold the existing spool flock."""

import hashlib
import json
import os
import sqlite3
import stat
from datetime import datetime, timezone
from urllib.parse import quote

from . import event, spool

DATABASE = 'history.sqlite3'
REASON = '累计已启用；已迁移当前存量，启用前已删除记录无法恢复'
ACTIVITY_REASON = '累计聚合已启用；升级前已轮转明细无法恢复'
TOTAL_KEYS = ('sessions', 'events', 'prompts', 'toolStarts', 'toolEnds', 'toolFailures',
              'interrupts', 'permissionDenied', 'turnFailures', 'openTools')
MAX_INTEGER = (1 << 63) - 1
_COLUMNS = ', '.join('"%s"' % key for key in TOTAL_KEYS)
_SELECT = 'SELECT ' + _COLUMNS + ', "start", "end" FROM totals WHERE id = 1'
_UPDATE = 'UPDATE totals SET ' + ', '.join('"%s" = ?' % key for key in TOTAL_KEYS) + ', "start" = ?, "end" = ? WHERE id = 1'
_COUNTS = {'prompt_submit': 'prompts', 'tool_start': 'toolStarts', 'tool_end': 'toolEnds',
           'permission_denied': 'permissionDenied', 'turn_failure': 'turnFailures'}


def _directory_safe(directory):
    for path, forbidden in ((os.path.dirname(directory), 0o022), (directory, 0o077)):
        info = os.lstat(path)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & forbidden:
            raise PermissionError('unsafe history directory')


def _checked_open(path, flags):
    descriptor = spool._open(path, flags | os.O_NONBLOCK)
    try:
        spool._private_file(descriptor)
        info = os.fstat(descriptor)
        after = os.lstat(path)
        if (info.st_dev, info.st_ino) != (after.st_dev, after.st_ino) or stat.S_ISLNK(after.st_mode):
            raise PermissionError('history path changed')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _sidecars_safe(directory):
    for suffix in ('-journal', '-wal', '-shm'):
        try:
            descriptor = _checked_open(os.path.join(directory, DATABASE + suffix), os.O_RDONLY)
        except FileNotFoundError:
            continue
        os.close(descriptor)


def _sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def connect(directory, readonly=False):
    """Preflight the DB and ALL SQLite sidecars before SQLite can open or recover them."""
    _directory_safe(directory)
    path = os.path.join(directory, DATABASE)
    descriptor = _checked_open(path, os.O_RDONLY if readonly else os.O_RDWR | os.O_CREAT)
    connection = None
    try:
        _sidecars_safe(directory)
        uri = 'file:' + quote(os.path.abspath(path), safe='/') + ('?mode=ro' if readonly else '?mode=rw')
        connection = sqlite3.connect(uri, uri=True, timeout=30, isolation_level=None)
        info = os.fstat(descriptor)
        after = os.lstat(path)
        if (info.st_dev, info.st_ino) != (after.st_dev, after.st_ino):
            raise PermissionError('history database changed')
        version = connection.execute('PRAGMA user_version').fetchone()[0]
        if version not in ((1,) if readonly else (0, 1)):
            raise ValueError('unsupported history schema')
        if readonly:
            if connection.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                raise ValueError('unsupported history journal mode')
            connection.execute('PRAGMA query_only = ON')
        else:
            if connection.execute('PRAGMA journal_mode = DELETE').fetchone()[0] != 'delete':
                raise ValueError('cannot use DELETE history journal')
            connection.execute('PRAGMA synchronous = FULL')
        _sidecars_safe(directory)
        return connection
    except BaseException:
        if connection is not None:
            connection.close()
        raise
    finally:
        os.close(descriptor)


def _initialize_activity(connection):
    counter = "INTEGER NOT NULL CHECK(typeof(count) = 'integer' AND count >= 0)"
    connection.execute('CREATE TABLE IF NOT EXISTS activity_totals (id INTEGER PRIMARY KEY CHECK(id = 1), '
                       'events INTEGER NOT NULL CHECK(typeof(events) = \'integer\' AND events >= 0), '
                       '"start" TEXT, "end" TEXT, reason TEXT NOT NULL)')
    connection.execute('CREATE TABLE IF NOT EXISTS activity_events (event_id TEXT PRIMARY KEY NOT NULL)')
    connection.execute('CREATE TABLE IF NOT EXISTS activity_kinds (kind TEXT PRIMARY KEY NOT NULL, count ' + counter + ')')
    connection.execute('CREATE TABLE IF NOT EXISTS activity_hours (bucket TEXT PRIMARY KEY NOT NULL, count ' + counter +
                       ", failures INTEGER NOT NULL CHECK(typeof(failures) = 'integer' AND failures >= 0), "
                       "interrupts INTEGER NOT NULL CHECK(typeof(interrupts) = 'integer' AND interrupts >= 0))")
    connection.execute('CREATE TABLE IF NOT EXISTS activity_sessions (session_key TEXT PRIMARY KEY NOT NULL, agent TEXT NOT NULL, '
                       "events INTEGER NOT NULL CHECK(typeof(events) = 'integer' AND events >= 0), "
                       "prompts INTEGER NOT NULL CHECK(typeof(prompts) = 'integer' AND prompts >= 0), "
                       "tool_starts INTEGER NOT NULL CHECK(typeof(tool_starts) = 'integer' AND tool_starts >= 0), "
                       "turn_failures INTEGER NOT NULL CHECK(typeof(turn_failures) = 'integer' AND turn_failures >= 0), "
                       'first_event_at TEXT NOT NULL, last_event_at TEXT NOT NULL)')
    connection.execute('CREATE TABLE IF NOT EXISTS activity_tools (tool TEXT PRIMARY KEY NOT NULL, '
                       "starts INTEGER NOT NULL CHECK(typeof(starts) = 'integer' AND starts >= 0), "
                       "ends INTEGER NOT NULL CHECK(typeof(ends) = 'integer' AND ends >= 0), "
                       "failures INTEGER NOT NULL CHECK(typeof(failures) = 'integer' AND failures >= 0), "
                       "interrupts INTEGER NOT NULL CHECK(typeof(interrupts) = 'integer' AND interrupts >= 0))")
    connection.execute('CREATE TABLE IF NOT EXISTS activity_subagents (subagent TEXT PRIMARY KEY NOT NULL, '
                       "starts INTEGER NOT NULL CHECK(typeof(starts) = 'integer' AND starts >= 0), "
                       "stops INTEGER NOT NULL CHECK(typeof(stops) = 'integer' AND stops >= 0))")
    connection.execute('INSERT OR IGNORE INTO activity_totals VALUES (1, 0, NULL, NULL, ?)', (ACTIVITY_REASON,))
    for kind in event.KINDS:
        connection.execute('INSERT OR IGNORE INTO activity_kinds VALUES (?, 0)', (kind,))


def _initialize(connection):
    if connection.execute('PRAGMA user_version').fetchone()[0] == 1:
        _initialize_activity(connection)
        return
    if connection.execute("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").fetchone():
        raise ValueError('not an empty history database')
    counters = ', '.join('"%s" INTEGER NOT NULL CHECK(typeof("%s") = \'integer\' AND "%s" >= 0)' %
                         (key, key, key) for key in TOTAL_KEYS)
    connection.execute('CREATE TABLE totals (id INTEGER PRIMARY KEY CHECK(id = 1), ' + counters +
                       ', "start" TEXT, "end" TEXT, reason TEXT NOT NULL, '
                       "status TEXT NOT NULL CHECK(status IN ('available', 'invalid')))")
    connection.execute('CREATE TABLE events (event_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL)')
    connection.execute('CREATE TABLE sessions (session_key TEXT PRIMARY KEY NOT NULL)')
    connection.execute('CREATE TABLE calls (call_key TEXT PRIMARY KEY NOT NULL, occurred_at TEXT NOT NULL, '
                       'is_open INTEGER NOT NULL CHECK(is_open IN (0, 1)))')
    # dev/ino are unsigned OS identities, not counters; TEXT avoids signed int64 coercion.
    connection.execute('CREATE TABLE cursors (name TEXT PRIMARY KEY NOT NULL, dev TEXT NOT NULL, '
                       'ino TEXT NOT NULL, offset INTEGER NOT NULL CHECK(offset >= 0), prefix_hash TEXT NOT NULL)')
    connection.execute('INSERT INTO totals (id, ' + _COLUMNS + ', reason, status) VALUES (' +
                       ', '.join('?' for _ in range(len(TOTAL_KEYS) + 3)) + ')',
                       (1,) + (0,) * len(TOTAL_KEYS) + (REASON, 'available'))
    _initialize_activity(connection)
    connection.execute('PRAGMA user_version = 1')


def _hash(values):
    return hashlib.sha256(json.dumps(values, ensure_ascii=True, separators=(',', ':')).encode('ascii')).hexdigest()


def _fingerprint(record):
    return _hash([record[key] for key in ('v',) + event.FIELDS])


def check_event(connection, record):
    """A conflicting ID must fail before it can poison the detail spool, even during dedup."""
    previous = connection.execute('SELECT fingerprint FROM events WHERE event_id = ?', (record['event_id'],)).fetchone()
    if previous is not None and previous[0] != _fingerprint(record):
        raise ValueError('conflicting history event_id')
    return previous is None


def _apply_activity(connection, record):
    if not connection.execute('INSERT OR IGNORE INTO activity_events VALUES (?)', (record['event_id'],)).rowcount:
        return
    kind = record['kind']
    timestamp = record['occurred_at']
    connection.execute('UPDATE activity_kinds SET count = count + 1 WHERE kind = ?', (kind,))
    bucket = timestamp[:13] + ':00:00.000Z'
    failure = int(kind == 'turn_failure' or kind == 'tool_failure' and record['interrupt'] is not True)
    interrupt = int(record['interrupt'] is True)
    connection.execute('INSERT INTO activity_hours VALUES (?, 1, ?, ?) ON CONFLICT(bucket) DO UPDATE SET '
                       'count = count + 1, failures = failures + excluded.failures, interrupts = interrupts + excluded.interrupts',
                       (bucket, failure, interrupt))
    if record['session_id'] is not None:
        session = _hash([record['agent'], record['session_id']])
        connection.execute('INSERT INTO activity_sessions VALUES (?, ?, 1, ?, ?, ?, ?, ?) '
                           'ON CONFLICT(session_key) DO UPDATE SET events = events + 1, prompts = prompts + excluded.prompts, '
                           'tool_starts = tool_starts + excluded.tool_starts, turn_failures = turn_failures + excluded.turn_failures, '
                           'first_event_at = MIN(first_event_at, excluded.first_event_at), last_event_at = MAX(last_event_at, excluded.last_event_at)',
                           (session, record['agent'], int(kind == 'prompt_submit'), int(kind == 'tool_start'),
                            int(kind == 'turn_failure'), timestamp, timestamp))
    if record['tool'] is not None and kind in ('tool_start', 'tool_end', 'tool_failure'):
        tool_values = (int(kind == 'tool_start'), int(kind == 'tool_end'),
                       int(kind == 'tool_failure' and record['interrupt'] is not True),
                       int(kind == 'tool_failure' and record['interrupt'] is True))
        connection.execute('INSERT INTO activity_tools VALUES (?, ?, ?, ?, ?) ON CONFLICT(tool) DO UPDATE SET '
                           'starts = starts + excluded.starts, ends = ends + excluded.ends, failures = failures + excluded.failures, '
                           'interrupts = interrupts + excluded.interrupts', (record['tool'],) + tool_values)
    if record['subagent'] is not None and kind in ('subagent_start', 'subagent_stop'):
        connection.execute('INSERT INTO activity_subagents VALUES (?, ?, ?) ON CONFLICT(subagent) DO UPDATE SET '
                           'starts = starts + excluded.starts, stops = stops + excluded.stops',
                           (record['subagent'], int(kind == 'subagent_start'), int(kind == 'subagent_stop')))
    previous = connection.execute('SELECT events, "start", "end" FROM activity_totals WHERE id = 1').fetchone()
    if previous is None or previous[0] >= MAX_INTEGER:
        raise OverflowError('history activity counter exceeds SQLite int64')
    connection.execute('UPDATE activity_totals SET events = ?, "start" = ?, "end" = ? WHERE id = 1',
                       (previous[0] + 1, min(previous[1], timestamp) if previous[1] is not None else timestamp,
                        max(previous[2], timestamp) if previous[2] is not None else timestamp))


def _apply(connection, record):
    record = event.validate(record)
    is_new = check_event(connection, record)
    if is_new:
        connection.execute('INSERT INTO events VALUES (?, ?)', (record['event_id'], _fingerprint(record)))
        delta = dict.fromkeys(TOTAL_KEYS, 0)
        delta['events'] = 1
        kind = record['kind']
        if kind in _COUNTS:
            delta[_COUNTS[kind]] = 1
        if kind == 'tool_failure':
            delta['interrupts' if record['interrupt'] is True else 'toolFailures'] = 1
        if record['session_id'] is not None:
            session = _hash([record['agent'], record['session_id']])
            delta['sessions'] = connection.execute('INSERT OR IGNORE INTO sessions VALUES (?)', (session,)).rowcount
            if record['call_id'] is not None and kind in ('tool_start', 'tool_end', 'tool_failure'):
                call = _hash([record['agent'], record['session_id'], record['call_id']])
                previous = connection.execute('SELECT occurred_at, is_open FROM calls WHERE call_key = ?', (call,)).fetchone()
                # Equal timestamps follow first-insertion order. Keep closed calls forever so old starts cannot reopen them.
                if previous is None or record['occurred_at'] >= previous[0]:
                    is_open = int(kind == 'tool_start')
                    delta['openTools'] = is_open - (previous[1] if previous is not None else 0)
                    connection.execute('INSERT OR REPLACE INTO calls VALUES (?, ?, ?)', (call, record['occurred_at'], is_open))
        previous = connection.execute(_SELECT).fetchone()
        if previous is None:
            raise ValueError('missing history totals')
        values = [previous[index] + delta[key] for index, key in enumerate(TOTAL_KEYS)]
        if any(type(value) is not int or not 0 <= value <= MAX_INTEGER for value in values):
            raise OverflowError('history counter exceeds SQLite int64')
        start, end = previous[-2:]
        timestamp = record['occurred_at']
        connection.execute(_UPDATE, values + [min(start, timestamp) if start is not None else timestamp,
                                              max(end, timestamp) if end is not None else timestamp])
    _apply_activity(connection, record)


def _prefix_hash(descriptor, length):
    digest = hashlib.sha256()
    offset = 0
    while offset < length:
        chunk = os.pread(descriptor, min(65536, length - offset), offset)
        if not chunk:
            raise OSError('short history prefix read')
        digest.update(chunk)
        offset += len(chunk)
    return digest.hexdigest()


def _set_cursor(connection, name, info, offset, prefix_hash):
    connection.execute('INSERT OR REPLACE INTO cursors VALUES (?, ?, ?, ?, ?)',
                       (name, str(info.st_dev), str(info.st_ino), offset, prefix_hash))


def _scan(connection, directory, name):
    path = os.path.join(directory, name)
    try:
        descriptor = _checked_open(path, os.O_RDONLY)
    except FileNotFoundError:
        return
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        cursor = connection.execute('SELECT dev, ino, offset, prefix_hash FROM cursors WHERE name = ?', (name,)).fetchone()
        offset = 0
        # Inodes may be recycled after rotation; identity alone cannot validate a retained byte offset.
        if cursor and cursor[:2] == (str(info.st_dev), str(info.st_ino)) and cursor[2] <= info.st_size:
            if _prefix_hash(stream.fileno(), cursor[2]) == cursor[3]:
                offset = cursor[2]
        stream.seek(offset)
        while True:
            line = stream.readline(spool.MAX_LINE + 1)
            if not line:
                break
            # Arbitrarily long blank padding is legal, but never allocated as a single string.
            if not line.strip():
                while not line.endswith(b'\n'):
                    line = stream.readline(spool.MAX_LINE + 1)
                    if not line:
                        break
                    if line.strip():
                        raise ValueError('oversized spool line after padding')
                continue
            if len(line) > spool.MAX_LINE:
                raise ValueError('spool history line too large')
            _apply(connection, json.loads(line.decode('utf-8')))
        prefix_hash = _prefix_hash(stream.fileno(), stream.tell())
        after = os.fstat(stream.fileno())
        spool._private_file(stream.fileno())
        path_info = os.lstat(path)
        if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) or (
                after.st_dev, after.st_ino) != (path_info.st_dev, path_info.st_ino) or stream.tell() != info.st_size:
            raise OSError('spool changed during history import')
        _set_cursor(connection, name, info, stream.tell(), prefix_hash)


def import_spool(connection, directory):
    """Commit every retained row and cursor BEFORE a rotation may overwrite either inode."""
    _directory_safe(directory)
    _sidecars_safe(directory)
    connection.execute('BEGIN IMMEDIATE')
    try:
        _initialize(connection)
        for name in (spool.ROTATED, spool.CURRENT):
            _scan(connection, directory, name)
        connection.commit()
    except BaseException:
        connection.rollback()
        # Persist unknown completeness even when the first import rolled its schema back.
        connection.execute('BEGIN IMMEDIATE')
        try:
            _initialize(connection)
            connection.execute("UPDATE totals SET status = 'invalid', reason = ? WHERE id = 1",
                               (REASON + '；存量导入失败，累计完整性未知',))
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        raise
    _sync_directory(directory)


def record_append(connection, directory, record, descriptor):
    """The complete detail line has already been fsynced; commit its count and current cursor together."""
    _sidecars_safe(directory)
    connection.execute('BEGIN IMMEDIATE')
    try:
        _apply(connection, record)
        info = os.fstat(descriptor)
        spool._private_file(descriptor)
        reader = _checked_open(os.path.join(directory, spool.CURRENT), os.O_RDONLY)
        try:
            opened = os.fstat(reader)
            prefix_hash = _prefix_hash(reader, info.st_size)
            after = os.fstat(reader)
            if any(getattr(info, key) != getattr(opened, key) or getattr(opened, key) != getattr(after, key)
                   for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')):
                raise OSError('spool changed during history commit')
            _set_cursor(connection, spool.CURRENT, info, info.st_size, prefix_hash)
        finally:
            os.close(reader)
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    _sync_directory(directory)


def _milliseconds(timestamp):
    return datetime.fromisoformat(timestamp[:-1] + '+00:00').timestamp() * 1000


def _iso(milliseconds):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _activity_summary(connection):
    row = connection.execute('SELECT events, "start", "end", reason FROM activity_totals WHERE id = 1').fetchone()
    if row is None or row[3] != ACTIVITY_REASON or type(row[0]) is not int or not 0 <= row[0] <= MAX_INTEGER:
        raise ValueError('invalid history activity totals')
    if row[0] == 0:
        if row[1] is not None or row[2] is not None:
            raise ValueError('invalid empty history activity range')
        bins = []
    else:
        if not event.valid_timestamp(row[1]) or not event.valid_timestamp(row[2]) or row[1] > row[2]:
            raise ValueError('invalid history activity range')
        start = _milliseconds(row[1])
        end = _milliseconds(row[2])
        count = 1 if start == end else 12
        width = (end - start) / count if count > 1 else 1
        bins = [{'start': _iso(start + width * index), 'end': _iso(end if index == count - 1 else start + width * (index + 1)),
                 'count': 0, 'failures': 0, 'interrupts': 0} for index in range(count)]
        hours = connection.execute('SELECT bucket, count, failures, interrupts FROM activity_hours ORDER BY bucket').fetchall()
        for bucket, events, failures, interrupts in hours:
            if not event.valid_timestamp(bucket) or any(type(value) is not int or not 0 <= value <= MAX_INTEGER for value in (events, failures, interrupts)):
                raise ValueError('invalid history activity hour')
            index = count - 1 if count == 1 or bucket >= row[2] else max(0, min(count - 1, int((_milliseconds(bucket) - start) / width)))
            bins[index]['count'] += events
            bins[index]['failures'] += failures
            bins[index]['interrupts'] += interrupts
    kinds = [{'kind': kind, 'count': count} for kind, count in connection.execute(
        'SELECT kind, count FROM activity_kinds ORDER BY kind').fetchall()]
    if {item['kind'] for item in kinds} != set(event.KINDS) or sum(item['count'] for item in kinds) != row[0] or any(
            type(item['count']) is not int or not 0 <= item['count'] <= MAX_INTEGER for item in kinds):
        raise ValueError('invalid history activity kinds')
    sessions = [{'key': key, 'agent': agent, 'events': events, 'prompts': prompts, 'toolStarts': tool_starts,
                 'turnFailures': turn_failures, 'firstEventAt': first_event_at, 'lastEventAt': last_event_at}
                for key, agent, events, prompts, tool_starts, turn_failures, first_event_at, last_event_at in connection.execute(
                    'SELECT session_key, agent, events, prompts, tool_starts, turn_failures, first_event_at, last_event_at '
                    'FROM activity_sessions ORDER BY events DESC, last_event_at DESC, session_key LIMIT 8').fetchall()]
    tools = [{'tool': tool, 'starts': starts, 'ends': ends, 'failures': failures, 'interrupts': interrupts,
              'unmatched': max(0, starts - ends - failures - interrupts)}
             for tool, starts, ends, failures, interrupts in connection.execute(
                 'SELECT tool, starts, ends, failures, interrupts FROM activity_tools '
                 'ORDER BY starts + ends + failures + interrupts DESC, tool LIMIT 64').fetchall()]
    subagents = [{'subagent': subagent, 'starts': starts, 'stops': stops}
                 for subagent, starts, stops in connection.execute(
                     'SELECT subagent, starts, stops FROM activity_subagents ORDER BY starts + stops DESC, subagent LIMIT 64').fetchall()]
    return {'events': row[0], 'range': {'start': row[1], 'end': row[2]}, 'reason': row[3], 'kinds': kinds,
            'bins': bins, 'sessions': sessions, 'tools': tools, 'subagents': subagents}


def read_summary(directory):
    """Read-only test/consumer interface; never create a DB or invent zeroes for unavailable history."""
    connection = connect(directory, readonly=True)
    try:
        connection.execute('BEGIN')
        row = connection.execute(_SELECT).fetchone()
        state = connection.execute('SELECT reason, status FROM totals WHERE id = 1').fetchone()
        if row is None or state is None or state[1] != 'available' or state[0] != REASON:
            raise ValueError('history completeness unknown')
        if any(type(value) is not int or not 0 <= value <= MAX_INTEGER for value in row[:len(TOTAL_KEYS)]):
            raise ValueError('invalid history counters')
        if any(value is not None and not event.valid_timestamp(value) for value in row[-2:]):
            raise ValueError('invalid history range')
        return {'totals': dict(zip(TOTAL_KEYS, row)), 'range': {'start': row[-2], 'end': row[-1]},
                'reason': state[0], 'activity': _activity_summary(connection)}
    finally:
        connection.close()
