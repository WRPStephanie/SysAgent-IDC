const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText;
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename })(id => {
    assert.equal(id, './agent-diagnostics-data');
    return load(path.resolve(path.dirname(filename), `${id}.ts`));
  }, module, module.exports);
  return module.exports;
}
const { buildHookActivity, pageItems } = load(path.resolve(__dirname, '../src/agent-hook-activity.ts'));
const { agentHookKindLabels } = load(path.resolve(__dirname, '../src/agent-diagnostics-data.ts'));
const kinds = Object.keys(agentHookKindLabels);
const window = { start: '2026-11-16T00:00:00.000Z', end: '2026-11-16T01:00:00.000Z' };
const totalKeys = ['sessions', 'events', 'prompts', 'toolStarts', 'toolEnds', 'toolFailures', 'interrupts', 'permissionDenied', 'turnFailures', 'openTools'];
const totals = overrides => ({ ...Object.fromEntries(totalKeys.map(key => [key, 0])), ...overrides });
let sequence = 0;
function event(overrides = {}) {
  return { id: String(++sequence).padStart(16, '0'), agent: 'qoder', kind: 'prompt_submit', occurredAt: window.start,
    sessionId: 'session-1', tool: null, callId: null, errorType: null, interrupt: null, subagent: null, model: null, ...overrides };
}
function summary(overrides = {}) {
  return { agent: 'qoder', ...totals(), lastEventAt: window.end, ...overrides };
}
function aggregate({ events = 0, kindCounts = {}, bins, sessions = [], tools = [], subagents = [], reason = '累计聚合已启用' } = {}) {
  return { events, range: events ? { start: window.start, end: window.end } : { start: null, end: null }, reason,
    kinds: kinds.map(kind => ({ kind, count: kindCounts[kind] ?? 0 })),
    bins: bins ?? (events ? [{ start: window.start, end: window.end, count: events, failures: 0, interrupts: 0 }] : []),
    sessions, tools, subagents };
}
function history(activity, countOverrides = {}) {
  return { scope: 'cumulative', status: 'available', reason: '累计已启用', sampledAt: window.end,
    range: activity.events ? activity.range : countOverrides.events ? { start: window.start, end: window.end } : { start: null, end: null },
    totals: totals({ events: activity.events, ...countOverrides }), activity };
}
function report(events = [], activity = aggregate(), overrides = {}) {
  return { status: 'available', reason: '', skippedLines: 0, agents: [], events, history: history(activity), ...overrides };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

for (const status of ['available', 'truncated']) {
  test(`${status}: cumulative charts remain independent of the latest 200 details`, () => {
    const details = Array.from({ length: 500 }, (_, index) => event({ id: String(index).padStart(16, '0'),
      kind: index < 300 ? 'turn_failure' : 'prompt_submit', occurredAt: new Date(Date.parse(window.start) + index * 1000).toISOString() }));
    const all = aggregate({ events: 12000, kindCounts: { prompt_submit: 7000, turn_failure: 5000 } });
    const source = freeze(report(details, all, { status, agents: [summary({ events: 5000, prompts: 200, turnFailures: 4800 })],
      history: history(all, { sessions: 6001, events: 12000, prompts: 7000, turnFailures: 5000 }) }));
    const copy = structuredClone(source);
    const result = buildHookActivity(source, window);
    assert.equal(result.events.length, 200);
    assert.deepEqual(result.events.map(row => row.id), details.slice(300).toReversed().map(row => row.id));
    assert.equal(result.sessions.reduce((sum, row) => sum + row.events, 0), 200);
    assert.equal(result.kinds.find(row => row.kind === 'turn_failure').count, 5000);
    assert.equal(result.kinds.find(row => row.kind === 'prompt_submit').count, 7000);
    assert.equal(result.bins.reduce((sum, row) => sum + row.count, 0), 12000);
    assert.equal(result.totals.events, 12000);
    assert.equal(result.agents[0].events, 5000);
    assert.deepEqual(source, copy);
  });
}

test('cumulative anonymous sessions never expose raw Hook Session IDs', () => {
  const hash = 'a'.repeat(64);
  const all = aggregate({ events: 4, kindCounts: { prompt_submit: 4 }, sessions: [{ key: hash, agent: 'qoder', events: 4,
    prompts: 4, toolStarts: 0, turnFailures: 0, firstEventAt: window.start, lastEventAt: window.end }] });
  const result = buildHookActivity(report([event({ sessionId: 'raw-session-id' })], all), window);
  assert.equal(result.sessions[0].sessionId, 'raw-session-id');
  assert.deepEqual(result.chartSessions, all.sessions);
  assert(!JSON.stringify(result.chartSessions).includes('raw-session-id'));
  assert.notEqual(result.chartSessions, all.sessions);
  assert.notEqual(result.chartSessions[0], all.sessions[0]);
});

test('tool and subagent rankings come only from cumulative aggregates', () => {
  const all = aggregate({ events: 9, kindCounts: { tool_start: 5, tool_end: 2, tool_failure: 1, subagent_start: 1 },
    tools: [{ tool: 'Bash', starts: 5, ends: 2, failures: 1, interrupts: 0, unmatched: 2 }],
    subagents: [{ subagent: 'Explore', starts: 1, stops: 0 }] });
  const details = [event({ kind: 'tool_start', tool: 'Read', callId: 'recent' }), event({ kind: 'subagent_stop', subagent: 'Plan' })];
  const result = buildHookActivity(report(details, all), window);
  assert.deepEqual(result.tools, all.tools);
  assert.deepEqual(result.subagents, all.subagents);
  assert(!JSON.stringify(result.tools).includes('Read'));
  assert(!JSON.stringify(result.subagents).includes('Plan'));
});

test('canonical cumulative kinds partition into five disjoint categories', () => {
  const kindCounts = Object.fromEntries(kinds.map(kind => [kind, 1]));
  const result = buildHookActivity(report([], aggregate({ events: kinds.length, kindCounts })), window);
  assert.deepEqual(result.categories, [
    { key: 'session', label: '会话', count: 6 }, { key: 'tool', label: '工具', count: 3 },
    { key: 'permission', label: '授权', count: 2 }, { key: 'collaboration', label: '协作', count: 7 },
    { key: 'context', label: '上下文', count: 2 },
  ]);
  assert.equal(result.categories.reduce((sum, row) => sum + row.count, 0), kinds.length);
});

test('time bins preserve cumulative endpoints and use Shanghai labels', () => {
  const bins = [
    { start: '2026-11-16T00:03:00.000Z', end: '2026-11-16T00:05:00.000Z', count: 2, failures: 1, interrupts: 0 },
    { start: '2026-11-16T00:05:00.000Z', end: '2026-11-16T00:07:00.000Z', count: 1, failures: 0, interrupts: 1 },
  ];
  const result = buildHookActivity(report([], aggregate({ events: 3, kindCounts: { prompt_submit: 3 }, bins })), { start: 'bad', end: 'bad' });
  assert.deepEqual(result.bins, bins.map((row, index) => ({ ...row, index, label: index ? '08:05' : '08:03' })));
});

test('latest detail sessions keep exact tuple isolation and actual timestamp extrema', () => {
  const result = buildHookActivity(report([
    event({ agent: 'a-b', sessionId: 'c', occurredAt: '2026-11-16T00:20:00.000Z' }),
    event({ agent: 'a', sessionId: 'b-c', occurredAt: '2026-11-16T00:40:00.000Z', kind: 'turn_failure' }),
    event({ agent: 'a-b', sessionId: 'c', occurredAt: '2026-11-16T00:50:00.000Z', kind: 'tool_start' }),
    event({ sessionId: null }),
  ]), window);
  assert.deepEqual(result.sessions.map(row => row.key), [JSON.stringify(['a-b', 'c']), JSON.stringify(['a', 'b-c'])]);
  assert.deepEqual(result.sessions[0], { key: JSON.stringify(['a-b', 'c']), agent: 'a-b', sessionId: 'c', events: 2,
    prompts: 1, toolStarts: 1, turnFailures: 0, lastEventAt: '2026-11-16T00:50:00.000Z', firstEventAt: '2026-11-16T00:20:00.000Z' });
});

test('unavailable cumulative history never falls back to recent details or bounded summaries', () => {
  const unavailable = { scope: 'cumulative', status: 'unavailable', reason: 'unknown', sampledAt: window.end,
    range: { start: null, end: null }, totals: Object.fromEntries(totalKeys.map(key => [key, null])), activity: null };
  for (const hooks of [null, undefined, report([event()], aggregate(), { history: undefined }),
    report([event()], aggregate(), { history: unavailable }), report([event()], aggregate(), { status: 'invalid' })]) {
    const result = buildHookActivity(hooks, window);
    assert.equal(result.aggregateAvailable, false);
    assert.equal(result.totals, null);
    assert.deepEqual(result.chartSessions, []);
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.subagents, []);
    assert.deepEqual(result.bins, []);
    assert(result.kinds.every(row => row.count === 0));
    assert(result.categories.every(row => row.count === 0));
  }
});

test('explicit 11-field detail allowlist prevents extra payload leaks', () => {
  const secret = event({ prompt: 'PRIVATE_PROMPT', toolInput: 'PRIVATE_INPUT', toolOutput: 'PRIVATE_OUTPUT', tokens: 999999 });
  Object.defineProperty(secret, 'arbitraryPayload', { enumerable: true, get() { throw new Error('must not read extras'); } });
  const source = report([secret], aggregate());
  Object.freeze(secret);
  const result = buildHookActivity(source, window);
  assert.deepEqual(Object.keys(result.events[0]), ['id', 'agent', 'kind', 'occurredAt', 'sessionId', 'tool', 'callId', 'errorType', 'interrupt', 'subagent', 'model']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|999999|arbitraryPayload/);
  assert.notEqual(result.events[0], secret);
});

test('pageItems clamps pages and preserves accurate ranges', () => {
  const items = freeze(Array.from({ length: 45 }, (_, index) => ({ index })));
  const pages = [1, 2, 3].map(page => pageItems(items, page, 20));
  assert.deepEqual(pages.map(({ page, pages, start, end, total, size }) => ({ page, pages, start, end, total, size })), [
    { page: 1, pages: 3, start: 1, end: 20, total: 45, size: 20 },
    { page: 2, pages: 3, start: 21, end: 40, total: 45, size: 20 },
    { page: 3, pages: 3, start: 41, end: 45, total: 45, size: 20 },
  ]);
  assert.deepEqual(pages.flatMap(page => page.rows), items);
  assert.deepEqual(pageItems(items, Infinity, 20), pages[2]);
  assert.deepEqual(pageItems(items, NaN, 20), pages[0]);
});

test('pageItems empty data and invalid sizes remain bounded', () => {
  assert.deepEqual(pageItems([], 20, 20), { rows: [], page: 1, pages: 1, start: 0, end: 0, total: 0, size: 20 });
  for (const size of [0, -10, 0.5, NaN, Infinity, -Infinity]) {
    assert.deepEqual(pageItems(['a', 'b'], 100, size), { rows: ['b'], page: 2, pages: 2, start: 2, end: 2, total: 2, size: 1 });
  }
});
