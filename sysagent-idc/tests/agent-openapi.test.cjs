const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const clientRequest = http.request;
const crypto = require('node:crypto');
const ts = require('typescript');
const { rawSnapshot } = require('./fixtures.cjs');

const root = path.resolve(__dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(root, 'openapi-contract.json'), 'utf8'));
const token = crypto.randomUUID();
const route = '/openapi/v1/agent-diagnostics';
const sampledAt = '2026-11-11T12:00:00.123Z';
const ms = Date.parse(sampledAt);
const ns = ms * 1e6; // Upstream number precision is deliberately display-only.
const MiB = 1024 * 1024;
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error('External or process action forbidden'); };

// Same TS transpilation/vm pattern as existing UI tests, without bundles or output files.
// Only loopback server creation and crypto are exposed to the real service module.
const modules = new Map();
function load(filename) {
  const absolute = path.resolve(filename);
  if (modules.has(absolute)) return modules.get(absolute).exports;
  const module = { exports: {} };
  modules.set(absolute, module);
  if (absolute.endsWith('.json')) module.exports = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  else {
    const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      fileName: absolute,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const execute = vm.runInThisContext(`(function(require,module,exports,fetch){${compiled}\n})`, { filename: absolute });
    execute(id => {
      if (id === 'node:crypto') return crypto;
      if (id === 'node:http') return { createServer: http.createServer, request: forbidden, get: forbidden };
      if (!id.startsWith('.')) return forbidden();
      const target = path.resolve(path.dirname(absolute), id);
      assert(target.startsWith(`${root}${path.sep}`), 'Only real project modules may load');
      return load(path.extname(target) ? target : `${target}.ts`);
    }, module, module.exports, forbidden);
  }
  return module.exports;
}
const { startMockOpenApi } = load(path.join(root, 'openapi-service.ts'));
const { parseAgentDiagnostic } = load(path.join(root, 'agent-diagnostics.ts'));
const source = (data, status = 'available', reason = '') => ({ status, reason, data });
const processRow = (overrides = {}) => ({ pid: 12, agent_name: 'fixture', role: 'cli', status: 'healthy', ports: [8080], last_check_time: ms, latency_ms: 0, parent_pid: null, has_crash: false, ...overrides });
const sessionRow = (overrides = {}) => ({ session_id: 'session-1', conversation_count: 0, first_seen_ns: ns, last_seen_ns: ns, total_input_tokens: 0, total_output_tokens: 0, agent_name: null, model: null, ...overrides });
const eventRow = (overrides = {}) => ({ interruption_id: 'event-1', session_id: null, call_id: null, pid: null, agent_name: null, interruption_type: 'tool_error', severity: 'low', occurred_at_ns: ns, resolved: false, ...overrides });
const countRow = (total = 0, critical = 0, high = 0) => ({ total, by_severity: { critical, high, medium: 0, low: total - critical - high } });
const latencyRow = (overrides = {}) => ({ agent_name: null, call_count: 0, streaming_call_count: 0, ttft_ms: null, tps_tokens_per_second: null, tpot_ms_per_token: null, e2e_latency_ms: null, ...overrides });
const hookRow = (index = 0, overrides = {}) => ({
  event_id: index.toString(16).padStart(16, '0'), agent: 'qoder', kind: 'prompt_submit',
  occurred_at: new Date(ms - index).toISOString(), session_id: 'hook/session:1',
  tool: null, call_id: null, error_type: null, interrupt: null, subagent: null, model: null, ...overrides,
});
function hookPayload(events = [hookRow()], status = 'available', skipped_lines = 0, reason = '') {
  const body = payload();
  body.raw_snapshot.hooks = source({ events, skipped_lines }, status, reason);
  return body;
}
function payload() {
  return {
    schema_version: '1.0', request_id: crypto.randomUUID(), device_id: crypto.randomUUID(),
    raw_snapshot: {
      schema_version: '1.0', source: 'agentsight', sampled_at: sampledAt,
      window: { start: '2026-11-10T12:00:00.123Z', end: sampledAt },
      sources: {
        processes: source({ agents: [processRow()], last_scan_time: ms, filtered_count: 0 }),
        sessions: source([sessionRow()]), interruptions: source([]), interruptionCounts: source(countRow()), latency: source([latencyRow()]),
      },
    },
  };
}
// SysAK collection evidence follows the idc_inspect schema 1.1 contract; the
// AgentSight envelopes above deliberately stay on their independent 1.0 contract.
function sysak(deviceId = crypto.randomUUID(), operation = 'snapshot', parameters = {}) {
  const requestId = crypto.randomUUID();
  const raw = rawSnapshot(requestId);
  raw.collection.status = 'partial';
  raw.collection.finished_at = sampledAt;
  return { schema_version: '1.1', request_id: requestId, device_id: deviceId, operation, parameters, raw_snapshot: raw };
}
function matches(schema, value, at = '$') {
  if (schema.$ref) matches(schema.$ref.slice(2).split('/').reduce((item, key) => item[key], spec), value, at);
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const, at);
  if (schema.enum) assert(schema.enum.includes(value), `${at}: enum`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert(types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) :
      type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) :
      type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type), `${at}: type`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined) assert([...value].length >= schema.minLength, at);
    if (schema.maxLength !== undefined) assert([...value].length <= schema.maxLength, at);
    if (schema.pattern) assert(new RegExp(schema.pattern).test(value), `${at}: pattern`);
    if (schema.format === 'date-time') assert(Number.isFinite(Date.parse(value)), at);
    if (schema === spec.components.schemas.AgentHookDateTime) assert.equal(new Date(value).toISOString(), value, `${at}: strict calendar milliseconds Z`);
    if (schema.format === 'uuid') assert.match(value, new RegExp(spec.components.schemas.UUID.pattern));
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), at);
    if (schema.minimum !== undefined) assert(value >= schema.minimum, at);
    if (schema.maximum !== undefined) assert(value <= schema.maximum, at);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert(value.length >= schema.minItems, at);
    if (schema.maxItems !== undefined) assert(value.length <= schema.maxItems, at);
    if (schema.uniqueItems) assert.equal(new Set(value.map(item => JSON.stringify(item))).size, value.length, at);
    if (schema.items) value.forEach((item, i) => matches(schema.items, item, `${at}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required ?? []) assert(Object.hasOwn(value, key), `${at}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) matches(schema.properties[key], item, `${at}.${key}`);
      else if (schema.additionalProperties === false) assert.fail(`${at}: unexpected ${key}`);
    }
  }
}
function parse(body = payload()) {
  const original = structuredClone(body);
  const report = parseAgentDiagnostic(body.raw_snapshot);
  assert.deepEqual(body, original, 'Parser must not mutate raw evidence');
  matches(spec.components.schemas.AgentDiagnostic, report);
  return report;
}
function exchange(api, url = route, { method = 'GET', body, text, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = text !== undefined ? text : body !== undefined ? JSON.stringify(body) : undefined;
    const request = clientRequest(`${api.baseUrl}${url}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(bytes !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.equal(response.headers['access-control-allow-origin'], undefined);
          assert.equal(response.headers['access-control-allow-credentials'], undefined);
          assert.match(response.headers['content-type'], /^application\/json/);
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode >= 400) matches(spec.components.schemas.ErrorResponse, json);
          resolve({ status: response.statusCode, headers: response.headers, json });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(bytes);
  });
}
const post = (api, body, options = {}) => exchange(api, route, { method: 'POST', body, ...options });
async function accepted(api, body = payload()) {
  const result = await post(api, body);
  assert.equal(result.status, 200, JSON.stringify(result.json));
  matches(spec.components.schemas.AgentDiagnosticResponse, result.json);
  assert.equal(result.json.request_id, body.request_id);
  assert.equal(result.json.task.id, result.json.task_id);
  assert.equal(result.json.task.operation, 'agent-diagnose');
  assert.equal(result.json.task.status, 'completed');
  assert.equal(result.json.task.simulated, false);
  assert.equal(result.json.read_only, true);
  assert.equal(result.json.raw_snapshot, undefined);
  assert.equal(result.json.state, undefined);
  assert.equal(result.json.receipt, undefined);
  assert.deepEqual(result.json.report, parse(body));
  return result.json;
}
async function rejected(api, body, status = 400, code = 'invalid_request', options = {}) {
  const result = await post(api, body, options);
  assert.equal(result.status, status, JSON.stringify(result.json));
  assert.equal(result.json.error.code, code);
  return result;
}
async function withServer(run) {
  const api = await startMockOpenApi({ token });
  try { return await run(api); } finally { await api.close(); }
}
const coverage = (report, key) => report.coverage.find(item => item.key === key);

function historyPayload() {
  const body = payload();
  body.raw_snapshot.history = { scope: 'all_stored', sampled_at: sampledAt, sources: {
    usage: source({ calls: 9001, inputTokens: 12002, outputTokens: 13003 }),
    sessions: source({ total: 1501 }), interruptionCounts: source(countRow(800, 300, 400)),
  } };
  return body;
}
const historyCoverage = (report, key) => report.history.coverage.find(item => item.key === key);
function assertCurrentUnchanged(report, baseline = parse()) {
  const current = structuredClone(report); delete current.history;
  assert.deepEqual(current, baseline, 'Historical evidence must not affect 24h totals, health, findings, summary or coverage');
}

test('AgentSight all_stored history isolated parser: optional history interprets only retained-history aggregates', () => {
  const baseline = parse();
  assert.equal(Object.hasOwn(baseline, 'history'), false, 'Missing raw history adds no evidence');
  const body = historyPayload();
  matches(spec.components.schemas.AgentRawSnapshot, body.raw_snapshot);
  const report = parse(body);
  assert.deepEqual(report.history, {
    scope: 'all_stored', sampledAt, status: 'ok',
    coverage: ['usage', 'sessions', 'interruptionCounts'].map(key => ({ key, status: 'available', reason: '' })),
    totals: { sessions: 1501, calls: 9001, inputTokens: 12002, outputTokens: 13003, unresolved: 800, critical: 300, high: 400 },
  });
  assertCurrentUnchanged(report, baseline);
  const unavailable = historyPayload(); unavailable.raw_snapshot.sources = {};
  const unavailableBaseline = payload(); unavailableBaseline.raw_snapshot.sources = {};
  const historyOnly = parse(unavailable);
  assert.equal(historyOnly.history.status, 'ok');
  assert.equal(historyOnly.status, 'unavailable'); assert.equal(historyOnly.outcome, 'unknown');
  assertCurrentUnchanged(historyOnly, parse(unavailableBaseline));
  const older = historyPayload(); older.raw_snapshot.history.sampled_at = '2026-10-01T00:00:00.000Z';
  assert.equal(parse(older).history.sampledAt, older.raw_snapshot.history.sampled_at);
});

test('AgentSight all_stored history isolated parser: independent failures null only that aggregate, never fall back to 24h', () => {
  const baseline = parse();
  const totalsByKey = { usage: ['calls', 'inputTokens', 'outputTokens'], sessions: ['sessions'], interruptionCounts: ['unresolved', 'critical', 'high'] };
  for (const key of Object.keys(totalsByKey)) {
    for (const status of ['unavailable', 'invalid', 'truncated']) {
      const body = historyPayload();
      const sources = body.raw_snapshot.history.sources;
      sources[key] = source(status === 'truncated' ? sources[key].data : null, status, 'not complete');
      const report = parse(body);
      assert.equal(report.history.status, 'partial');
      assert.equal(historyCoverage(report, key).status, status);
      for (const [other, names] of Object.entries(totalsByKey)) for (const name of names) {
        assert.equal(report.history.totals[name] === null, other === key, `${key} failure: ${name}`);
      }
      assertCurrentUnchanged(report, baseline);
    }
  }
  const failed = historyPayload();
  for (const key of Object.keys(failed.raw_snapshot.history.sources)) failed.raw_snapshot.history.sources[key] = source(null, 'unavailable', 'unsupported revision');
  const report = parse(failed);
  assert.equal(report.history.status, 'unavailable');
  assert(Object.values(report.history.totals).every(value => value === null));
  assertCurrentUnchanged(report, baseline);
  const empty = historyPayload();
  empty.raw_snapshot.history.sources = { usage: source({ calls: 0, inputTokens: 0, outputTokens: 0 }), sessions: source({ total: 0 }), interruptionCounts: source(countRow()) };
  assert.equal(parse(empty).history.status, 'ok');
  assert(Object.values(parse(empty).history.totals).every(value => value === 0));
});

test('AgentSight all_stored history isolated parser: strict aggregate whitelist, statuses, timestamps and safe counts', () => {
  const baseline = parse();
  const invalidHistory = [null, [], 'private-history', {},
    { ...historyPayload().raw_snapshot.history, scope: 'lifetime' },
    { ...historyPayload().raw_snapshot.history, scope: 'cumulative' },
    { ...historyPayload().raw_snapshot.history, sampled_at: '2026-02-30T12:00:00Z' },
    { ...historyPayload().raw_snapshot.history, sampled_at: '2026-11-11T24:00:00Z' },
    { ...historyPayload().raw_snapshot.history, sampled_at: '2026-11-11T12:00:00' },
    { ...historyPayload().raw_snapshot.history, sampled_at: '2026-11-12T12:00:00.000Z' },
    { ...historyPayload().raw_snapshot.history, sampled_at: Infinity },
    { ...historyPayload().raw_snapshot.history, private: 'private-history' },
    { ...historyPayload().raw_snapshot.history, sources: [] },
    { ...historyPayload().raw_snapshot.history, sources: { ...historyPayload().raw_snapshot.history.sources, other: source({ total: 0 }) } },
  ];
  for (const history of invalidHistory) {
    const body = payload(); body.raw_snapshot.history = history;
    const report = parse(body);
    assert.equal(report.history.status, 'unavailable');
    assert(report.history.coverage.every(row => row.status === 'invalid'));
    assert(Object.values(report.history.totals).every(value => value === null));
    assert.doesNotMatch(JSON.stringify(report), /private-history/);
    assertCurrentUnchanged(report, baseline);
  }
  for (const key of ['usage', 'sessions', 'interruptionCounts']) {
    const malformed = [null, [], {}, source(null), source({}, 'healthy'), source({}, 'unavailable'),
      source(null, 'invalid', 'x'.repeat(513)), { status: 'available', data: {} },
      { ...source({}), raw: 'private-history' }];
    for (const invalidSource of malformed) {
      const body = historyPayload(); body.raw_snapshot.history.sources[key] = invalidSource;
      const report = parse(body);
      assert.equal(historyCoverage(report, key).status, 'invalid');
      assert.equal(report.history.status, 'partial');
      assertCurrentUnchanged(report, baseline);
    }
  }
  for (const bad of [NaN, Infinity, -Infinity, -1, 1.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    for (const name of ['calls', 'inputTokens', 'outputTokens']) {
      const body = historyPayload(); body.raw_snapshot.history.sources.usage.data[name] = bad;
      const report = parse(body);
      assert.equal(historyCoverage(report, 'usage').status, 'invalid');
      assert.deepEqual([report.history.totals.calls, report.history.totals.inputTokens, report.history.totals.outputTokens], [null, null, null]);
      assertCurrentUnchanged(report, baseline);
    }
    const body = historyPayload(); body.raw_snapshot.history.sources.sessions.data.total = bad;
    assert.equal(historyCoverage(parse(body), 'sessions').status, 'invalid');
  }
  for (const [key, data] of [
    ['usage', { calls: 1, inputTokens: 2, outputTokens: 3, cacheTokens: 4 }],
    ['usage', { calls: 1, inputTokens: 2 }], ['sessions', { total: 1, rows: [] }], ['sessions', []],
    ['interruptionCounts', { ...countRow(), extra: 0 }],
    ['interruptionCounts', { total: 0, by_severity: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 } }],
    ['interruptionCounts', countRow(5, 4, 3)],
    ['interruptionCounts', { total: Number.MAX_SAFE_INTEGER, by_severity: { critical: Number.MAX_SAFE_INTEGER, high: 1, medium: 0, low: 0 } }],
  ]) {
    const body = historyPayload(); body.raw_snapshot.history.sources[key].data = data;
    const report = parse(body);
    assert.equal(historyCoverage(report, key).status, 'invalid');
    assertCurrentUnchanged(report, baseline);
  }
  const boundary = historyPayload();
  boundary.raw_snapshot.history.sources.usage.data = { calls: Number.MAX_SAFE_INTEGER, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 };
  boundary.raw_snapshot.history.sources.sessions.data = { total: Number.MAX_SAFE_INTEGER };
  assert.equal(parse(boundary).history.status, 'ok');
  const safe = historyPayload(); safe.raw_snapshot.history.sources.usage.reason = '<tag>&\n\u202e';
  assert.doesNotMatch(historyCoverage(parse(safe), 'usage').reason, /[<>&\n\u202e]/);
  safe.raw_snapshot.history.sources.usage.status = 'truncated';
  safe.raw_snapshot.history.sources.usage.reason = 'x'.repeat(512);
  assert.equal(historyCoverage(parse(safe), 'usage').reason.length, 512);
  assert.equal(forbiddenCalls, 0);
});

test('real modules type-check against the shared AgentDiagnostic with required hooks without emission', () => {
  const program = ts.createProgram([path.join(root, 'agent-diagnostics.ts'), path.join(root, 'openapi-service.ts')], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true, noEmit: true,
    resolveJsonModule: true, esModuleInterop: true, skipLibCheck: true, types: ['node'],
    typeRoots: [path.join(root, 'node_modules/@types')],
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});

test('contract references resolve, independent capability is explicit and authenticated HTTP returns the real contract', async () => withServer(async api => {
  function walk(value) {
    if (value === null || typeof value !== 'object') return;
    for (const key of ['$ref', 'x-valid-data-schema']) if (value[key]) {
      assert(value[key].slice(2).split('/').reduce((item, name) => item?.[name], spec), `Unresolved ${value[key]}`);
    }
    Object.values(value).forEach(walk);
  }
  walk(spec);
  assert.equal(Object.keys(spec.paths).length, 6);
  assert.deepEqual(spec.security, [{ BearerAuth: [] }]);
  assert.equal(spec.paths[route].post.operationId, 'submitAgentDiagnostics');
  for (const code of ['200', '400', '401', '403', '405', '409', '413', '415', '503']) assert(spec.paths[route].post.responses[code]);
  matches(spec.components.schemas.AgentDiagnosticRequest, payload());
  const capabilities = (await exchange(api, '/openapi/v1/capabilities')).json;
  matches(spec.components.schemas.Capabilities, capabilities);
  assert.deepEqual(capabilities.collection_operations, ['snapshot', 'reset', 'inspect']);
  assert.equal(capabilities.collection.collector, 'sysak');
  assert.deepEqual(capabilities.agent_diagnostics, {
    route, method: 'POST', source: 'agentsight', operation: 'agent-diagnose', independent_evidence: true,
    requires_sysak_snapshot: false, requires_revision: false, mutates_sysak_snapshot: false,
    analyzer: 'local-rules', external_calls: false,
    source_limits: { processes: 256, sessions: 500, interruptions: 200, interruptionCounts: 1, latency: 256 },
    hook_limits: { events: 5000, recent: 200, agents: 16 },
  });
  assert.deepEqual((await exchange(api, '/openapi/v1/openapi.json')).json, spec);
}));

test('latency contract is an array of strict agent-group rows bounded at 256', () => {
  const schema = spec.components.schemas.AgentRawLatency;
  assert.equal(schema.type, 'array');
  assert.equal(schema.maxItems, 256);
  assert.deepEqual(schema.items, { $ref: '#/components/schemas/AgentRawLatencyRow' });
  assert.equal(spec.components.schemas.AgentDiagnostic.properties.latency.maxItems, 256);
  matches(schema, []);
  matches(schema, [latencyRow()]);
  matches(schema, [latencyRow(), latencyRow({ agent_name: 'agent-a' })]);
  matches(schema, Array.from({ length: 256 }, (_, i) => latencyRow({ agent_name: `agent-${i}` })));
  assert.throws(() => matches(schema, latencyRow()));
  assert.throws(() => matches(schema, Array.from({ length: 257 }, (_, i) => latencyRow({ agent_name: `agent-${i}` }))));
  assert.throws(() => matches(schema, [latencyRow({ extra: 'private-field' })]));
});

test('Hook contract declares strict metadata schemas, independent optional raw input and required bounded report', () => {
  const schemas = spec.components.schemas;
  assert.equal(schemas.AgentRawSnapshot.required.includes('hooks'), false);
  assert.equal(schemas.AgentRawSnapshot.properties.hooks['x-valid-data-schema'], '#/components/schemas/AgentRawHooks');
  assert.match(schemas.AgentRawSnapshot.properties.hooks.description, /200.*hooks.invalid/);
  assert.equal(schemas.AgentRawSnapshot.properties.sources.properties.hooks, undefined);
  assert.ok(schemas.AgentDiagnostic.required.includes('hooks'));
  assert.equal(schemas.AgentDiagnostic.properties.coverage.minItems, 5);
  assert.equal(schemas.AgentDiagnostic.properties.coverage.maxItems, 5);
  assert.equal(schemas.AgentDiagnostic.properties.findings.maxItems, 527);
  assert.equal(schemas.AgentRawHooks.properties.events.maxItems, 5000);
  assert.equal(schemas.AgentHookReport.properties.events.maxItems, 200);
  assert.equal(schemas.AgentHookReport.properties.agents.maxItems, 16);
  const { agentHookKindLabels } = load(path.join(root, 'src/agent-diagnostics-data.ts'));
  assert.deepEqual(schemas.AgentHookKind.enum, Object.keys(agentHookKindLabels));
  matches(schemas.AgentRawHooks, { events: [hookRow()], skipped_lines: 0 });
  for (const key of ['AgentRawHookSource', 'AgentRawHooks', 'AgentRawHookEvent', 'AgentHookEvent', 'AgentHookAgentSummary', 'AgentHookReport']) {
    assert.equal(schemas[key].additionalProperties, false, key);
    const properties = Object.keys(schemas[key].properties);
    assert.deepEqual(new Set(schemas[key].required), new Set(properties.filter(name => name !== 'history')), key);
    if (properties.includes('history')) assert.deepEqual(schemas[key].properties.history, { $ref: '#/components/schemas/AgentHookHistory' }, key);
  }
  const invalid = [
    { event_id: '0123456789ABCDEF' }, { event_id: '0123456789abcde' }, { agent: 'Qoder' }, { agent: '-qoder' }, { agent: 'a'.repeat(33) },
    { kind: 'PreToolUse' }, { occurred_at: '2026-11-11T12:00:00Z' }, { occurred_at: '2026-11-11T12:00:00.123+00:00' },
    { occurred_at: '2026-02-30T12:00:00.123Z' }, { session_id: '' }, { session_id: 'a'.repeat(129) },
    { tool: 'read file' }, { call_id: 'call\n1' }, { error_type: '<private>' }, { subagent: 'sub\nagent' }, { model: 'model\tv1' },
    { interrupt: 'false' }, { raw: 'secret' },
  ];
  invalid.forEach(overrides => assert.throws(() => matches(schemas.AgentRawHookEvent, hookRow(0, overrides))));
  for (const value of [null, 'Aa0._:@/+-']) matches(schemas.AgentHookIdentifier, value);
  for (const value of [null, 'code reviewer', 'model v1._:@/+-']) matches(schemas.AgentHookLabel, value);
  assert.throws(() => matches(schemas.AgentRawHooks, { events: [], skipped_lines: -1 }));
  assert.throws(() => matches(schemas.AgentRawHooks, { events: Array.from({ length: 5001 }, (_, i) => hookRow(i)), skipped_lines: 0 }));
  const report = parse();
  delete report.hooks;
  assert.throws(() => matches(schemas.AgentDiagnostic, report));
});

test('HTTP absent/empty/unavailable/invalid/truncated Hooks preserve independent AgentSight status and five sources', async () => withServer(async api => {
  const baseline = (await accepted(api)).report;
  assert.deepEqual(baseline.hooks, { status: 'unavailable', reason: '未采集 Agent Hook 元数据。', skippedLines: null, agents: [], events: [] });
  for (const status of ['available', 'unavailable', 'invalid', 'truncated']) {
    const body = payload();
    body.raw_snapshot.hooks = source(status === 'available' || status === 'truncated' ? { events: [], skipped_lines: 0 } : null, status, 'metadata only');
    const report = (await accepted(api, body)).report;
    assert.deepEqual(report.hooks, { status, reason: 'metadata only', skippedLines: status === 'available' || status === 'truncated' ? 0 : null, agents: [], events: [] });
    assert.equal(report.status, baseline.status);
    assert.equal(report.outcome, baseline.outcome);
    assert.deepEqual(report.coverage, baseline.coverage);
    assert.equal(report.coverage.length, 5);
    assert.deepEqual(report.totals, baseline.totals);
  }
  const wrongPlace = payload(); wrongPlace.raw_snapshot.sources.hooks = source({ events: [], skipped_lines: 0 });
  await rejected(api, wrongPlace); // Unknown sources keys still fail the envelope.
}));

test('HTTP Hook summaries pair tools by session/call and keep cancellations, denials and open starts non-fault observations', async () => withServer(async api => {
  const entries = [
    ['prompt_submit', 's/1', null, null], ['tool_start', 's/1', 'call:1', null], ['tool_end', 's/1', 'call:1', null],
    ['tool_start', 's/1', 'call:1', null], ['tool_failure', 's/1', 'call:1', true], ['tool_failure', 's/1', null, null],
    ['permission_denied', 's/1', null, null], ['turn_stop', 's/1', null, null], ['tool_start', 's/2', 'call:1', null],
    ['tool_end', 's/1', 'call:1', false], ['tool_start', null, 'call:2', null],
  ];
  const events = entries.map(([kind, session_id, call_id, interrupt], i) => hookRow(i, {
    kind, session_id, call_id, interrupt, occurred_at: new Date(ms - (entries.length - 1 - i)).toISOString(),
    tool: kind.startsWith('tool_') ? 'read_file' : null, error_type: kind === 'tool_failure' ? 'cancelled' : null,
    subagent: 'code reviewer', model: 'model v1',
  })).reverse(); // Input order is not chronological.
  const { report } = await accepted(api, hookPayload(events, 'available', 7));
  assert.equal(report.status, 'ok');
  assert.equal(report.outcome, 'observed');
  assert.equal(report.hooks.skippedLines, 7);
  assert.deepEqual(report.hooks.agents, [{ agent: 'qoder', sessions: 2, events: 11, prompts: 1, toolStarts: 4, toolEnds: 2, toolFailures: 1, interrupts: 1, permissionDenied: 1, turnFailures: 0, openTools: 1, lastEventAt: sampledAt }]);
  assert.deepEqual(report.hooks.events.map(row => row.id), events.map(row => row.event_id));
  for (const row of report.hooks.events) assert.deepEqual(Object.keys(row), ['id', 'agent', 'kind', 'occurredAt', 'sessionId', 'tool', 'callId', 'errorType', 'interrupt', 'subagent', 'model']);
  assert.equal(report.findings.filter(row => row.title.startsWith('qoder')).length, 3);
  assert(report.findings.every(row => row.severity === 'info'));
  const noSight = hookPayload([hookRow(0, { kind: 'turn_failure' })]);
  noSight.raw_snapshot.sources = {};
  const failure = (await accepted(api, noSight)).report;
  assert.equal(failure.status, 'unavailable');
  assert.equal(failure.outcome, 'abnormal');
  assert.equal(failure.hooks.status, 'available');
  assert.equal(failure.hooks.agents[0].turnFailures, 1);
  assert.equal(failure.coverage.length, 5);
  assert.match(failure.findings.find(row => row.title.includes('轮次失败')).detail, /原因未知/);
}));

test('HTTP Hook bounds accept 5000 events/16 agents, count the full input and return only latest 200', async () => withServer(async api => {
  const events = Array.from({ length: 5000 }, (_, i) => hookRow(i, { agent: `agent-${i % 16}` })).reverse();
  matches(spec.components.schemas.AgentRawHooks, { events, skipped_lines: 0 });
  const report = (await accepted(api, hookPayload(events))).report;
  assert.equal(report.status, 'ok');
  assert.equal(report.hooks.status, 'available');
  assert.equal(report.hooks.events.length, 200);
  assert.deepEqual(report.hooks.events.map(row => row.id), Array.from({ length: 200 }, (_, i) => hookRow(i).event_id));
  assert.equal(report.hooks.agents.length, 16);
  assert.equal(report.hooks.agents.reduce((sum, agent) => sum + agent.events, 0), 5000);
  assert.deepEqual(report.hooks.agents.map(row => row.agent), [...new Set(events.map(row => row.agent))].sort((a, b) => a.localeCompare(b)));
  assert(report.hooks.agents.every(row => row.sessions === 1 && row.prompts === row.events));
  const truncated = (await accepted(api, hookPayload(events, 'truncated', 12, 'collector bounded'))).report;
  assert.equal(truncated.hooks.status, 'truncated');
  assert.equal(truncated.hooks.skippedLines, 12);
  assert.equal(truncated.status, 'ok');
  assert.deepEqual(truncated.coverage, report.coverage);
  assert.equal(truncated.hooks.events.length, 200);
  for (const rows of [[...events, hookRow(5000)], Array.from({ length: 17 }, (_, i) => hookRow(i, { agent: `agent-${i}` }))]) {
    const invalid = (await accepted(api, hookPayload(rows))).report;
    assert.equal(invalid.hooks.status, 'invalid');
    assert.equal(invalid.hooks.skippedLines, null);
    assert.deepEqual(invalid.hooks.agents, []);
    assert.deepEqual(invalid.hooks.events, []);
    assert.equal(invalid.status, 'ok');
    assert.deepEqual(invalid.coverage, report.coverage);
  }
}));

test('HTTP malformed Hook sources and any invalid row fail closed at 200 without leaking raw fields', async () => withServer(async api => {
  const malformed = [null, [], 'raw-secret', {}, source([], 'available'), source(null, 'available'), source({ events: [], skipped_lines: 0 }, 'unavailable'),
    source(null, 'healthy'), source(null, 'invalid', 'x'.repeat(513)), { status: 'available', data: { events: [], skipped_lines: 0 } },
    { ...source({ events: [], skipped_lines: 0 }), raw: 'raw-secret' },
    source({ events: [], skipped_lines: -1 }), source({ events: [], skipped_lines: 1.5 }), source({ events: [], skipped_lines: Number.MAX_SAFE_INTEGER + 1 }),
    source({ events: [], skipped_lines: 0, prompt: 'raw-secret' }), source({ events: [hookRow(), hookRow()], skipped_lines: 0 }),
  ];
  const rowInvalidators = [
    row => { row.event_id = '0123456789ABCDEF'; }, row => { row.agent = 'Qoder'; }, row => { row.kind = 'PreToolUse'; },
    row => { row.occurred_at = '2026-02-30T12:00:00.123Z'; }, row => { row.occurred_at = '2026-11-11T12:00:00Z'; },
    row => { row.occurred_at = '2026-11-11T12:00:00.123+00:00'; }, row => { row.occurred_at = new Date(ms + 1).toISOString(); },
    row => { row.occurred_at = new Date(ms - 24 * 3600 * 1000 - 1).toISOString(); },
    row => { row.session_id = ''; }, row => { row.tool = 'read file'; }, row => { row.call_id = 'call\n1'; },
    row => { row.error_type = '<raw-secret>'; }, row => { row.model = 'bad\nmodel'; }, row => { row.subagent = 'a'.repeat(129); },
    row => { row.interrupt = 'false'; }, row => { delete row.model; },
    ...['prompt', 'tool_input', 'tool_output', 'error_body', 'command', 'path', 'raw', 'input_tokens'].map(key => row => { row[key] = 'raw-secret'; }),
  ];
  for (const invalidate of rowInvalidators) {
    const row = hookRow(1); invalidate(row);
    malformed.push(source({ events: [hookRow(), row], skipped_lines: 0 }));
  }
  for (const hooks of malformed) {
    const body = payload(); body.raw_snapshot.hooks = hooks;
    const report = (await accepted(api, body)).report;
    assert.equal(report.hooks.status, 'invalid');
    assert.deepEqual(report.hooks.events, []);
    assert.deepEqual(report.hooks.agents, []);
    assert.equal(report.hooks.skippedLines, null);
    assert.equal(report.status, 'ok');
    assert.equal(report.outcome, 'observed');
    assert.equal(report.coverage.length, 5);
    assert(report.coverage.every(row => row.status === 'available'));
    assert.doesNotMatch(JSON.stringify(report), /raw-secret/);
  }
  for (const badTail of [null, hookRow(0), hookRow(4999, { prompt: 'raw-secret' })]) {
    const events = Array.from({ length: 4999 }, (_, i) => hookRow(i)); events.push(badTail);
    const report = (await accepted(api, hookPayload(events))).report;
    assert.equal(report.hooks.status, 'invalid', 'Invalid rows beyond recent 200 are not silently discarded');
    assert.deepEqual(report.hooks.events, []);
  }
  const boundary = hookPayload([hookRow(0, { occurred_at: payload().raw_snapshot.window.start }), hookRow(1, { occurred_at: sampledAt })]);
  assert.equal((await accepted(api, boundary)).report.hooks.status, 'available');
  const safeReason = (await accepted(api, hookPayload([], 'available', 0, '<tag>&\n\u202e'))).report.hooks.reason;
  assert.doesNotMatch(safeReason, /[<>&\n\u202e]/);
}));

test('Hook report schemas enforce required fields, whitelist, safe counts and 200/16/527 bounds', () => {
  const report = parse(hookPayload());
  const invalidators = [
    body => { delete body.hooks; }, body => { body.hooks.raw = {}; }, body => { body.hooks.skippedLines = -1; },
    body => { body.hooks.events[0].raw = {}; }, body => { delete body.hooks.events[0].interrupt; },
    body => { body.hooks.agents[0].events = 5001; }, body => { body.hooks.agents[0].openTools = -1; },
    body => { body.hooks.events = Array.from({ length: 201 }, () => body.hooks.events[0]); },
    body => { body.hooks.agents = Array.from({ length: 17 }, () => body.hooks.agents[0]); },
    body => { body.coverage.push({ key: 'hooks', status: 'available', reason: '' }); },
    body => { body.findings = Array.from({ length: 528 }, () => ({ severity: 'info', title: '', detail: '', suggestion: '' })); },
  ];
  for (const invalidate of invalidators) {
    const invalid = structuredClone(report); invalidate(invalid);
    assert.throws(() => matches(spec.components.schemas.AgentDiagnostic, invalid));
  }
  report.findings = Array.from({ length: 527 }, () => ({ severity: 'info', title: '', detail: '', suggestion: '' }));
  matches(spec.components.schemas.AgentDiagnostic, report);
});

test('Bearer, Origin, POST-only, media and compression restrictions apply before evidence parsing', async () => withServer(async api => {
  for (const Authorization of ['', 'Basic x', 'Bearer wrong']) {
    const result = await rejected(api, payload(), 401, 'unauthorized', { headers: { Authorization } });
    assert.equal(result.headers['www-authenticate'], 'Bearer');
  }
  for (const Origin of ['null', api.baseUrl, 'https://invalid.example']) await rejected(api, payload(), 403, 'origin_not_allowed', { headers: { Origin } });
  for (const method of ['GET', 'PUT', 'OPTIONS']) {
    const result = await exchange(api, route, { method });
    assert.equal(result.status, 405);
    assert.equal(result.headers.allow, 'POST');
  }
  await rejected(api, payload(), 415, 'unsupported_media_type', { headers: { 'Content-Type': 'text/plain' } });
  await rejected(api, payload(), 415, 'unsupported_media_type', { headers: { 'Content-Encoding': 'gzip' } });
  await accepted(api);
}));

test('request shapes and ISO calendar/window boundaries fail closed without tasks or snapshots', async () => withServer(async api => {
  const invalidators = [
    body => { body.request_id = 'bad'; }, body => { body.device_id = null; }, body => { body.schema_version = '2.0'; },
    body => { body.parameters = { revision: 1 }; }, body => { body.operation = 'agent-diagnose'; }, body => { body.revision = 1; },
    body => { body.raw_snapshot = null; }, body => { body.raw_snapshot.schema_version = '2.0'; }, body => { body.raw_snapshot.source = 'sysak'; },
    body => { body.raw_snapshot.sources = []; }, body => { body.raw_snapshot.sources.other = source([]); },
    body => { body.raw_snapshot.sampled_at = '2026-02-31T12:00:00Z'; }, body => { body.raw_snapshot.sampled_at = '2026-11-11T24:00:00Z'; },
    body => { body.raw_snapshot.sampled_at = '2026-11-11T12:00:00'; }, body => { body.raw_snapshot.sampled_at = ms; },
    body => { body.raw_snapshot.window.start = 'bad'; }, body => { body.raw_snapshot.window.end = '2026-11-12T12:00:00Z'; },
    body => { body.raw_snapshot.window.start = '2026-11-12T12:00:00Z'; }, body => { body.raw_snapshot.window.extra = true; },
  ];
  for (const invalidate of invalidators) {
    const body = payload(); invalidate(body);
    await rejected(api, body);
    if (typeof body.device_id === 'string') assert.equal((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).status, 404);
  }
  for (const text of ['null', '[]', '1', '{', '"text"']) await rejected(api, undefined, 400, 'invalid_request', { text });
  await rejected(api, undefined, 400, 'invalid_request', { text: Buffer.from([0xff]) });
  const body = payload();
  await rejected(api, undefined, 400, 'invalid_request', { text: JSON.stringify(body).replace('{', '{"schema_version":"2.0",') });
  await accepted(api, body); // Rejected duplicate-envelope request was not cached.
}));

test('exact 10 MiB request and 8 MiB raw whitespace boundaries, Content-Length and chunked overflow', async () => withServer(async api => {
  const body = payload();
  let text = JSON.stringify(body);
  text += ' '.repeat(10 * MiB - Buffer.byteLength(text));
  assert.equal((await post(api, undefined, { text, headers: { 'Content-Length': 10 * MiB } })).status, 200);
  await rejected(api, undefined, 413, 'request_too_large', { text: `${text} `, headers: { 'Content-Length': 10 * MiB + 1 } });
  await rejected(api, undefined, 413, 'request_too_large', { text: `${text} `, headers: { 'Transfer-Encoding': 'chunked' } });
  const next = payload();
  const raw = JSON.stringify(next.raw_snapshot);
  const exact = `{${' '.repeat(8 * MiB - Buffer.byteLength(raw))}${raw.slice(1)}`;
  text = JSON.stringify(next).replace(raw, exact);
  assert.equal((await post(api, undefined, { text })).status, 200);
  const overflow = payload();
  const overflowRaw = JSON.stringify(overflow.raw_snapshot);
  text = JSON.stringify(overflow).replace(overflowRaw, `{${' '.repeat(8 * MiB)}${overflowRaw.slice(1)}`);
  await rejected(api, undefined, 413, 'raw_snapshot_too_large', { text });
}));

test('zero, null, ns/ms timestamps and complete observations preserve upstream semantics', async () => withServer(async api => {
  const body = payload();
  body.raw_snapshot.sources.latency = source([latencyRow({ call_count: 2, streaming_call_count: 1, ttft_ms: { p50: 0, p95: 12.5, p99: 15 }, tps_tokens_per_second: { p50: 0, p95: 1, p99: 2 }, e2e_latency_ms: { p50: 0, p95: 0, p99: 0 } })]);
  const { report } = await accepted(api, body);
  assert.equal(report.status, 'ok'); assert.equal(report.outcome, 'observed');
  assert.deepEqual(report.totals, { sessions: 1, inputTokens: 0, outputTokens: 0, unresolved: 0, critical: 0, high: 0 });
  assert.equal(report.lastScanAt, sampledAt);
  assert.equal(report.processes[0].lastCheckAt, sampledAt);
  assert.equal(report.processes[0].latencyMs, 0); assert.equal(report.processes[0].parentPid, null);
  assert.equal(report.sessions[0].firstSeenAt, new Date(ns / 1e6).toISOString());
  assert.equal(report.sessions[0].agent, null); assert.equal(report.sessions[0].model, null);
  assert.deepEqual(report.latency[0], { agent: null, calls: 2, streamingCalls: 1, ttftP95Ms: 12.5, e2eP95Ms: 0, tpsP50: 0, tpotP95Ms: null });
  assert.match(report.summary, /已采集会话/); assert.match(report.summary, /HTTP 任意状态响应/);
  assert.match(report.summary, /完整调用/); assert.match(report.summary, /包含辅助调用/);
  assert.match(report.summary, /不是会话终身累计/); assert.match(report.summary, /输入包含缓存用量/);
  assert.match(report.summary, /已采集列表/); assert.match(report.summary, /未报告 usage 的调用可能以零记录/);
  assert.doesNotMatch(report.summary, /默认排除辅助调用/);
  assert.deepEqual(Object.keys(report.totals).sort(), ['sessions', 'inputTokens', 'outputTokens', 'unresolved', 'critical', 'high'].sort(),
    'Historical unreported usage must not fabricate a missing-usage metric');
  body.request_id = crypto.randomUUID();
  body.raw_snapshot.window = { start: '1970-01-01T00:00:00.000Z', end: '1970-01-01T00:00:00.000Z' };
  body.raw_snapshot.sources.sessions.data[0] = sessionRow({ first_seen_ns: 0, last_seen_ns: 0 });
  const zero = (await accepted(api, body)).report;
  assert.equal(coverage(zero, 'sessions').status, 'available');
  assert.equal(zero.sessions[0].firstSeenAt, '1970-01-01T00:00:00.000Z');
  assert.equal(zero.sessions[0].lastSeenAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual([zero.totals.sessions, zero.totals.inputTokens, zero.totals.outputTokens], [1, 0, 0]);
}));

test('HTTP session window includes both boundaries and rejects an entire source with any out-of-window row', async () => withServer(async api => {
  const body = payload();
  const startNs = Number(BigInt(Date.parse(body.raw_snapshot.window.start)) * 1000000n);
  const endNs = Number(BigInt(Date.parse(body.raw_snapshot.window.end)) * 1000000n);
  // Use a whole ms offset: upstream numeric ns precision is display-only, not an exact ns identity.
  const oneMs = 1000000;
  const bounds = [[startNs, startNs], [endNs, endNs], [startNs, endNs], [startNs + oneMs, endNs - oneMs]];
  body.raw_snapshot.sources.sessions.data = bounds.map(([first_seen_ns, last_seen_ns], index) =>
    sessionRow({ session_id: `boundary-${index}`, first_seen_ns, last_seen_ns, total_input_tokens: index, total_output_tokens: index * 2 }));
  const inclusive = (await accepted(api, body)).report;
  assert.equal(coverage(inclusive, 'sessions').status, 'available');
  assert.equal(inclusive.sessions.length, 4);
  assert.equal(inclusive.sessions[0].firstSeenAt, body.raw_snapshot.window.start);
  assert.equal(inclusive.sessions[0].lastSeenAt, body.raw_snapshot.window.start);
  assert.equal(inclusive.sessions[1].firstSeenAt, body.raw_snapshot.window.end);
  assert.equal(inclusive.sessions[1].lastSeenAt, body.raw_snapshot.window.end);
  assert.deepEqual([inclusive.totals.sessions, inclusive.totals.inputTokens, inclusive.totals.outputTokens], [4, 6, 12]);

  const point = payload();
  point.raw_snapshot.window.start = point.raw_snapshot.window.end;
  const pointReport = (await accepted(api, point)).report;
  assert.equal(coverage(pointReport, 'sessions').status, 'available');
  assert.deepEqual([pointReport.totals.sessions, pointReport.totals.inputTokens, pointReport.totals.outputTokens], [1, 0, 0]);

  const outside = [
    [startNs - oneMs, startNs], [startNs - oneMs, startNs - oneMs],
    [startNs, endNs + oneMs], [endNs + oneMs, endNs + oneMs],
    [startNs - oneMs, endNs + oneMs],
  ];
  for (const [first_seen_ns, last_seen_ns] of outside) {
    for (const position of ['head', 'tail', 'past-cap']) {
      const invalid = payload();
      const valid = Array.from({ length: position === 'past-cap' ? 500 : 1 }, (_, index) =>
        sessionRow({ session_id: `valid-${index}`, total_input_tokens: 7, total_output_tokens: 9 }));
      const bad = sessionRow({ session_id: 'outside', first_seen_ns, last_seen_ns, total_input_tokens: 10, total_output_tokens: 20 });
      invalid.raw_snapshot.sources.sessions.data = position === 'head' ? [bad, ...valid] : [...valid, bad];
      const report = (await accepted(api, invalid)).report;
      assert.equal(coverage(report, 'sessions').status, 'invalid', `${position}: ${first_seen_ns}..${last_seen_ns}`);
      assert.match(coverage(report, 'sessions').reason, /整个来源/);
      assert.deepEqual(report.sessions, [], 'Do not silently discard only out-of-window rows, even after the 500-row cap');
      assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [null, null, null]);
      assert.equal(report.status, 'partial');
      assert.equal(report.outcome, 'unknown');
      assert.equal(coverage(report, 'processes').status, 'available', 'Other valid sources remain usable');
    }
  }
}));

test('HTTP 500 rows are complete but 501 rows or upstream truncation keep all three session totals unknown', async () => withServer(async api => {
  const body = payload();
  const rows = Array.from({ length: 501 }, (_, index) => sessionRow({ session_id: `session-${index}`, total_input_tokens: 2, total_output_tokens: 3 }));
  body.raw_snapshot.sources.sessions = source(rows.slice(0, 500));
  let report = (await accepted(api, body)).report;
  assert.equal(coverage(report, 'sessions').status, 'available');
  assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [500, 1000, 1500]);
  for (const sessions of [source(rows), source(rows.slice(0, 500), 'truncated', 'upstream limit'), source([], 'truncated', 'upstream limit')]) {
    body.request_id = crypto.randomUUID();
    body.raw_snapshot.sources.sessions = sessions;
    report = (await accepted(api, body)).report;
    assert.equal(coverage(report, 'sessions').status, 'truncated');
    assert.match(coverage(report, 'sessions').reason, /500.*不代表完整覆盖/);
    assert.equal(report.sessions.length, Math.min(sessions.data.length, 500));
    assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [null, null, null]);
    if (report.sessions.length) assert.deepEqual([report.sessions[0].inputTokens, report.sessions[0].outputTokens], [2, 3]);
    assert.equal(report.status, 'partial');
    assert.equal(report.outcome, 'unknown');
    assert.equal(report.totals.unresolved, 0, 'Unknown session totals do not overwrite recorded interruption zero');
  }
}));

test('single and multiple latency groups preserve nulls and zeros without aggregate quantiles', async () => withServer(async api => {
  const body = payload();
  const groups = [
    latencyRow({ agent_name: 'agent-a', call_count: 2, streaming_call_count: 1,
      ttft_ms: { p50: 0, p95: 0, p99: 0 }, tps_tokens_per_second: { p50: 0, p95: 1, p99: 2 },
      tpot_ms_per_token: { p50: 0, p95: 0, p99: 0 }, e2e_latency_ms: { p50: 5, p95: 10, p99: 15 } }),
    latencyRow({ agent_name: 'agent-b', call_count: 3, e2e_latency_ms: { p50: 0, p95: 0, p99: 0 } }),
    latencyRow(),
  ];
  const expected = [
    { agent: 'agent-a', calls: 2, streamingCalls: 1, ttftP95Ms: 0, e2eP95Ms: 10, tpsP50: 0, tpotP95Ms: 0 },
    { agent: 'agent-b', calls: 3, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: 0, tpsP50: null, tpotP95Ms: null },
    { agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: null, tpsP50: null, tpotP95Ms: null },
  ];
  body.raw_snapshot.sources.latency.data = groups.slice(0, 1);
  let report = (await accepted(api, body)).report;
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.deepEqual(report.latency, expected.slice(0, 1));
  body.request_id = crypto.randomUUID();
  body.raw_snapshot.sources.latency.data = groups;
  report = (await accepted(api, body)).report;
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.deepEqual(report.latency, expected);
  const latencyOnly = payload();
  latencyOnly.raw_snapshot.sources = { latency: source([]) };
  report = (await accepted(api, latencyOnly)).report;
  assert.equal(report.status, 'partial');
  assert.equal(report.outcome, 'unknown');
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.deepEqual(report.latency, []);
  assert(Object.values(report.totals).every(value => value === null));
}));

test('empty evidence, all unavailable and malformed sources never fabricate health or zero measurements', async () => withServer(async api => {
  const empty = payload();
  empty.raw_snapshot.sources.processes.data.agents = [];
  empty.raw_snapshot.sources.sessions.data = [];
  empty.raw_snapshot.sources.latency.data = [];
  let report = (await accepted(api, empty)).report;
  assert.equal(report.status, 'ok'); assert.equal(report.outcome, 'unknown');
  assert.equal(report.totals.sessions, 0); assert.deepEqual(report.latency, []);
  assert.equal(coverage(report, 'latency').status, 'available');
  assert.equal(report.findings.length, 0);
  const missing = payload(); missing.raw_snapshot.sources = {};
  report = (await accepted(api, missing)).report;
  assert.equal(report.status, 'unavailable'); assert.equal(report.outcome, 'unknown');
  assert(Object.values(report.totals).every(value => value === null));
  assert.equal(report.findings.length, 5);
  const unavailable = payload();
  unavailable.raw_snapshot.sources = Object.fromEntries(Object.keys(unavailable.raw_snapshot.sources).map(key => [key, source(null, 'unavailable', 'not running')]));
  report = (await accepted(api, unavailable)).report;
  assert.equal(report.status, 'unavailable'); assert.equal(report.lastScanAt, null);
  unavailable.request_id = crypto.randomUUID();
  for (const key of Object.keys(unavailable.raw_snapshot.sources)) unavailable.raw_snapshot.sources[key] = source('malformed', 'available');
  report = (await accepted(api, unavailable)).report;
  assert.equal(report.status, 'unavailable'); assert.equal(report.outcome, 'unknown');
  assert(report.coverage.every(item => item.status === 'invalid'));
}));

test('scan zero/stale/future and unchecked rows are unknown; fresh probe findings are not confirmed root causes', () => {
  for (const scan of [0, ms - 120001, ms + 1]) {
    const body = payload();
    body.raw_snapshot.sources.processes.data.last_scan_time = scan;
    body.raw_snapshot.sources.processes.data.agents = [processRow({ status: 'hung' }), processRow({ pid: 13, status: 'offline', has_crash: true })];
    const report = parse(body);
    assert.equal(report.outcome, 'unknown'); assert(report.processes.every(row => row.status === 'unknown'));
    assert.match(report.findings.map(item => item.detail).join(' '), /仅为探活新鲜度阈值/);
    if (scan === 0) assert.equal(report.lastScanAt, null);
  }
  for (const check of [0, ms - 120001, ms + 1]) {
    const body = payload(); body.raw_snapshot.sources.processes.data.agents[0].last_check_time = check;
    const report = parse(body); assert.equal(report.outcome, 'unknown'); assert.equal(report.processes[0].status, 'unknown');
  }
  for (const [status, has_crash, outcome] of [['healthy', false, 'observed'], ['no_port', false, 'observed'], ['offline', false, 'observed'], ['offline', true, 'abnormal'], ['hung', false, 'abnormal'], ['unhealthy', false, 'abnormal'], ['unknown', false, 'unknown']]) {
    const body = payload(); body.raw_snapshot.sources.processes.data.agents = [processRow({ status, has_crash })];
    const report = parse(body); assert.equal(report.outcome, outcome);
    if (outcome === 'abnormal') assert.match(report.findings[0].detail, /故障根因尚未确认/);
    else assert.equal(report.findings.length, 0);
  }
});

test('nullable IDs and count > 200 use whole-window count, never list length; resolved events are not abnormalities', async () => withServer(async api => {
  const body = payload();
  body.raw_snapshot.sources.interruptions = source(Array.from({ length: 200 }, (_, i) => eventRow({ interruption_id: `event-${i}`, severity: 'critical' })), 'truncated', 'limit200');
  body.raw_snapshot.sources.interruptionCounts = source(countRow(900, 400, 300));
  const report = (await accepted(api, body)).report;
  assert.equal(report.status, 'partial'); assert.equal(report.outcome, 'abnormal');
  assert.deepEqual([report.totals.unresolved, report.totals.critical, report.totals.high], [900, 400, 300]);
  assert.equal(report.interruptions.length, 200);
  assert.equal(report.interruptions[0].sessionId, null); assert.equal(report.interruptions[0].callId, null); assert.equal(report.interruptions[0].pid, null);
  assert.equal(report.interruptions[0].occurredAt, new Date(ns / 1e6).toISOString());
  assert.match(coverage(report, 'interruptions').reason, /200.*不代表完整覆盖/);
  const listOnly = payload(); listOnly.raw_snapshot.sources = { interruptions: source([eventRow()]) };
  const partial = (await accepted(api, listOnly)).report;
  assert.equal(partial.outcome, 'abnormal'); assert.equal(partial.totals.unresolved, null); assert.equal(partial.totals.critical, null);
  const countsOnly = payload(); countsOnly.raw_snapshot.sources = { interruptionCounts: source(countRow(700, 300, 200)) };
  assert.equal((await accepted(api, countsOnly)).report.outcome, 'abnormal');
  const resolved = payload(); resolved.raw_snapshot.sources.interruptions = source([eventRow({ resolved: true })]);
  assert.equal((await accepted(api, resolved)).report.outcome, 'observed');
}));

test('all list caps and upstream truncated flags remain partial; truncated session/count totals stay null', () => {
  const body = payload();
  body.raw_snapshot.sources.processes.data.agents = Array.from({ length: 257 }, (_, i) => processRow({ pid: i }));
  body.raw_snapshot.sources.sessions.data = Array.from({ length: 501 }, (_, i) => sessionRow({ session_id: `s-${i}`, total_input_tokens: 1, total_output_tokens: 2 }));
  body.raw_snapshot.sources.interruptions.data = Array.from({ length: 201 }, (_, i) => eventRow({ interruption_id: `i-${i}` }));
  body.raw_snapshot.sources.latency.data = Array.from({ length: 257 }, (_, i) => latencyRow({ agent_name: `agent-${i}` }));
  let report = parse(body);
  assert.deepEqual([report.processes.length, report.sessions.length, report.interruptions.length, report.latency.length], [256, 500, 200, 256]);
  for (const key of ['processes', 'sessions', 'interruptions', 'latency']) assert.equal(coverage(report, key).status, 'truncated');
  assert.equal(report.latency[255].agent, 'agent-255');
  assert.match(coverage(report, 'latency').reason, /256.*不代表完整覆盖/);
  assert.deepEqual([report.totals.sessions, report.totals.inputTokens, report.totals.outputTokens], [null, null, null]);
  const upstream = payload(); upstream.raw_snapshot.sources.sessions.status = 'truncated';
  upstream.raw_snapshot.sources.interruptionCounts = source(countRow(4, 1, 2), 'truncated', 'partial count');
  upstream.raw_snapshot.sources.latency.status = 'truncated';
  report = parse(upstream);
  assert.equal(report.status, 'partial'); assert.equal(report.outcome, 'abnormal');
  assert(Object.values(report.totals).every(value => value === null));
  assert.equal(coverage(report, 'latency').status, 'truncated');
});

test('malformed individual sources invalidate their entire evidence, including invalid rows past caps', async () => withServer(async api => {
  const cases = [
    ['processes', data => { data.agents = {}; }], ['processes', data => { data.agents.push(processRow({ pid: 13, latency_ms: -1 })); }],
    ['processes', data => { data.agents[0].status = 'normal'; }], ['processes', data => { data.agents[0].has_crash = 'false'; }],
    ['processes', data => { data.agents[0].parent_pid = '1'; }], ['processes', data => { data.agents[0].ports = [65536]; }],
    ['processes', data => { data.agents[0].last_check_time = 1.5; }], ['processes', data => { data.filtered_count = -1; }],
    ['sessions', data => { data.push(sessionRow({ session_id: 's-2', total_input_tokens: null })); }],
    ['sessions', data => { data[0].conversation_count = 1.1; }], ['sessions', data => { data[0].first_seen_ns = -1; }],
    ['sessions', data => { data[0].first_seen_ns = ns + 1e9; }], ['sessions', data => { delete data[0].model; }],
    ['sessions', data => { data.push(sessionRow()); }],
    ['interruptions', data => { data.push(eventRow({ resolved: 'false' })); }], ['interruptions', data => { data.push(eventRow({ severity: 'fatal' })); }],
    ['interruptionCounts', data => { data.total = 1; }], ['interruptionCounts', data => { data.by_severity.high = -1; }],
    ['latency', data => { data[0].ttft_ms = { p95: 12 }; }], ['latency', data => { data[0].streaming_call_count = 1; }],
    ['latency', data => { data[0].e2e_latency_ms = { p50: 2, p95: 1, p99: 3 }; }],
    ['latency', data => { data.push(null); }], ['latency', data => { data.push([]); }],
    ['latency', data => { data.push(latencyRow({ agent_name: 'bad-agent', call_count: -1 })); }],
    ['latency', data => { data[0].agent_name = ''; }], ['latency', data => { delete data[0].tpot_ms_per_token; }],
    ['latency', data => { data.push(latencyRow()); }],
    ['latency', data => { data[0].agent_name = 'duplicate'; data.push(latencyRow({ agent_name: 'duplicate', call_count: 1 })); }],
    ['latency', data => { data[0].detail = 'private-latency-field'; }],
    ['latency', data => { data[0].ttft_ms = { p50: 0, p95: 0, p99: 0, detail: 'private-quantile-field' }; }],
  ];
  for (const [key, mutate] of cases) {
    const body = payload(); mutate(body.raw_snapshot.sources[key].data);
    const report = (await accepted(api, body)).report;
    assert.equal(coverage(report, key).status, 'invalid', key); assert.equal(report.status, 'partial'); assert.equal(report.outcome, 'unknown');
    if (key === 'processes') assert.deepEqual(report.processes, []);
    if (key === 'sessions') { assert.deepEqual(report.sessions, []); assert.equal(report.totals.sessions, null); }
    if (key === 'interruptions') assert.deepEqual(report.interruptions, []);
    if (key === 'interruptionCounts') assert.equal(report.totals.unresolved, null);
    if (key === 'latency') assert.deepEqual(report.latency, []);
  }
  for (const malformed of [null, [], { status: 'healthy', reason: '', data: [] }, { status: 'available', data: [] }, source([], 'unavailable'), source(null), source(null, 'invalid', 'x'.repeat(513))]) {
    const body = payload(); body.raw_snapshot.sources.sessions = malformed;
    assert.equal(coverage((await accepted(api, body)).report, 'sessions').status, 'invalid');
  }
  const body = payload(); body.raw_snapshot.sources.latency.data = latencyRow();
  const objectReport = (await accepted(api, body)).report;
  assert.equal(coverage(objectReport, 'latency').status, 'invalid');
  assert.deepEqual(objectReport.latency, []);
  const beyond = payload();
  beyond.raw_snapshot.sources.sessions.data = Array.from({ length: 501 }, (_, i) => sessionRow({ session_id: `s-${i}` }));
  beyond.raw_snapshot.sources.sessions.data[500].total_output_tokens = -1;
  assert.deepEqual((await accepted(api, beyond)).report.sessions, []);
  for (const last of [null, latencyRow({ agent_name: 'bad-tail', call_count: -1 }), latencyRow({ agent_name: 'agent-0' })]) {
    const latencyBeyond = payload();
    latencyBeyond.raw_snapshot.sources.latency.data = [
      ...Array.from({ length: 256 }, (_, i) => latencyRow({ agent_name: `agent-${i}` })), last,
    ];
    const report = (await accepted(api, latencyBeyond)).report;
    assert.equal(coverage(report, 'latency').status, 'invalid');
    assert.deepEqual(report.latency, []);
  }
}));

test('nonfinite numbers, unsafe sums and duplicate identities do not become zeros or complete measurements', () => {
  for (const bad of [NaN, Infinity, -Infinity, -1, '0', null, Number.MAX_SAFE_INTEGER + 1]) {
    const body = payload(); body.raw_snapshot.sources.sessions.data[0].total_input_tokens = bad;
    const report = parse(body); assert.equal(coverage(report, 'sessions').status, 'invalid'); assert.equal(report.totals.inputTokens, null);
  }
  for (const bad of [NaN, Infinity, -Infinity, -1, '0', null]) {
    const body = payload();
    body.raw_snapshot.sources.latency.data[0] = latencyRow({ call_count: 1, ttft_ms: { p50: bad, p95: 0, p99: 0 } });
    const report = parse(body);
    assert.equal(coverage(report, 'latency').status, 'invalid');
    assert.deepEqual(report.latency, []);
  }
  for (const bad of [NaN, Infinity, -Infinity, -1, '0', null, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const body = payload(); body.raw_snapshot.sources.latency.data[0].call_count = bad;
    assert.equal(coverage(parse(body), 'latency').status, 'invalid');
  }
  for (const key of ['processes', 'sessions', 'interruptions', 'latency']) {
    const body = payload();
    if (key === 'processes') body.raw_snapshot.sources.processes.data.agents = [processRow(), processRow()];
    if (key === 'sessions') body.raw_snapshot.sources.sessions.data = [sessionRow(), sessionRow()];
    if (key === 'interruptions') body.raw_snapshot.sources.interruptions.data = [eventRow(), eventRow()];
    if (key === 'latency') body.raw_snapshot.sources.latency.data = [latencyRow(), latencyRow()];
    assert.equal(coverage(parse(body), key).status, 'invalid');
  }
  const overflow = payload();
  overflow.raw_snapshot.sources.sessions.data = [sessionRow({ total_input_tokens: Number.MAX_SAFE_INTEGER }), sessionRow({ session_id: 's-2', total_input_tokens: 1 })];
  const report = parse(overflow); assert.equal(coverage(report, 'sessions').status, 'invalid'); assert.deepEqual(report.sessions, []);
});

test('unknown interruption types remain safe text; severity/type suggestions never trigger actions or leak detail', async () => withServer(async api => {
  for (const interruption_type of ['constructor', '__proto__', '<script>touch /tmp/nope</script>\n', 'new_upstream_type', 'user_cancel', 'llm_error', 'dead_loop', 'sse_truncated', 'context_overflow', 'token_limit', 'agent_crash']) {
    const body = payload();
    body.raw_snapshot.sources.interruptions = source([eventRow({ interruption_type, severity: 'high' })]);
    body.raw_snapshot.sources.interruptionCounts = source(countRow(1, 0, 1));
    const report = (await accepted(api, body)).report;
    assert.equal(report.outcome, 'abnormal');
    const finding = report.findings.find(item => item.title.startsWith('未处理中断'));
    assert.equal(finding.severity, 'error'); assert.equal(typeof finding.suggestion, 'string');
    assert.doesNotMatch(JSON.stringify(finding), /<script>|function Object|native code/);
    if (['constructor', '__proto__', 'new_upstream_type'].includes(interruption_type)) {
      assert.equal(report.interruptions[0].type, interruption_type); assert.match(finding.title, /未知类型/);
    }
    if (interruption_type === 'user_cancel') assert.match(finding.suggestion, /不等于 Agent 故障/);
  }
  const privateBody = payload();
  privateBody.raw_snapshot.sources.interruptions = source([eventRow({ detail: 'secret-user-question-and-path' })]);
  const safe = (await accepted(api, privateBody)).report;
  assert.equal(coverage(safe, 'interruptions').status, 'invalid');
  assert(!JSON.stringify(safe).includes('secret-user-question-and-path'));
  assert.equal(forbiddenCalls, 0);
}));

test('real parsing performs no external HTTP, LLM/fetch, shell, restart or process actions', async () => {
  const childProcess = require('node:child_process');
  const https = require('node:https');
  const changes = [
    [globalThis, 'fetch'], [process, 'kill'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    ...['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'].map(key => [childProcess, key]),
  ];
  const saved = changes.map(([owner, key]) => [owner, key, owner[key]]);
  for (const [owner, key] of changes) owner[key] = forbidden;
  try {
    await withServer(async api => {
      const body = hookPayload([
        hookRow(0, { kind: 'turn_failure' }), hookRow(1, { kind: 'permission_denied' }),
        hookRow(2, { kind: 'tool_failure', interrupt: true }),
      ]);
      body.raw_snapshot.sources.processes.data.agents[0] = processRow({ status: 'offline', has_crash: true });
      body.raw_snapshot.sources.interruptions = source([eventRow({ interruption_type: 'llm_error', severity: 'critical' })]);
      body.raw_snapshot.sources.interruptionCounts = source(countRow(1, 1));
      const result = await accepted(api, body);
      assert.equal(result.report.outcome, 'abnormal');
      assert.equal(result.report.hooks.status, 'available');
      const { queryDataset, datasetCatalog } = require('../electron/query-data.cjs');
      const view = { state: null, agent: structuredClone(result.report), tasks: [], status: { enabled: false } };
      const before = structuredClone(view);
      function freeze(value) {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
      }
      freeze(view);
      for (const name of ['agent-hook-events', 'agent-hook-agents']) {
        const query = queryDataset(view, name, new URLSearchParams('sort=-agent&fields=id,agent'));
        assert.equal(query.meta.source, 'agent-hooks');
        assert.equal(query.meta.status, 'available');
        assert.equal(query.meta.revision, null);
        assert.equal(query.meta.coverage.sources, undefined);
        assert.deepEqual(query.meta.coverage.window, result.report.window);
        assert.ok(query.items.length);
        const detail = queryDataset(view, name, new URLSearchParams(), query.items[0].id);
        assert.equal(detail.item.agent, 'qoder');
        detail.item.agent = 'changed';
        query.meta.coverage.reason = 'changed';
        assert.deepEqual(view, before);
      }
      assert.equal(datasetCatalog(view).datasets.length, 17);
      assert.deepEqual(view, before);
      assert.deepEqual(await accepted(api, body), result);
      assert.equal((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).status, 404);
      assert.equal((await exchange(api, `/openapi/v1/tasks/${result.task_id}`)).status, 200);
      await rejected(api, { ...payload(), command: 'restart; resolve; kill' });
      assert.equal(forbiddenCalls, 0);
    });
  } finally {
    for (const [owner, key, original] of saved) owner[key] = original;
  }
});

test('independent submission, replay bytes/route conflicts, synchronous tasks and SysAK snapshots/revisions are unchanged', async () => withServer(async api => {
  const body = payload();
  const concurrent = await Promise.all([accepted(api, body), accepted(api, body)]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).status, 404);
  const task = await exchange(api, `/openapi/v1/tasks/${concurrent[0].task_id.toUpperCase()}`);
  assert.deepEqual(task.json.task, concurrent[0].task);
  matches(spec.components.schemas.TaskResponse, task.json);
  await rejected(api, undefined, 409, 'idempotency_conflict', { text: JSON.stringify(body, null, 2) });
  const changed = structuredClone(body); changed.raw_snapshot.sources.processes.data.filtered_count = 1;
  await rejected(api, changed, 409, 'idempotency_conflict');
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body })).status, 409);
  const initialBody = sysak(body.device_id);
  const initial = await exchange(api, '/openapi/v1/collections', { method: 'POST', body: initialBody });
  assert.equal(initial.status, 200); matches(spec.components.schemas.CollectionResponse, initial.json);
  assert.equal(initial.json.state.revision, 1);
  const next = payload(); next.device_id = body.device_id;
  next.raw_snapshot.sources.processes.data.agents[0].status = 'hung';
  assert.equal((await accepted(api, next)).report.outcome, 'abnormal');
  assert.deepEqual((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).json, initial.json);
  assert.deepEqual((await accepted(api, body)), concurrent[0]);
  const inspect = sysak(body.device_id, 'inspect', { revision: 1 });
  const inspected = await exchange(api, '/openapi/v1/collections', { method: 'POST', body: inspect });
  assert.equal(inspected.status, 200); assert.equal(inspected.json.state.revision, 2);
  const stale = sysak(body.device_id, 'inspect', { revision: 1 });
  const conflict = await exchange(api, '/openapi/v1/collections', { method: 'POST', body: stale });
  assert.equal(conflict.status, 409); assert.equal(conflict.json.error.code, 'revision_conflict');
  await accepted(api, { ...payload(), device_id: body.device_id });
  assert.deepEqual((await exchange(api, `/openapi/v1/devices/${body.device_id}/snapshot`)).json, inspected.json);
  const legacyWrite = sysak(body.device_id, 'cleanup', { revision: 2 });
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: legacyWrite })).json.error.code, 'read_only');
  const wrongRoute = await post(api, initialBody);
  assert.equal(wrongRoute.status, 409); assert.equal(wrongRoute.json.error.code, 'idempotency_conflict');
  const wrongCollector = sysak(); wrongCollector.raw_snapshot = payload().raw_snapshot;
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: wrongCollector })).status, 400);
}));

test('shared FIFO retains at most 100 tasks/results without AgentSight consuming device capacity', async () => withServer(async api => {
  const deviceId = crypto.randomUUID();
  const old = sysak(deviceId);
  const initial = (await exchange(api, '/openapi/v1/collections', { method: 'POST', body: old })).json;
  const firstBody = payload();
  const first = await accepted(api, firstBody);
  const results = [];
  for (let i = 0; i < 98; i++) results.push(await accepted(api));
  assert.deepEqual(await accepted(api, firstBody), first); // Replay must not refresh FIFO.
  results.push(await accepted(api));
  assert.equal((await exchange(api, `/openapi/v1/tasks/${initial.task_id}`)).status, 404);
  assert.equal((await exchange(api, `/openapi/v1/tasks/${first.task_id}`)).status, 200);
  results.push(await accepted(api));
  assert.equal((await exchange(api, `/openapi/v1/tasks/${first.task_id}`)).status, 404);
  for (const result of results) assert.equal((await exchange(api, `/openapi/v1/tasks/${result.task_id}`)).status, 200);
  assert.deepEqual((await exchange(api, `/openapi/v1/devices/${deviceId}/snapshot`)).json, initial);
  const replayAfterEviction = await accepted(api, firstBody);
  assert.notEqual(replayAfterEviction.task_id, first.task_id);
  assert.equal((await exchange(api, `/openapi/v1/tasks/${results[0].task_id}`)).status, 404);
  for (let i = 0; i < 31; i++) assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: sysak() })).status, 200);
  assert.equal((await exchange(api, '/openapi/v1/collections', { method: 'POST', body: sysak() })).json.error.code, 'device_capacity');
  await accepted(api); // Independent route still accepts evidence at full SysAK device capacity.
  assert.equal(forbiddenCalls, 0);
}));
