'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const MAX_READ = 2 * 1024 * 1024;
const MAX_LINE = 2048;
const MAX_EVENTS = 5000;
const KINDS = ['session_start', 'session_end', 'prompt_submit', 'tool_start', 'tool_end', 'tool_failure', 'permission_request', 'permission_denied', 'turn_stop', 'turn_failure', 'notification', 'subagent_start', 'subagent_stop', 'task_created', 'task_completed', 'teammate_idle', 'elicitation', 'elicitation_result', 'compact', 'compact_completed'];
const FIELDS = ['v', 'event_id', 'agent', 'kind', 'occurred_at', 'session_id', 'tool', 'call_id', 'error_type', 'interrupt', 'subagent', 'model'];
const token = /^[A-Za-z0-9._:@/+\-]{1,128}$/;
const label = /^[A-Za-z0-9._:@/+ \-]{1,128}$/;
const nullable = (value, pattern) => value === null || typeof value === 'string' && pattern.test(value);

function hookSpoolDirectory(env = process.env, home = os.homedir()) {
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(base, 'sysagent', 'agent-hooks');
}
function directorySafe(directory, forbidden) {
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & forbidden) throw new Error('unsafe');
}
function valid(row) {
  return row !== null && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === FIELDS.length && FIELDS.every(key => Object.hasOwn(row, key)) &&
    row.v === 1 && typeof row.event_id === 'string' && /^[a-f0-9]{16}$/.test(row.event_id) && typeof row.agent === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(row.agent) &&
    KINDS.includes(row.kind) && typeof row.occurred_at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.occurred_at) &&
    Number.isFinite(Date.parse(row.occurred_at)) && new Date(row.occurred_at).toISOString() === row.occurred_at &&
    ['session_id', 'tool', 'call_id', 'error_type'].every(key => nullable(row[key], token)) && ['subagent', 'model'].every(key => nullable(row[key], label)) &&
    (row.interrupt === null || typeof row.interrupt === 'boolean');
}
const TOTAL_KEYS = ['sessions', 'events', 'prompts', 'toolStarts', 'toolEnds', 'toolFailures', 'interrupts', 'permissionDenied', 'turnFailures', 'openTools'];
const HISTORY_READER = `
import fcntl, json, os, sqlite3, stat, sys
from datetime import datetime, timezone
from urllib.parse import quote

def milliseconds(timestamp):
    return datetime.fromisoformat(timestamp[:-1] + '+00:00').timestamp() * 1000

def iso(value):
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def private_file(filename):
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        os.close(descriptor)
        raise ValueError('unsafe')
    return descriptor, info

directory = sys.argv[1]
for name, forbidden in [(directory, 0o077), (os.path.dirname(directory), 0o022)]:
    info = os.lstat(name)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & forbidden:
        raise ValueError('unsafe')
lock, _ = private_file(os.path.join(directory, '.lock'))
try:
    fcntl.flock(lock, fcntl.LOCK_SH)
    filename = os.path.join(directory, 'history.sqlite3')
    descriptor, before = private_file(filename)
    try:
        for suffix in ['-journal', '-wal', '-shm']:
            if os.path.lexists(filename + suffix):
                sidecar, _ = private_file(filename + suffix)
                os.close(sidecar)
        conn = sqlite3.connect('file:' + quote(filename, safe='/') + '?mode=ro', uri=True, timeout=1)
        try:
            conn.execute('PRAGMA query_only=ON')
            conn.execute('PRAGMA trusted_schema=OFF')
            if conn.execute('PRAGMA user_version').fetchone()[0] != 1:
                raise ValueError('schema')
            keys = ${JSON.stringify(TOTAL_KEYS)}
            if conn.execute('PRAGMA journal_mode').fetchone()[0] != 'delete':
                raise ValueError('journal')
            rows = conn.execute("SELECT " + ','.join(keys) + ",start,end,reason FROM totals WHERE id = 1 AND status = 'available'").fetchmany(2)
            if len(rows) != 1 or any(type(count) is not int or count < 0 for count in rows[0][:len(keys)]):
                raise ValueError('counts')
            row = rows[0]
            activity_rows = conn.execute("SELECT events,start,end,reason FROM activity_totals WHERE id = 1").fetchmany(2)
            if len(activity_rows) != 1:
                raise ValueError('activity')
            activity_row = activity_rows[0]
            activity_events, activity_start, activity_end, activity_reason = activity_row
            if type(activity_events) is not int or activity_events < 0 or not isinstance(activity_reason, str):
                raise ValueError('activity')
            kinds_expected = ${JSON.stringify(KINDS)}
            kind_rows = conn.execute("SELECT kind,count FROM activity_kinds ORDER BY kind").fetchall()
            if set(kind for kind, _ in kind_rows) != set(kinds_expected) or any(type(count) is not int or count < 0 for _, count in kind_rows) or sum(count for _, count in kind_rows) != activity_events:
                raise ValueError('activity-kinds')
            bins = []
            if activity_events:
                start = milliseconds(activity_start)
                end = milliseconds(activity_end)
                bin_count = 1 if start == end else 12
                width = (end - start) / bin_count if bin_count > 1 else 1
                bins = [{'start': iso(start + width * index), 'end': iso(end if index == bin_count - 1 else start + width * (index + 1)), 'count': 0, 'failures': 0, 'interrupts': 0} for index in range(bin_count)]
                hour_rows = conn.execute("SELECT bucket,count,failures,interrupts FROM activity_hours ORDER BY bucket").fetchall()
                for bucket, count, failures, interrupts in hour_rows:
                    if any(type(value) is not int or value < 0 for value in (count, failures, interrupts)):
                        raise ValueError('activity-hour')
                    index = bin_count - 1 if bin_count == 1 or bucket >= activity_end else max(0, min(bin_count - 1, int((milliseconds(bucket) - start) / width)))
                    bins[index]['count'] += count
                    bins[index]['failures'] += failures
                    bins[index]['interrupts'] += interrupts
            elif activity_start is not None or activity_end is not None:
                raise ValueError('activity-range')
            sessions = [{'key': values[0], 'agent': values[1], 'events': values[2], 'prompts': values[3], 'toolStarts': values[4], 'turnFailures': values[5], 'firstEventAt': values[6], 'lastEventAt': values[7]} for values in conn.execute("SELECT session_key,agent,events,prompts,tool_starts,turn_failures,first_event_at,last_event_at FROM activity_sessions ORDER BY events DESC,last_event_at DESC,session_key LIMIT 8").fetchall()]
            tools = [{'tool': values[0], 'starts': values[1], 'ends': values[2], 'failures': values[3], 'interrupts': values[4], 'unmatched': max(0, values[1] - values[2] - values[3] - values[4])} for values in conn.execute("SELECT tool,starts,ends,failures,interrupts FROM activity_tools ORDER BY starts+ends+failures+interrupts DESC,tool LIMIT 64").fetchall()]
            subagents = [{'subagent': values[0], 'starts': values[1], 'stops': values[2]} for values in conn.execute("SELECT subagent,starts,stops FROM activity_subagents ORDER BY starts+stops DESC,subagent LIMIT 64").fetchall()]
            activity = {'events': activity_events, 'range': {'start': activity_start, 'end': activity_end}, 'reason': activity_reason,
                        'kinds': [{'kind': kind, 'count': count} for kind, count in kind_rows], 'bins': bins,
                        'sessions': sessions, 'tools': tools, 'subagents': subagents}
            after = os.lstat(filename)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                raise ValueError('replaced')
            print(json.dumps({'totals': dict(zip(keys, row[:len(keys)])), 'range': {'start': row[-3], 'end': row[-2]}, 'reason': row[-1], 'activity': activity}))
        finally:
            conn.close()
    finally:
        os.close(descriptor)
finally:
    os.close(lock)
`;
const sanitize = reason => reason.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/</g, '＜').replace(/>/g, '＞').replace(/&/g, '＆').slice(0, 512);
function unknownHistory(status, reason) {
  return { scope: 'cumulative', status, reason: sanitize(reason), sampledAt: new Date().toISOString(), range: { start: null, end: null },
    totals: Object.fromEntries(TOTAL_KEYS.map(key => [key, null])), activity: null };
}
function cumulativeHistory(directory) {
  const unavailable = () => unknownHistory('unavailable', '独立累计账本不可用；请更新 Hook 插件并触发事件，明细不能代替累计数值。');
  let info;
  try {
    info = fileSnapshot(path.join(directory, 'history.sqlite3'));
    if (info === null) return unavailable();
  } catch { return unknownHistory('invalid', '累计账本权限或类型不安全，已拒绝读取；不自动修改权限。'); }
  const result = spawnSync('python3', ['-I', '-B', '-c', HISTORY_READER, directory],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true });
  if (result.error || result.status !== 0) return unavailable();
  try {
    const value = JSON.parse(result.stdout);
    const shape = (item, keys) => item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key));
    const timestamp = text => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(text) && Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text;
    if (!shape(value, ['activity', 'reason', 'range', 'totals']) || typeof value.reason !== 'string' || value.reason.length > 512 || !shape(value.range, ['start', 'end']) ||
        !shape(value.totals, TOTAL_KEYS) || !TOTAL_KEYS.every(key => Number.isSafeInteger(value.totals[key]) && value.totals[key] >= 0) ||
        (value.totals.events === 0 ? value.range.start !== null || value.range.end !== null : !timestamp(value.range.start) || !timestamp(value.range.end) || value.range.start > value.range.end || Date.parse(value.range.end) > Date.now())) {
      return unknownHistory('invalid', '累计账本结构、时间或数值无效，累计数值未知。');
    }
    const activity = value.activity;
    const count = number => Number.isSafeInteger(number) && number >= 0;
    const rowCounts = (row, keys) => keys.every(key => count(row[key]));
    if (!shape(activity, ['bins', 'events', 'kinds', 'range', 'reason', 'sessions', 'subagents', 'tools']) || !count(activity.events) || activity.events > value.totals.events ||
        typeof activity.reason !== 'string' || activity.reason.length > 512 || !shape(activity.range, ['start', 'end']) || !Array.isArray(activity.kinds) || !Array.isArray(activity.bins) ||
        !Array.isArray(activity.sessions) || !Array.isArray(activity.tools) || !Array.isArray(activity.subagents) || activity.bins.length > 12 || activity.sessions.length > 8 || activity.tools.length > 64 || activity.subagents.length > 64 ||
        (activity.events === 0 ? activity.range.start !== null || activity.range.end !== null || activity.bins.length !== 0 : !timestamp(activity.range.start) || !timestamp(activity.range.end) || activity.range.start > activity.range.end || activity.range.start < value.range.start || activity.range.end > value.range.end) ||
        activity.kinds.length !== KINDS.length || new Set(activity.kinds.map(row => row?.kind)).size !== KINDS.length || !activity.kinds.every(row => shape(row, ['count', 'kind']) && KINDS.includes(row.kind) && count(row.count)) || activity.kinds.reduce((sum, row) => sum + row.count, 0) !== activity.events ||
        !activity.bins.every(row => shape(row, ['count', 'end', 'failures', 'interrupts', 'start']) && timestamp(row.start) && timestamp(row.end) && row.start <= row.end && rowCounts(row, ['count', 'failures', 'interrupts']) && row.failures <= row.count && row.interrupts <= row.count) || activity.bins.reduce((sum, row) => sum + row.count, 0) !== activity.events ||
        !activity.sessions.every(row => shape(row, ['agent', 'events', 'firstEventAt', 'key', 'lastEventAt', 'prompts', 'toolStarts', 'turnFailures']) && /^[a-f0-9]{64}$/.test(row.key) && /^[a-z][a-z0-9-]{0,31}$/.test(row.agent) && timestamp(row.firstEventAt) && timestamp(row.lastEventAt) && row.firstEventAt <= row.lastEventAt && rowCounts(row, ['events', 'prompts', 'toolStarts', 'turnFailures'])) ||
        !activity.tools.every(row => shape(row, ['ends', 'failures', 'interrupts', 'starts', 'tool', 'unmatched']) && token.test(row.tool) && rowCounts(row, ['starts', 'ends', 'failures', 'interrupts', 'unmatched'])) ||
        !activity.subagents.every(row => shape(row, ['starts', 'stops', 'subagent']) && label.test(row.subagent) && rowCounts(row, ['starts', 'stops']))) {
      return unknownHistory('invalid', '累计聚合结构、时间或数值无效，累计图表不可用。');
    }
    return { scope: 'cumulative', status: 'available', reason: sanitize(value.reason), sampledAt: new Date().toISOString(), range: value.range, totals: value.totals,
      activity: { ...activity, reason: sanitize(activity.reason) } };
  } catch { return unknownHistory('invalid', '累计账本返回无效数据，累计数值未知。'); }
}
const HISTORY_IMPORTER = `
import fcntl, json, os, sys, types

sources = json.load(sys.stdin)
package = types.ModuleType('sysagent_hooks')
package.__path__ = []
package.__package__ = 'sysagent_hooks'
sys.modules['sysagent_hooks'] = package
exec(compile(sources['__init__'], '<packaged sysagent_hooks>', 'exec'), package.__dict__)
for name in ('event', 'spool', 'history'):
    module = types.ModuleType('sysagent_hooks.' + name)
    module.__package__ = 'sysagent_hooks'
    sys.modules[module.__name__] = module
    setattr(package, name, module)
    exec(compile(sources[name], '<packaged sysagent_hooks.' + name + '>', 'exec'), module.__dict__)

from sysagent_hooks import history, spool
try:
    directory = sys.argv[1]
    history._directory_safe(directory)
    lock = history._checked_open(os.path.join(directory, spool.LOCK), os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        connection = history.connect(directory)
        try:
            history.import_spool(connection, directory)
        finally:
            connection.close()
    finally:
        os.close(lock)
except PermissionError:
    sys.exit(2)
except Exception:
    sys.exit(3)
`;

async function prepareHookHistory({ directory = hookSpoolDirectory(), signal, timeout = 30000 } = {}) {
  try {
    directorySafe(directory, 0o077);
    directorySafe(path.dirname(directory), 0o022);
    if (!['events.1.jsonl', 'events.jsonl', 'history.sqlite3'].map(name => fileSnapshot(path.join(directory, name))).some(Boolean)) return null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return unknownHistory('invalid', 'Hook 累计存量迁移已拒绝：目录或文件不安全；不自动修改权限。');
  }
  let sources;
  try { sources = JSON.stringify(require('./generated/hook-runtime.cjs')); }
  catch { return unknownHistory('unavailable', '宿主缺少累计迁移运行时，请更新应用或 IDE 扩展。'); }
  return new Promise(resolve => {
    let child;
    try {
      child = spawn('python3', ['-I', '-B', '-c', HISTORY_IMPORTER, directory],
        { signal, timeout, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve(unknownHistory('unavailable', 'Hook 累计存量迁移未能启动，累计数值未知。'));
      return;
    }
    let failure;
    child.once('error', error => { failure = error; });
    child.stdin.on('error', error => { failure ||= error; });
    child.stdout.resume();
    child.stderr.resume();
    child.once('close', (code, stopped) => {
      if (failure || stopped) resolve(unknownHistory('unavailable', failure?.code === 'ENOENT' ?
        '未找到 Python 3，无法迁移 Hook 累计存量。' : 'Hook 累计存量迁移中断或超时；稍后刷新重试，明细不能代替累计数值。'));
      else if (code !== 0) resolve(unknownHistory('invalid', code === 2 ?
        'Hook 累计存量迁移已拒绝：权限或类型不安全；不自动修改权限。' : 'Hook 累计存量迁移失败，账本完整性未知；未删除或重置历史。'));
      else resolve(null);
    });
    child.stdin.end(sources);
  });
}

function fileSafe(info) {
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 || info.nlink !== 1) throw new Error('unsafe');
}
function fileSnapshot(filename) {
  try {
    const info = fs.lstatSync(filename);
    fileSafe(info);
    return info;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const sameFile = (a, b) => a === null || b === null ? a === b :
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'nlink'].every(key => a[key] === b[key]);

function collectHookEvidence({ directory = hookSpoolDirectory(), window } = {}) {
  const empty = (status, reason, history = unknownHistory(status, reason)) => ({ status, reason, data: null, history });
  try {
    directorySafe(directory, 0o077);
    directorySafe(path.dirname(directory), 0o022);
  } catch (error) {
    return error.code === 'ENOENT' ? empty('unavailable', '未发现 Agent Hook 事件目录；未安装 Hook 插件或尚未触发。') : empty('invalid', 'Agent Hook 目录权限或类型不安全，已拒绝读取；不自动修改权限。');
  }
  let skipped = 0;
  let bounded = false;
  let raced = false;
  let files = 0;
  const rows = [];
  const ids = new Set();
  const names = ['events.1.jsonl', 'events.jsonl'];
  let snapshots;
  try {
    snapshots = names.map(name => fileSnapshot(path.join(directory, name)));
    for (const [index, name] of names.entries()) {
      if (snapshots[index] === null) continue;
      let fd;
      try { fd = fs.openSync(path.join(directory, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
      catch (error) { if (error.code === 'ENOENT') { raced = true; continue; } throw error; }
      try {
        const info = fs.fstatSync(fd);
        fileSafe(info);
        raced ||= !sameFile(snapshots[index], info);
        files++;
        const offset = Math.max(0, info.size - MAX_READ);
        bounded ||= offset > 0;
        const bytes = Buffer.alloc(Math.min(info.size, MAX_READ));
        let length = 0;
        while (length < bytes.length) {
          const read = fs.readSync(fd, bytes, length, bytes.length - length, offset + length);
          if (!read) break;
          length += read;
        }
        const after = fs.fstatSync(fd);
        if (after.nlink === 0) throw new Error('read-race');
        fileSafe(after);
        raced ||= length !== bytes.length || !sameFile(info, after);
        let buffer = bytes.subarray(0, length);
        if (offset > 0) {
          const newline = buffer.indexOf(10);
          buffer = newline < 0 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
        }
        for (const line of buffer.toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let row;
          try { if (Buffer.byteLength(line) > MAX_LINE) throw new Error('large'); row = JSON.parse(line); }
          catch { skipped++; continue; }
          if (!valid(row)) { skipped++; continue; }
          if (ids.has(row.event_id)) {
            skipped++;
            continue;
          }
          ids.add(row.event_id);
          rows.push(row);
        }
      } finally { fs.closeSync(fd); }
    }
    directorySafe(directory, 0o077);
    directorySafe(path.dirname(directory), 0o022);
    for (const [index, name] of names.entries()) {
      const after = fileSnapshot(path.join(directory, name));
      raced ||= !sameFile(snapshots[index], after);
    }
  } catch (error) {
    const reason = 'Agent Hook 文件权限、类型或读取状态不安全，已拒绝整个来源；不自动修改权限。';
    return empty('invalid', reason, cumulativeHistory(directory));
  }
  const history = cumulativeHistory(directory);
  if (!files && !raced) return empty('unavailable', '尚无 Agent Hook 明细事件文件。', history);
  rows.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const rotated = snapshots[0] !== null;
  const start = Date.parse(window?.start);
  const end = Date.parse(window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return empty('invalid', 'Agent Hook 采样窗口无效。', history);
  const events = rows.filter(row => Date.parse(row.occurred_at) >= start && Date.parse(row.occurred_at) <= end).map(({ v, ...event }) => event);
  const limited = events.length > MAX_EVENTS;
  const rotationLimited = rotated && (rows.length ? Date.parse(rows[0].occurred_at) : Infinity) > start;
  const reasons = [bounded ? '文件读取超出有界尾部' : '', raced ? '读取期间文件变化或读取不完整' : '', limited ? '窗口事件超过 5000 条，仅保留最新记录' : '', rotationLimited ? '文件已轮转，无法确认覆盖完整窗口' : '', skipped ? `已丢弃 ${skipped} 条无效或重复记录` : ''].filter(Boolean);
  return { status: reasons.length ? 'truncated' : 'available', reason: sanitize(reasons.join('；')), data: { events: events.slice(-MAX_EVENTS), skipped_lines: skipped }, history };
}

module.exports = { hookSpoolDirectory, collectHookEvidence, prepareHookHistory };
