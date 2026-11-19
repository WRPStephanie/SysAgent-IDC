const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
// Even default-directory calls must stay outside the user's real state.
const previousStateHome = process.env.XDG_STATE_HOME;
const scratchStateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sysagent-hook-test-state-'));
process.env.XDG_STATE_HOME = scratchStateHome;
require('node:test').after(() => {
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  fs.rmSync(scratchStateHome, { recursive: true, force: true });
});
const { collectHookEvidence, hookSpoolDirectory, prepareHookHistory } = require('../electron/agent-hooks.cjs');
const root = path.resolve(__dirname, '..');
const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(id => {
    assert(id.startsWith('.'), 'No network, filesystem or process actions in parser');
    return load(path.resolve(path.dirname(filename), `${id}.ts`));
  }, module, module.exports);
  return module.exports;
}
const { parseHookReport } = load(path.join(root, 'agent-hook-diagnostics.ts'));
const { parseAgentDiagnostic } = load(path.join(root, 'agent-diagnostics.ts'));
const { agentHookKindLabels } = load(path.join(root, 'src/agent-diagnostics-data.ts'));
const hookKinds = Object.keys(agentHookKindLabels);
const window = { start: '2026-11-16T00:00:00.000Z', end: '2026-11-17T00:00:00.000Z' };
let sequence = 0;
const row = (overrides = {}) => ({ v: 1, event_id: (++sequence).toString(16).padStart(16, '0'), agent: 'qoder', kind: 'prompt_submit', occurred_at: window.end,
  session_id: 'session-1', tool: null, call_id: null, error_type: null, interrupt: null, subagent: null, model: null, ...overrides });
const rawRow = overrides => { const { v, ...event } = row(overrides); return event; };
const source = events => ({ status: 'available', reason: '', data: { events, skipped_lines: 0 } });
const totalKeys = ['sessions', 'events', 'prompts', 'toolStarts', 'toolEnds', 'toolFailures', 'interrupts', 'permissionDenied', 'turnFailures', 'openTools'];
const totals = value => Object.fromEntries(totalKeys.map(key => [key, value]));
const activity = (events, range) => ({ events, range: events ? { start: range.end, end: range.end } : { start: null, end: null }, reason: '',
  kinds: hookKinds.map(kind => ({ kind, count: events && kind === 'prompt_submit' ? events : 0 })),
  bins: events ? [{ start: range.end, end: range.end, count: events, failures: 0, interrupts: 0 }] : [],
  sessions: [], tools: [], subagents: [] });
const history = (overrides = {}) => {
  const value = { scope: 'cumulative', status: 'available', reason: '', sampledAt: window.end,
    range: { start: window.end, end: window.end }, totals: { ...totals(0), sessions: 1, events: 1, prompts: 1 }, ...overrides };
  if (!Object.hasOwn(overrides, 'activity')) value.activity = value.status === 'available'
    ? activity(Math.min(1, value.totals.events), value.range) : null;
  return value;
};
const assertUnknownHistory = (value, status) => {
  assert.equal(value.scope, 'cumulative');
  assert.equal(value.status, status);
  assert.deepEqual(value.totals, totals(null));
  assert.deepEqual(value.range, { start: null, end: null });
  assert.equal(value.activity, null);
  assert.equal(new Date(value.sampledAt).toISOString(), value.sampledAt);
  assert(value.reason.length <= 512);
};
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sysagent-hooks-'));
  const directory = path.join(base, 'sysagent', 'agent-hooks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, directory, current: path.join(directory, 'events.jsonl'), rotated: path.join(directory, 'events.1.jsonl'),
    db: path.join(directory, 'history.sqlite3'), lock: path.join(directory, '.lock') };
}
const write = (filename, rows) => fs.writeFileSync(filename, rows.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
const sha256 = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
// Consumer mock for the reader's fixed SELECT, not a producer integration fixture.
function seedHistory(f, { totals: counts, range = { start: window.start, end: window.end } }) {
  const reason = 'consumer mock: independent cumulative ledger';
  const result = spawnSync('python3', ['-I', '-B', '-c', `
import json, os, sqlite3, sys
filename, counts_json, range_json, reason = sys.argv[1:]
keys = ${JSON.stringify(totalKeys)}
counts, bounds = json.loads(counts_json), json.loads(range_json)
fd = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.close(fd)
with sqlite3.connect(filename) as conn:
    conn.execute('PRAGMA user_version=1')
    conn.execute('CREATE TABLE totals (id INTEGER PRIMARY KEY CHECK(id=1),' +
                 ','.join(key + ' INTEGER NOT NULL' for key in keys) + ',start TEXT,end TEXT,reason TEXT NOT NULL,status TEXT NOT NULL)')
    conn.execute('INSERT INTO totals VALUES (' + ','.join('?' for _ in range(len(keys) + 5)) + ')',
                 [1] + [int(counts[key]) for key in keys] + [bounds['start'], bounds['end'], reason, 'available'])
    conn.execute('CREATE TABLE activity_totals (id INTEGER PRIMARY KEY,events INTEGER,start TEXT,end TEXT,reason TEXT)')
    conn.execute('INSERT INTO activity_totals VALUES (1,0,NULL,NULL,?)', ('consumer mock: cumulative charts',))
    conn.execute('CREATE TABLE activity_kinds (kind TEXT PRIMARY KEY,count INTEGER)')
    conn.executemany('INSERT INTO activity_kinds VALUES (?,0)', [(kind,) for kind in ${JSON.stringify(hookKinds)}])
    conn.execute('CREATE TABLE activity_hours (bucket TEXT PRIMARY KEY,count INTEGER,failures INTEGER,interrupts INTEGER)')
    conn.execute('CREATE TABLE activity_sessions (session_key TEXT,agent TEXT,events INTEGER,prompts INTEGER,tool_starts INTEGER,turn_failures INTEGER,first_event_at TEXT,last_event_at TEXT)')
    conn.execute('CREATE TABLE activity_tools (tool TEXT,starts INTEGER,ends INTEGER,failures INTEGER,interrupts INTEGER)')
    conn.execute('CREATE TABLE activity_subagents (subagent TEXT,starts INTEGER,stops INTEGER)')
`, f.db, JSON.stringify(counts), JSON.stringify(range), reason], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, '');
  fs.writeFileSync(f.lock, '', { mode: 0o600 });
  assert.equal(fs.statSync(f.db).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.lock).mode & 0o777, 0o600);
  return { totals: counts, range, reason };
}
function assertLedger(value, expected) {
  assert.equal(value.scope, 'cumulative');
  assert.equal(value.status, 'available');
  assert.deepEqual(value.totals, expected.totals);
  assert.deepEqual(value.range, expected.range);
  assert.equal(value.reason, expected.reason);
  assert(value.activity);
  assert.equal(value.activity.kinds.length, hookKinds.length);
  assert.equal(new Date(value.sampledAt).toISOString(), value.sampledAt);
}

function fileState(filename) {
  try {
    const info = fs.lstatSync(filename);
    return { ...Object.fromEntries(['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, info[key]])),
      content: info.isFile() ? sha256(filename) : info.isSymbolicLink() ? fs.readlinkSync(filename) : null };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function spoolState(f) {
  const names = fs.readdirSync(f.directory).sort();
  return { names, paths: [f.base, path.dirname(f.directory), f.directory, ...names.map(name => path.join(f.directory, name)), path.join(f.base, 'saved')].map(fileState) };
}
function inspectHistory(f) {
  const result = spawnSync('python3', ['-I', '-B', '-c', `
import json, sqlite3, sys
from urllib.parse import quote
c = sqlite3.connect('file:' + quote(sys.argv[1], safe='/') + '?mode=ro', uri=True)
c.row_factory = sqlite3.Row
try:
    print(json.dumps({'totals': dict(c.execute('SELECT * FROM totals WHERE id=1').fetchone()),
                      'counts': {name: c.execute('SELECT COUNT(*) FROM ' + name).fetchone()[0] for name in ('events', 'sessions', 'calls', 'cursors')},
                      'cursors': [dict(row) for row in c.execute('SELECT name,offset FROM cursors ORDER BY name')]}))
finally:
    c.close()
`, f.db], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}
async function holdSpoolLock(t, f) {
  const child = spawn('python3', ['-I', '-B', '-c', `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print('locked', flush=True)
sys.stdin.read()
os.close(fd)
`, f.lock], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const [message] = await once(child.stdout, 'data');
  assert.equal(message.toString(), 'locked\n');
  return { release: async () => { child.stdin.end(); await closed; } };
}

test('packaged Hook runtime contains exactly the four byte-exact canonical Python sources', () => {
  const packagedRuntime = require('../electron/generated/hook-runtime.cjs');
  assert.deepEqual(Object.keys(packagedRuntime).sort(), ['__init__', 'event', 'history', 'spool']);
  for (const name of Object.keys(packagedRuntime)) {
    const original = fs.readFileSync(path.resolve(root, '../sysagent-agent-hooks/sysagent_hooks', `${name}.py`));
    assert.deepEqual(Buffer.from(packagedRuntime[name], 'utf8'), original, name);
  }
});

test('prepare migrates both legacy JSONL files: 6031 events/sessions and >16 agents without sample caps or rotation', async t => {
  const f = fixture(t);
  const older = '2026-11-01T12:00:00.000Z';
  const rows = Array.from({ length: 6031 }, (_, index) => row({ session_id: `legacy-${index}`,
    agent: index < 1031 ? `agent-${index % 20}` : 'qoder', occurred_at: index < 1031 ? older : window.end }));
  write(f.rotated, rows.slice(0, 3015));
  write(f.current, rows.slice(3015));
  assert(fs.statSync(f.rotated).size < 1024 * 1024);
  assert(fs.statSync(f.current).size < 1024 * 1024);
  const details = [f.rotated, f.current].map(fileState);
  assert(!fs.existsSync(f.db));
  assertUnknownHistory(collectHookEvidence({ directory: f.directory, window }).history, 'unavailable');
  assert(!fs.existsSync(f.lock), 'The read-only collector must not migrate');
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  const evidence = collectHookEvidence({ directory: f.directory, window });
  assert.equal(evidence.status, 'available');
  assert.equal(evidence.data.events.length, 5000);
  const expected = { totals: { ...totals(0), sessions: 6031, events: 6031, prompts: 6031 },
    range: { start: older, end: window.end }, reason: require('../electron/generated/hook-runtime.cjs').history.match(/^REASON = '([^']+)'/m)[1] };
  assertLedger(evidence.history, expected);
  const report = parseHookReport(evidence, window);
  assert.equal(report.events.length, 200);
  assert.equal(report.agents.length, 1);
  assert.equal(report.agents[0].events, 5000);
  assert.deepEqual(report.history, evidence.history);
  const allTime = { start: older, end: window.end };
  const full = collectHookEvidence({ directory: f.directory, window: allTime });
  assert.equal(full.status, 'truncated');
  assert.equal(full.data.events.length, 5000);
  assertLedger(parseHookReport(full, allTime).history, expected);
  const persisted = inspectHistory(f);
  assert.deepEqual(persisted.counts, { events: 6031, sessions: 6031, calls: 0, cursors: 2 });
  assert.deepEqual(persisted.cursors, ['events.1.jsonl', 'events.jsonl'].map(name => ({ name, offset: fs.statSync(path.join(f.directory, name)).size })));
  assert.deepEqual([f.rotated, f.current].map(fileState), details);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['.lock', 'events.1.jsonl', 'events.jsonl', 'history.sqlite3']);
  for (const filename of [f.db, f.lock]) assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  assert.deepEqual(inspectHistory(f), persisted);
  fs.unlinkSync(f.rotated);
  fs.unlinkSync(f.current);
  const remaining = spoolState(f);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  const deleted = collectHookEvidence({ directory: f.directory, window });
  assert.equal(deleted.status, 'unavailable');
  assertLedger(deleted.history, expected);
  assertLedger(parseHookReport(deleted, window).history, expected);
  assert.deepEqual(inspectHistory(f), persisted);
  assert.deepEqual(spoolState(f), remaining, 'DB-only prepare must not create empty details or reset history');
});

test('legacy append imports incrementally with every cumulative counter and agent/session-scoped call pairing', async t => {
  const f = fixture(t);
  const initial = row({ kind: 'tool_start', call_id: 'shared-call' });
  write(f.rotated, [initial]);
  write(f.current, [row()]);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  const previous = inspectHistory(f);
  assert.equal(previous.totals.events, 2);
  assert.equal(previous.totals.openTools, 1);
  const appended = [row({ kind: 'tool_end', call_id: 'shared-call' }),
    row({ kind: 'tool_start', call_id: 'failure' }), row({ kind: 'tool_failure', call_id: 'failure', interrupt: false }),
    row({ kind: 'tool_start', call_id: 'interrupt' }), row({ kind: 'tool_failure', call_id: 'interrupt', interrupt: true }),
    row({ kind: 'permission_denied' }), row({ kind: 'turn_failure' }),
    row({ agent: 'other-agent', kind: 'tool_start', call_id: 'shared-call' }),
    row({ session_id: 'other-session', kind: 'tool_start', call_id: 'shared-call' }), initial];
  fs.appendFileSync(f.current, appended.map(value => JSON.stringify(value)).join('\n') + '\n');
  const details = [f.rotated, f.current].map(fileState);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  const expected = { sessions: 3, events: 11, prompts: 1, toolStarts: 5, toolEnds: 1, toolFailures: 1,
    interrupts: 1, permissionDenied: 1, turnFailures: 1, openTools: 2 };
  assert.deepEqual(collectHookEvidence({ directory: f.directory, window }).history.totals, expected);
  const imported = inspectHistory(f);
  assert.equal(imported.counts.events, 11, 'A repeated legacy ID must not count again');
  assert.deepEqual(imported.counts, { events: 11, sessions: 3, calls: 5, cursors: 2 });
  assert(imported.cursors.find(cursor => cursor.name === 'events.jsonl').offset > previous.cursors.find(cursor => cursor.name === 'events.jsonl').offset);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  assert.deepEqual(inspectHistory(f), imported);
  assert.deepEqual([f.rotated, f.current].map(fileState), details);
});

test('two concurrent prepares wait on the existing producer flock and import the legacy IDs exactly once', { timeout: 10000 }, async t => {
  const f = fixture(t);
  const duplicate = row();
  write(f.rotated, [duplicate, row()]);
  write(f.current, [duplicate, row()]);
  const holder = await holdSpoolLock(t, f);
  const before = [f.rotated, f.current, f.lock].map(fileState);
  let settled = 0;
  const pending = [prepareHookHistory({ directory: f.directory }), prepareHookHistory({ directory: f.directory })]
    .map(promise => promise.finally(() => settled++));
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(settled, 0, 'Both importers must wait for the same held .lock');
  assert(!fs.existsSync(f.db), 'No database may be opened before the exclusive lock');
  await holder.release();
  assert.deepEqual(await Promise.all(pending), [null, null]);
  assert.deepEqual(collectHookEvidence({ directory: f.directory, window }).history.totals,
    { ...totals(0), sessions: 1, events: 3, prompts: 3 });
  assert.equal(inspectHistory(f).counts.events, 3);
  assert.deepEqual([f.rotated, f.current, f.lock].map(fileState), before);
});

test('prepare cancellation and lock-wait timeout leave legacy data untouched and a later refresh recovers', { timeout: 10000 }, async t => {
  for (const hasHistory of [false, true]) for (const action of ['cancelled-before-spawn', 'cancelled-while-waiting', 'timeout']) {
    const f = fixture(t);
    write(f.current, [row()]);
    if (hasHistory) {
      assert.equal(await prepareHookHistory({ directory: f.directory }), null);
      fs.appendFileSync(f.current, JSON.stringify(row()) + '\n');
    }
    const holder = await holdSpoolLock(t, f);
    const before = spoolState(f);
    const stopped = new AbortController();
    if (action === 'cancelled-before-spawn') stopped.abort();
    const timer = action === 'cancelled-while-waiting' ? setTimeout(() => stopped.abort(), 75) : null;
    let failure;
    try {
      failure = await prepareHookHistory({ directory: f.directory, signal: stopped.signal, timeout: action === 'timeout' ? 100 : 2000 });
    } finally { clearTimeout(timer); }
    assertUnknownHistory(failure, 'unavailable');
    assert.deepEqual(spoolState(f), before, `${action}, existing history: ${hasHistory}`);
    assert.equal(fs.existsSync(f.db), hasHistory);
    await holder.release();
    assert.equal(await prepareHookHistory({ directory: f.directory }), null, action);
    const recovered = collectHookEvidence({ directory: f.directory, window });
    assert.equal(recovered.history.status, 'available');
    assert.deepEqual(recovered.history.totals, { ...totals(0), sessions: 1, events: hasHistory ? 2 : 1, prompts: hasHistory ? 2 : 1 });
  }
});

test('prepare refuses unsafe directories, details, DB, lock and sidecars without permission repair or resetting data', async t => {
  for (const target of ['directory-mode', 'parent-mode', 'directory-symlink', 'current-mode', 'rotated-mode',
    'current-symlink', 'current-hardlink', 'current-fifo', 'db-mode', 'db-symlink',
    'lock-mode', 'lock-symlink', 'lock-hardlink', 'lock-fifo', 'sidecar-mode']) {
    const f = fixture(t);
    write(f.current, [row()]);
    write(f.rotated, [row()]);
    if (target.startsWith('db-') || target === 'sidecar-mode') assert.equal(await prepareHookHistory({ directory: f.directory }), null);
    const filename = target.startsWith('directory-') ? f.directory : target === 'parent-mode' ? path.dirname(f.directory) :
      target.startsWith('rotated-') ? f.rotated : target.startsWith('db-') ? f.db : target.startsWith('lock-') ? f.lock :
        target === 'sidecar-mode' ? `${f.db}-journal` : f.current;
    if (target.startsWith('lock-') || target === 'sidecar-mode') fs.writeFileSync(filename, '', { mode: 0o600 });
    if (target.endsWith('-mode')) fs.chmodSync(filename, target === 'directory-mode' ? 0o755 : target === 'parent-mode' ? 0o777 : 0o644);
    else {
      const saved = path.join(f.base, 'saved');
      fs.renameSync(filename, saved);
      if (target.endsWith('-symlink')) fs.symlinkSync(saved, filename);
      if (target.endsWith('-hardlink')) fs.linkSync(saved, filename);
      if (target.endsWith('-fifo')) {
        const result = spawnSync('mkfifo', ['-m', '600', filename], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
    }
    const before = spoolState(f);
    const failure = await prepareHookHistory({ directory: f.directory, timeout: 2000 });
    assertUnknownHistory(failure, 'invalid');
    assert.deepEqual(spoolState(f), before, target);
  }
});

test('a corrupt legacy append marks existing history sticky-invalid even after the detail line is repaired', async t => {
  const f = fixture(t);
  const good = row();
  write(f.current, [good]);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  const original = inspectHistory(f);
  fs.appendFileSync(f.current, '{private-corrupt-line\n');
  const corrupt = fileState(f.current);
  const failure = await prepareHookHistory({ directory: f.directory });
  assertUnknownHistory(failure, 'invalid');
  assert(!JSON.stringify(failure).includes('private-corrupt-line'));
  assert.deepEqual(fileState(f.current), corrupt);
  const invalid = inspectHistory(f);
  assert.equal(invalid.totals.status, 'invalid');
  assert.equal(invalid.totals.events, original.totals.events);
  assert.deepEqual(invalid.counts, original.counts);
  assert.deepEqual(invalid.cursors, original.cursors, 'Failed append rolls back its cursor');
  assertUnknownHistory(collectHookEvidence({ directory: f.directory, window }).history, 'unavailable');
  write(f.current, [good, row()]);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  const repaired = inspectHistory(f);
  assert.equal(repaired.totals.status, 'invalid', 'Repairing details must not reset ledger integrity');
  assert.equal(repaired.totals.events, 2);
  assertUnknownHistory(parseHookReport(collectHookEvidence({ directory: f.directory, window }), window).history, 'unavailable');
  fs.unlinkSync(f.current);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  assert.equal(inspectHistory(f).totals.status, 'invalid');
});

test('a corrupt first legacy migration must not become available merely by removing the corrupt line', async t => {
  const f = fixture(t);
  const good = row();
  write(f.current, [good, '{private-corrupt-first-import']);
  const before = fileState(f.current);
  const failure = await prepareHookHistory({ directory: f.directory });
  assertUnknownHistory(failure, 'invalid');
  assert.deepEqual(fileState(f.current), before);
  assertUnknownHistory(collectHookEvidence({ directory: f.directory, window }).history, 'unavailable');
  write(f.current, [good]);
  await prepareHookHistory({ directory: f.directory });
  const repaired = collectHookEvidence({ directory: f.directory, window });
  assert.notEqual(repaired.history.status, 'available', 'Failed first import must retain unknown completeness, not reset to numeric totals');
  assert.deepEqual(repaired.history.totals, totals(null));
});

test('prepare with no spool or no managed files never creates a zero ledger, lock or directories', async t => {
  const f = fixture(t);
  const before = spoolState(f);
  for (const directory of [f.directory, path.join(f.base, 'missing', 'agent-hooks')]) {
    assert.equal(await prepareHookHistory({ directory }), null);
    assertUnknownHistory(collectHookEvidence({ directory, window }).history, 'unavailable');
    assert.deepEqual(spoolState(f), before);
  }
  assert(!fs.existsSync(path.join(f.base, 'missing')));
  write(path.join(f.directory, 'events.2.jsonl'), [row()]);
  const unmanaged = spoolState(f);
  assert.equal(await prepareHookHistory({ directory: f.directory }), null);
  assert.deepEqual(spoolState(f), unmanaged);
  assert(!fs.existsSync(f.db));
  assert(!fs.existsSync(f.lock));
});

test('XDG state selection and missing spool preserve unavailable semantics', () => {
  assert.equal(hookSpoolDirectory({}, '/fixture'), '/fixture/.local/state/sysagent/agent-hooks');
  assert.equal(hookSpoolDirectory({ XDG_STATE_HOME: 'relative' }, '/fixture'), '/fixture/.local/state/sysagent/agent-hooks');
  assert.equal(hookSpoolDirectory({ XDG_STATE_HOME: '/state' }), '/state/sysagent/agent-hooks');
  assert.equal(collectHookEvidence({ directory: path.join(root, 'missing-hooks-fixture'), window }).status, 'unavailable');
});
test('reader rejects unsafe directory, parent, symlink, file and hardlink without repairs', t => {
  const f = fixture(t);
  write(f.current, [row()]);
  for (const [target, mode] of [[f.directory, 0o755], [path.dirname(f.directory), 0o777], [f.current, 0o644]]) {
    fs.chmodSync(target, mode);
    assert.equal(collectHookEvidence({ directory: f.directory, window }).status, 'invalid');
    assert.equal(fs.statSync(target).mode & 0o777, mode);
    fs.chmodSync(target, target === f.current ? 0o600 : 0o700);
  }
  const saved = path.join(f.base, 'saved');
  fs.renameSync(f.current, saved);
  fs.symlinkSync(saved, f.current);
  assert.equal(collectHookEvidence({ directory: f.directory, window }).status, 'invalid');
  fs.unlinkSync(f.current);
  fs.linkSync(saved, f.current);
  assert.equal(collectHookEvidence({ directory: f.directory, window }).status, 'invalid');
});
test('reader filters inclusive window, strips v, rejects non-metadata and counts invalid/duplicate lines', t => {
  const f = fixture(t);
  const a = row({ occurred_at: window.start });
  const b = row();
  write(f.current, [a, b, b, '{invalid', row({ prompt: 'must-not-leak' }), row({ occurred_at: '2026-11-15T00:00:00.000Z' }), row({ occurred_at: '2026-11-18T00:00:00.000Z' }), row({ occurred_at: '2026-02-31T00:00:00.000Z' })]);
  const evidence = collectHookEvidence({ directory: f.directory, window });
  assert.equal(evidence.status, 'truncated');
  assert.equal(evidence.data.skipped_lines, 4);
  assert.equal(evidence.data.events.length, 2);
  assert.equal(evidence.data.events[0].occurred_at, window.start);
  assert(!JSON.stringify(evidence).includes('must-not-leak'));
  assert(!Object.hasOwn(evidence.data.events[0], 'v'));
  assert.equal(parseHookReport(evidence, window).events.length, 2);
});
test('reader rotation, bounded tail, event cap and empty file remain explicit', t => {
  const f = fixture(t);
  write(f.current, []);
  assert.equal(collectHookEvidence({ directory: f.directory, window }).status, 'available');
  write(f.rotated, [row()]);
  assert.match(collectHookEvidence({ directory: f.directory, window }).reason, /轮转/);
  write(f.current, Array.from({ length: 5100 }, () => row()));
  const capped = collectHookEvidence({ directory: f.directory, window });
  assert.equal(capped.data.events.length, 5000);
  assert.equal(capped.status, 'truncated');
  write(f.rotated, ['x'.repeat(2 * 1024 * 1024 + 1), row()]);
  assert.match(collectHookEvidence({ directory: f.directory, window }).reason, /尾部/);
});
test('Python producer and JS reader have interoperable metadata constraints', t => {
  const f = fixture(t);
  const script = path.resolve(root, '../plugins/qoder/bin/sysagent_hook.py');
  const result = spawnSync('python3', ['-B', script, 'qoder', 'PostToolUseFailure'], { input: JSON.stringify({ session_id: 'session-1', tool_use_id: 'call_1', tool_name: 'Bash', is_interrupt: true, error_type: 'timeout', error: 'private-error', tool_input: { command: 'private-command' } }), env: { ...process.env, XDG_STATE_HOME: f.base }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  const now = new Date(Date.now() + 1000).toISOString();
  const evidence = collectHookEvidence({ directory: f.directory, window: { start: '1970-01-01T00:00:00.000Z', end: now } });
  assert.equal(evidence.status, 'available');
  assert.equal(evidence.history.scope, 'cumulative');
  assert.equal(evidence.history.status, 'available');
  assert.equal(evidence.history.totals.events, 1);
  assert.equal(evidence.history.totals.interrupts, 1);
  assert.equal(evidence.history.totals.toolFailures, 0);
  const report = parseHookReport(evidence, { start: '1970-01-01T00:00:00.000Z', end: now });
  assert.equal(report.agents[0].interrupts, 1);
  assert.equal(report.agents[0].toolFailures, 0);
  assert.deepEqual(report.history, evidence.history);
  assert(!JSON.stringify(evidence).includes('private-'));
  assert(!JSON.stringify(report).includes('private-'));
});
test('hook summaries separate agents/sessions and pair tool calls without inventing process identity', () => {
  const events = [rawRow({ kind: 'session_start', model: 'Qwen 3', subagent: 'Explore' }),
    rawRow({ kind: 'tool_start', call_id: 'call-1', tool: 'Read' }), rawRow({ kind: 'tool_end', call_id: 'call-1' }),
    rawRow({ kind: 'tool_start', call_id: 'call-2' }), rawRow({ kind: 'tool_failure', call_id: 'call-2', interrupt: true }),
    rawRow({ kind: 'tool_start', call_id: 'call-3' }), rawRow({ kind: 'tool_start', call_id: null }),
    rawRow({ kind: 'permission_denied' }), rawRow({ kind: 'turn_failure' }), rawRow({ kind: 'tool_failure', interrupt: false }),
    rawRow({ agent: 'other-agent', session_id: 'other-session' }), rawRow({ kind: 'prompt_submit' })];
  const report = parseHookReport(source(events), window);
  const qoder = report.agents.find(item => item.agent === 'qoder');
  assert.deepEqual(qoder, { agent: 'qoder', sessions: 1, events: 11, prompts: 1, toolStarts: 4, toolEnds: 1, toolFailures: 1, interrupts: 1, permissionDenied: 1, turnFailures: 1, openTools: 1, lastEventAt: window.end });
  assert.equal(report.events[0].kind, 'prompt_submit');
  assert.equal(report.events.at(-1).model, 'Qwen 3');
  assert.equal(report.events.at(-1).subagent, 'Explore');
});
test('parser invalidates complete Hook source for bad rows, identity, window or bounded dimensions', () => {
  for (const change of [{ prompt: 'private' }, { event_id: 'bad' }, { agent: 'Qoder' }, { tool: 'bad\n' }, { model: '<script>' }, { interrupt: 1 }, { occurred_at: '2026-02-31T00:00:00.000Z' }, { occurred_at: '2026-11-18T00:00:00.000Z' }, { kind: 'config_change' }]) {
    const report = parseHookReport(source([rawRow(), rawRow(change)]), window);
    assert.equal(report.status, 'invalid', JSON.stringify(change));
    assert.equal(report.events.length, 0);
  }
  const duplicate = rawRow();
  assert.equal(parseHookReport(source([duplicate, duplicate]), window).status, 'invalid');
  assert.equal(parseHookReport(source(Array.from({ length: 5001 }, () => rawRow())), window).status, 'invalid');
  assert.equal(parseHookReport(source(Array.from({ length: 17 }, (_, i) => rawRow({ agent: `agent-${i}` }))), window).status, 'invalid');
  assert.equal(parseHookReport({ status: 'unavailable', reason: '', data: {} }, window).status, 'invalid');
});
test('5000 event summaries are complete but recent list is 200; empty and missing remain distinct', () => {
  const report = parseHookReport(source(Array.from({ length: 5000 }, () => rawRow())), window);
  assert.equal(report.events.length, 200);
  assert.equal(report.agents[0].events, 5000);
  assert.equal(parseHookReport(source([]), window).skippedLines, 0);
  assert.equal(parseHookReport(undefined, window).status, 'unavailable');
  assert.equal(parseHookReport(undefined, window).skippedLines, null);
});
test('detail windows accept valid Agent timestamps without milliseconds and with offsets', () => {
  const event = rawRow();
  for (const bounds of [
    { start: '2026-11-16T00:00:00Z', end: '2026-11-17T00:00:00Z' },
    { start: '2026-11-16T08:00:00+08:00', end: '2026-11-17T08:00:00+08:00' },
  ]) {
    const report = parseHookReport({ ...source([event]), history: history() }, bounds);
    assert.equal(report.status, 'available');
    assert.equal(report.events.length, 1);
    assert.equal(report.history.status, 'available');
  }
});

test('independent ledger totals bypass 24h, 5000 input and 200 detail limits', t => {
  const f = fixture(t);
  const older = '2026-11-14T12:00:00.000Z';
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 9000, events: 9000, prompts: 9000 },
    range: { start: '2026-11-01T00:00:00.000Z', end: window.end } });
  const rows = Array.from({ length: 5400 }, (_, i) => row({ session_id: `session-${i}`, occurred_at: i < 300 ? older : window.end }));
  write(f.rotated, rows.slice(0, 2700));
  write(f.current, rows.slice(2700));
  assert(fs.statSync(f.rotated).size <= 1024 * 1024);
  assert(fs.statSync(f.current).size <= 1024 * 1024);
  const evidence = collectHookEvidence({ directory: f.directory, window });
  assert.equal(evidence.status, 'truncated');
  assert.equal(evidence.data.events.length, 5000);
  assert(!Object.hasOwn(evidence.data, 'history'));
  assertLedger(evidence.history, ledger);
  const report = parseHookReport(evidence, window);
  assert.equal(report.events.length, 200);
  assert.equal(report.agents[0].events, 5000);
  assert.deepEqual(report.history, evidence.history);
});

test('global ledger survives more than 16 agents and invalid detail lines without changing legacy rejection', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 80, events: 100, prompts: 30, toolStarts: 60, openTools: 50 } });
  write(f.current, Array.from({ length: 20 }, (_, i) => row({ agent: `agent-${i}`, kind: 'tool_start', call_id: 'same-call', session_id: 'same-session' })));
  const evidence = collectHookEvidence({ directory: f.directory, window });
  assertLedger(evidence.history, ledger);
  const report = parseHookReport(evidence, window);
  assert.equal(report.status, 'invalid');
  assert.equal(report.agents.length, 0);
  assert.equal(report.events.length, 0);
  assert.deepEqual(report.history, evidence.history);
  fs.appendFileSync(f.current, '{invalid\n');
  const uncertain = parseHookReport(collectHookEvidence({ directory: f.directory, window }), window);
  assert.equal(uncertain.status, 'invalid');
  assertLedger(uncertain.history, ledger);
});

test('replacing, rotating and deleting both detail files never changes persistent ledger totals', t => {
  const f = fixture(t);
  const older = '2026-11-01T00:00:00.000Z';
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 8, events: 40, prompts: 40 },
    range: { start: older, end: window.end } });
  write(f.rotated, [row({ occurred_at: older })]);
  write(f.current, [row()]);
  const check = () => {
    const evidence = collectHookEvidence({ directory: f.directory, window });
    assertLedger(evidence.history, ledger);
    assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
    return evidence;
  };
  check();
  // Unmanaged records and replaced detail tails are not cumulative evidence.
  write(path.join(f.directory, 'events.2.jsonl'), [row({ occurred_at: older }), row()]);
  write(f.rotated, [row({ occurred_at: window.start })]);
  assert.equal(check().data.events.length, 2);
  fs.renameSync(f.current, f.rotated);
  write(f.current, [row()]);
  assert.equal(check().data.events.length, 2);
  fs.unlinkSync(f.rotated);
  assert.equal(check().data.events.length, 1);
  fs.unlinkSync(f.current);
  const absentDetails = check();
  assert.equal(absentDetails.status, 'unavailable');
  assert.equal(absentDetails.data, null);
});

test('consumer reads every fixed ledger column and reason independently of detail contents', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { sessions: 7, events: 120, prompts: 13, toolStarts: 23, toolEnds: 17,
    toolFailures: 11, interrupts: 5, permissionDenied: 3, turnFailures: 2, openTools: 9 },
    range: { start: '2026-10-01T00:00:00.000Z', end: window.end } });
  write(f.current, [row({ kind: 'session_start' }), row(), row({ kind: 'tool_start', call_id: 'x' }),
    row({ kind: 'tool_end', call_id: 'x' }), row({ kind: 'tool_failure', interrupt: false }),
    row({ kind: 'tool_failure', interrupt: true }), row({ kind: 'permission_denied' }), row({ kind: 'turn_failure' })]);
  const evidence = collectHookEvidence({ directory: f.directory, window });
  assert.equal(evidence.data.events.length, 8);
  assertLedger(evidence.history, ledger);
  assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
  write(f.current, []);
  const emptyDetails = collectHookEvidence({ directory: f.directory, window });
  assert.equal(emptyDetails.data.events.length, 0);
  assertLedger(emptyDetails.history, ledger);
  assert.deepEqual(parseHookReport(emptyDetails, window).history, emptyDetails.history);
});

test('ledger range and openTools remain independent across different detail windows', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 2, events: 50, toolStarts: 20, toolEnds: 10, prompts: 5, openTools: 7 },
    range: { start: '2026-11-01T00:00:00.000Z', end: window.end } });
  write(f.current, [row({ kind: 'tool_end', call_id: 'c' }), row({ kind: 'tool_start', call_id: 'c', occurred_at: '2026-11-15T00:00:00.000Z' }),
    row({ kind: 'tool_start', call_id: 'older-open', occurred_at: '2026-11-14T00:00:00.000Z' })]);
  for (const [bounds, openTools, events] of [[window, 0, 1], [{ start: '2026-11-14T00:00:00.000Z', end: window.end }, 1, 3]]) {
    const evidence = collectHookEvidence({ directory: f.directory, window: bounds });
    const report = parseHookReport(evidence, bounds);
    assert.equal(report.agents[0].openTools, openTools);
    assert.equal(report.agents[0].events, events);
    assertLedger(evidence.history, ledger);
    assert.deepEqual(report.history, evidence.history);
  }
});

test('missing ledger stays unknown even with empty or populated details; only an explicit empty ledger is zero', t => {
  const f = fixture(t);
  const absent = collectHookEvidence({ directory: f.directory, window });
  assertUnknownHistory(absent.history, 'unavailable');
  assertUnknownHistory(parseHookReport(absent, window).history, 'unavailable');
  for (const rows of [[], [row()]]) {
    write(f.current, rows);
    const names = fs.readdirSync(f.directory).sort();
    const evidence = collectHookEvidence({ directory: f.directory, window });
    assert.equal(evidence.status, 'available');
    assert.equal(evidence.data.events.length, rows.length);
    assertUnknownHistory(evidence.history, 'unavailable');
    assertUnknownHistory(parseHookReport(evidence, window).history, 'unavailable');
    assert.deepEqual(fs.readdirSync(f.directory).sort(), names);
    assert(!fs.existsSync(f.db));
    assert(!fs.existsSync(f.lock));
  }
  const ledger = seedHistory(f, { totals: totals(0), range: { start: null, end: null } });
  write(f.current, []);
  const empty = collectHookEvidence({ directory: f.directory, window });
  assert.equal(empty.status, 'available');
  assertLedger(empty.history, ledger);
  assert.deepEqual(parseHookReport(empty, window).history, empty.history);
  fs.unlinkSync(f.current);
  const onlyLedger = collectHookEvidence({ directory: f.directory, window });
  assert.equal(onlyLedger.status, 'unavailable');
  assertLedger(onlyLedger.history, ledger);
  assert.deepEqual(parseHookReport(onlyLedger, window).history, onlyLedger.history);
  assertUnknownHistory(collectHookEvidence({ directory: path.join(f.base, 'missing'), window }).history, 'unavailable');
});

test('invalid cumulative status never exposes otherwise valid numeric totals', t => {
  const f = fixture(t);
  seedHistory(f, { totals: { ...totals(0), sessions: 1, events: 10, prompts: 10 } });
  write(f.current, [row()]);
  const result = spawnSync('python3', ['-I', '-B', '-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE totals SET status='invalid'\"); c.commit(); c.close()", f.db], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const before = sha256(f.db);
  const evidence = collectHookEvidence({ directory: f.directory, window });
  assert.equal(evidence.status, 'available');
  assertUnknownHistory(evidence.history, 'unavailable');
  assertUnknownHistory(parseHookReport(evidence, window).history, 'unavailable');
  assert.equal(sha256(f.db), before);
});

test('unsafe ledger modes, symlinks, hardlinks and FIFOs remain untouched and unknown', t => {
  for (const type of ['mode', 'symlink', 'hardlink', 'fifo']) {
    const f = fixture(t);
    seedHistory(f, { totals: { ...totals(0), sessions: 1, events: 10, prompts: 10 } });
    write(f.current, [row()]);
    let saved = f.db;
    if (type === 'mode') fs.chmodSync(f.db, 0o644);
    else {
      saved = path.join(f.base, 'saved.sqlite3');
      fs.renameSync(f.db, saved);
      if (type === 'symlink') fs.symlinkSync(saved, f.db);
      if (type === 'hardlink') fs.linkSync(saved, f.db);
      if (type === 'fifo') {
        const result = spawnSync('mkfifo', ['-m', '600', f.db], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
    }
    const before = fs.lstatSync(f.db);
    const names = fs.readdirSync(f.directory).sort();
    const hash = sha256(saved);
    const evidence = collectHookEvidence({ directory: f.directory, window });
    assert.equal(evidence.status, 'available', type);
    assertUnknownHistory(evidence.history, 'invalid');
    assertUnknownHistory(parseHookReport(evidence, window).history, 'invalid');
    const after = fs.lstatSync(f.db);
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], `${type}: ${key}`);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), names);
    assert.equal(sha256(saved), hash);
    if (type === 'symlink') assert.equal(fs.readlinkSync(f.db), saved);
  }
});

test('unsafe detail files reject details without poisoning the trusted independent ledger', t => {
  for (const type of ['mode', 'symlink', 'hardlink', 'fifo', 'directory']) {
    const f = fixture(t);
    const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 1, events: 10, prompts: 10 } });
    write(f.current, [row()]);
    if (type === 'mode') fs.chmodSync(f.current, 0o644);
    else {
      const saved = path.join(f.base, 'saved.jsonl');
      fs.renameSync(f.current, saved);
      if (type === 'symlink') fs.symlinkSync(saved, f.current);
      if (type === 'hardlink') fs.linkSync(saved, f.current);
      if (type === 'directory') fs.mkdirSync(f.current, { mode: 0o700 });
      if (type === 'fifo') {
        const result = spawnSync('mkfifo', ['-m', '600', f.current], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
      }
    }
    const before = fs.lstatSync(f.current);
    const hash = sha256(f.db);
    const names = fs.readdirSync(f.directory).sort();
    const evidence = collectHookEvidence({ directory: f.directory, window });
    assert.equal(evidence.status, 'invalid', type);
    assert.equal(evidence.data, null);
    assertLedger(evidence.history, ledger);
    assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
    const after = fs.lstatSync(f.current);
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], `${type}: ${key}`);
    assert.equal(sha256(f.db), hash);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), names);
  }
});

test('invalid JSON, metadata and conflicting detail IDs do not taint trusted ledger totals', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 3, events: 80, prompts: 50, turnFailures: 10 },
    range: { start: '2026-11-01T00:00:00.000Z', end: window.end } });
  const valid = row();
  for (const invalid of ['{invalid', row({ prompt: 'private-prompt' }), row({ occurred_at: '2026-02-31T00:00:00.000Z' }),
    { ...valid, kind: 'turn_failure' }]) {
    write(f.rotated, [invalid]);
    write(f.current, [valid]);
    const evidence = collectHookEvidence({ directory: f.directory, window });
    assert.equal(evidence.status, 'truncated');
    assert.equal(evidence.data.skipped_lines, 1);
    assert.equal(evidence.data.events.length, 1);
    assertLedger(evidence.history, ledger);
    assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
    assert(!JSON.stringify(evidence).includes('private-prompt'));
  }
});

test('2 MiB tail bounds truncate details but preserve the independent ledger', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 4, events: 100, prompts: 70 },
    range: { start: '2026-11-01T00:00:00.000Z', end: window.end } });
  write(f.current, [' '.repeat(2 * 1024 * 1024 + 1), row()]);
  const evidence = collectHookEvidence({ directory: f.directory, window });
  assert.equal(evidence.data.events.length, 1);
  assert.equal(evidence.status, 'truncated');
  assert.match(evidence.reason, /尾部/);
  assertLedger(evidence.history, ledger);
  assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
});

test('append, short-read and rotation races affect details only, not trusted ledger totals', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 4, events: 70, prompts: 50 },
    range: { start: '2026-11-01T00:00:00.000Z', end: window.end } });
  const original = fs.readSync;
  for (const action of ['append', 'short-read', 'rotate']) {
    write(f.rotated, [row()]);
    write(f.current, [row()]);
    let changed = false;
    fs.readSync = function (...args) {
      if (changed && action === 'short-read') return 0;
      const count = original.apply(this, action === 'short-read' ? [args[0], args[1], args[2], Math.min(10, args[3]), args[4]] : args);
      if (!changed) {
        changed = true;
        if (action === 'append') fs.appendFileSync(f.current, `${JSON.stringify(row())}\n`);
        if (action === 'rotate') {
          fs.renameSync(f.current, f.rotated);
          write(f.current, [row()]);
        }
      }
      return count;
    };
    let evidence;
    try { evidence = collectHookEvidence({ directory: f.directory, window }); }
    finally { fs.readSync = original; }
    assert(changed, action);
    assert.equal(evidence.status, action === 'rotate' ? 'invalid' : 'truncated', action);
    assertLedger(evidence.history, ledger);
    assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
  }
});

test('detail IO errors reject details while preserving trusted independent history', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 4, events: 100, prompts: 80 } });
  write(f.rotated, [row()]);
  write(f.current, [row()]);
  const original = fs.readSync;
  let calls = 0;
  fs.readSync = function (...args) {
    if (++calls === 2) throw Object.assign(new Error('private-read-error'), { code: 'EIO' });
    return original.apply(this, args);
  };
  let evidence;
  try { evidence = collectHookEvidence({ directory: f.directory, window }); }
  finally { fs.readSync = original; }
  assert.equal(evidence.status, 'invalid');
  assert.equal(evidence.data, null);
  assertLedger(evidence.history, ledger);
  assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
  assert(!JSON.stringify(evidence).includes('private-read-error'));
});

test('consumer reads never initialize or write the ledger, lock or directory', t => {
  const f = fixture(t);
  const ledger = seedHistory(f, { totals: { ...totals(0), sessions: 1, events: 10, prompts: 10 } });
  write(f.current, [row()]);
  const snapshot = () => ({ names: fs.readdirSync(f.directory).sort(), db: sha256(f.db), lock: sha256(f.lock),
    metadata: [f.directory, f.db, f.lock].map(filename => {
      const info = fs.lstatSync(filename);
      return Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, info[key]]));
    }) });
  const before = snapshot();
  for (const bounds of [window, window, { start: 'bad', end: window.end }]) {
    const evidence = collectHookEvidence({ directory: f.directory, window: bounds });
    assertLedger(evidence.history, ledger);
    assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
    assert.deepEqual(snapshot(), before);
  }
});

test('SQLite integers beyond JS safe range stay unknown instead of returning rounded totals', t => {
  const safe = fixture(t);
  const ledger = seedHistory(safe, { totals: { ...totals(0), sessions: 1, events: Number.MAX_SAFE_INTEGER, prompts: Number.MAX_SAFE_INTEGER } });
  write(safe.current, []);
  const maximum = collectHookEvidence({ directory: safe.directory, window });
  assertLedger(maximum.history, ledger);
  assert.deepEqual(parseHookReport(maximum, window).history, maximum.history);
  // Decimal strings preserve the exact SQLite INTEGER through JSON fixture input.
  for (const count of ['9007199254740992', '9007199254740993', '9223372036854775807']) {
    const f = fixture(t);
    seedHistory(f, { totals: { ...totals(0), sessions: 1, events: count, prompts: count } });
    write(f.current, []);
    const hash = sha256(f.db);
    const evidence = collectHookEvidence({ directory: f.directory, window });
    assert.equal(evidence.status, 'available');
    assertUnknownHistory(evidence.history, 'invalid');
    assertUnknownHistory(parseHookReport(evidence, window).history, 'invalid');
    assert.equal(sha256(f.db), hash);
  }
});

test('history is explicit and top-level only, never synthesized from a legacy sample', () => {
  const legacy = parseHookReport(source([rawRow()]), window);
  assert.equal(legacy.history, undefined);
  assert(!Object.hasOwn(legacy, 'history'));
  assert.equal(parseHookReport(undefined, window).history, undefined);
  const nested = source([]);
  nested.data.history = history();
  const rejected = parseHookReport(nested, window);
  assert.equal(rejected.status, 'invalid');
  assert.equal(rejected.history, undefined);
  const explicit = { ...source([rawRow()]), history: history() };
  const copy = structuredClone(explicit);
  const report = parseHookReport(explicit, window);
  assert.deepEqual(report.history, explicit.history);
  assert.notEqual(report.history, explicit.history);
  assert.notEqual(report.history.totals, explicit.history.totals);
  assert.deepEqual(explicit, copy);
  assertUnknownHistory(parseHookReport({ ...source([]), history: undefined }, window).history, 'invalid');
});

test('strict history validation rejects malformed shapes, unsafe counts, timestamps and inconsistent totals', () => {
  const malformed = [null, [], {}, history({ extra: 1 }), history({ scope: 'window' }), history({ status: 'ok' }),
    history({ reason: 'x'.repeat(513) }), history({ reason: null }), history({ sampledAt: '2026-02-31T00:00:00.000Z' }),
    history({ sampledAt: '2026-11-17T00:00:00Z' }), history({ sampledAt: window.start }),
    history({ range: { start: window.end, end: window.start } }), history({ range: { start: window.end, end: null } }),
    history({ range: { start: null, end: null } }), history({ range: { start: window.end, end: window.end, extra: true } }),
    history({ totals: { ...totals(0), extra: 1 } }), history({ totals: {} }), history({ totals: [] }),
    history({ totals: { ...totals(0), events: 1, sessions: 2 } }), history({ totals: { ...totals(0), events: 1, prompts: 1, toolEnds: 1 } }),
    history({ totals: { ...totals(0), events: 1, sessions: 1, openTools: 1 } }),
    history({ totals: { ...totals(0), events: 1, toolStarts: 1, openTools: 1 } }), history({ totals: totals(0) }),
    history({ status: 'truncated' }), history({ status: 'unavailable', totals: totals(null) }),
    history({ status: 'invalid', range: { start: null, end: null }, totals: { ...totals(null), events: 0 } }),
  ];
  for (const count of [-1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', true, null]) {
    for (const key of totalKeys) malformed.push(history({ totals: { ...history().totals, [key]: count } }));
  }
  for (const value of malformed) {
    const report = parseHookReport({ ...source([]), history: value }, window);
    assert.equal(report.status, 'available'); // A malformed independent history does not poison valid legacy details.
    assertUnknownHistory(report.history, 'invalid');
  }
  // Individually safe counts with an overflowing/disjoint sum must still be rejected.
  assertUnknownHistory(parseHookReport({ ...source([]), history: history({ totals: { ...totals(0),
    events: Number.MAX_SAFE_INTEGER, prompts: Number.MAX_SAFE_INTEGER, toolStarts: Number.MAX_SAFE_INTEGER } }) }, window).history, 'invalid');
  const maximum = history({ totals: { ...totals(0), sessions: 1, events: Number.MAX_SAFE_INTEGER, prompts: Number.MAX_SAFE_INTEGER } });
  assert.deepEqual(parseHookReport({ ...source([]), history: maximum }, window).history, maximum);
});

test('history reasons are bounded and sanitized; unavailable states require null totals and range', () => {
  const reason = '<history>&\u0000\u001f\u007f\u009f\u202e\u2066';
  const report = parseHookReport({ ...source([]), history: history({ reason }) }, window);
  assert.equal(report.history.reason, '＜history＞＆      ');
  assert.equal(parseHookReport({ ...source([]), history: history({ reason: 'x'.repeat(512) }) }, window).history.reason.length, 512);
  for (const status of ['unavailable', 'invalid', 'truncated']) {
    const value = history({ status, range: { start: null, end: null }, totals: totals(null) });
    const parsed = parseHookReport({ status, reason: '', data: status === 'truncated' ? { events: [], skipped_lines: 0 } : null, history: value }, window);
    assert.deepEqual(parsed.history, value);
    assertUnknownHistory(parsed.history, status);
  }
});

test('validated history survives detail boundary failures but inconsistent available history is rejected', t => {
  const value = history({ totals: { ...totals(0), sessions: 20, events: 6000, prompts: 6000 } });
  for (const details of [source(Array.from({ length: 5001 }, () => rawRow())),
    source(Array.from({ length: 17 }, (_, i) => rawRow({ agent: `agent-${i}` }))),
    { ...source([]), data: null }, { ...source([]), data: { events: [], skipped_lines: -1 } },
    source([rawRow({ event_id: 'bad' })])]) {
    const report = parseHookReport({ ...details, history: value }, window);
    assert.equal(report.status, 'invalid');
    assert.deepEqual(report.history, value);
  }
  assertUnknownHistory(parseHookReport({ ...source([rawRow(), rawRow()]), history: history() }, window).history, 'invalid');
  assertUnknownHistory(parseHookReport({ ...source([rawRow({ kind: 'tool_start' })]), history: history() }, window).history, 'invalid');
  assertUnknownHistory(parseHookReport({ ...source([rawRow({ occurred_at: window.start })]), history: history() }, window).history, 'invalid');
  const f = fixture(t);
  seedHistory(f, { totals: { ...totals(0), sessions: 1, events: 1, prompts: 1 } });
  write(f.current, [row()]);
  const evidence = collectHookEvidence({ directory: f.directory, window: { start: 'bad', end: window.end } });
  assert.equal(evidence.status, 'invalid');
  assert.equal(evidence.history.status, 'available');
  assert.deepEqual(parseHookReport(evidence, window).history, evidence.history);
});

test('cumulative failures and unmatched tools are historical evidence, not current health findings', () => {
  const value = history({ range: { start: '2026-11-01T00:00:00.000Z', end: '2026-11-02T00:00:00.000Z' },
    totals: { ...totals(0), events: 2, sessions: 1, toolStarts: 1, openTools: 1, turnFailures: 1 } });
  const report = parseAgentDiagnostic({ schema_version: '1.0', source: 'agentsight', sampled_at: window.end, window, sources: {}, hooks: { ...source([]), history: value } });
  assert.deepEqual(report.hooks.history, value);
  assert.equal(report.outcome, 'unknown');
  assert.equal(report.hooks.agents.length, 0);
  assert(!report.findings.some(item => item.severity === 'error' || /轮次失败|未完成工具/.test(item.title)));
});

test('Hook failures affect outcome only for turn failures, independently of five AgentSight coverage entries', () => {
  const raw = { schema_version: '1.0', source: 'agentsight', sampled_at: window.end, window, sources: {} };
  const original = structuredClone(raw);
  const baseline = parseAgentDiagnostic(raw);
  assert.deepEqual(raw, original);
  assert.equal(baseline.hooks.status, 'unavailable');
  for (const kind of ['tool_failure', 'permission_denied', 'tool_start']) {
    const report = parseAgentDiagnostic({ ...raw, hooks: source([rawRow({ kind, call_id: 'c' })]) });
    assert.equal(report.outcome, 'unknown');
    assert.deepEqual(report.coverage, baseline.coverage);
  }
  const abnormal = parseAgentDiagnostic({ ...raw, hooks: source([rawRow({ kind: 'turn_failure' })]) });
  assert.equal(abnormal.outcome, 'abnormal');
  assert.equal(abnormal.status, 'unavailable');
  assert.equal(abnormal.coverage.length, 5);
  assert(abnormal.findings.some(item => item.severity === 'error' && /轮次/.test(item.title)));
  assert.throws(() => parseAgentDiagnostic({ ...raw, sources: { hooks: source([]) } }));
});
