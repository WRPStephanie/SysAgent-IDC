const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { prepareAgentSight } = require('./agentsight-deployment.cjs');
const { connectRootIdc } = require('./sysak-root.cjs');

const MANAGED_API = 'http://127.0.0.1:7397';
const collectionMessages = {
  running: '真实调用采集运行中（主机级范围，本地保存会话内容）',
  disabled: '真实调用采集未授权或已停用；API 可用不代表已采集调用',
  failed: '真实调用采集服务启动失败；请检查独立服务权限或内核支持',
  unavailable: '无法检查真实调用采集服务；请检查配套安装与当前用户授权',
};
function collectionStatus(value) {
  if (!value || !Object.hasOwn(collectionMessages, value.state) || typeof value.enabled !== 'boolean' ||
      typeof value.trace_running !== 'boolean' || typeof value.api_running !== 'boolean' ||
      !['host', 'none'].includes(value.scope) || value.enabled !== (value.scope === 'host') ||
      value.state === 'running' && (!value.enabled || !value.trace_running || !value.api_running) ||
      !value.enabled && (value.trace_running || value.api_running)) throw new Error('invalid collection status');
  return { state: value.state, enabled: value.enabled, scope: value.scope,
    trace_running: value.trace_running, api_running: value.api_running, message: collectionMessages[value.state] };
}
function unavailableCollection() {
  return collectionStatus({ state: 'unavailable', enabled: false, scope: 'none', trace_running: false, api_running: false });
}
async function controlAgentCollection(binary, action = 'ensure', launchImpl = connectRootIdc) {
  if (!['status', 'ensure', 'disable'].includes(action)) throw new AgentSightError('INVALID_COLLECTION_ACTION', '采集服务操作无效', 400);
  return new Promise(resolve => {
    let child;
    let size = 0;
    let done = false;
    let timer;
    const chunks = [];
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    try {
      child = launchImpl(binary, ['idc', '--agent-collection', action]);
      timer = setTimeout(() => { finish(unavailableCollection()); child.kill(); }, 35000);
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > 16384) { finish(unavailableCollection()); child.kill(); }
        else chunks.push(Buffer.from(chunk));
      });
      child.stderr.resume();
      child.once('error', () => finish(unavailableCollection()));
      child.once('close', code => {
        try {
          const value = collectionStatus(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          finish(code === 0 || code === 1 && value.state !== 'running' ? value : unavailableCollection());
        }
        catch { finish(unavailableCollection()); }
      });
      child.stdin.end();
    } catch { finish(unavailableCollection()); }
  });
}

const SOURCE_KEYS = ['processes', 'sessions', 'interruptions', 'interruptionCounts', 'latency'];
const RESPONSE_LIMIT = 2 * 1024 * 1024;

class AgentSightError extends Error {
  constructor(code, message, status = 503, retryable = false) {
    super(message);
    Object.assign(this, { code, status, retryable });
  }
}

function agentSightUrl(value) {
  let url;
  try { url = new URL(value); } catch {
    throw new AgentSightError('INVALID_AGENTSIGHT_URL', 'AgentSight 地址无效', 400);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new AgentSightError('INVALID_AGENTSIGHT_URL', 'AgentSight 仅支持不含凭据的本机回环服务地址', 400);
  }
  return url.origin;
}

async function readText(response, mime, signal) {
  if (!mime.test(response.headers.get('content-type') || '')) {
    await response.body?.cancel();
    throw new AgentSightError('AGENTSIGHT_INVALID_RESPONSE', 'AgentSight 响应媒体类型不兼容', 502);
  }
  if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT) {
    await response.body?.cancel();
    throw new AgentSightError('AGENTSIGHT_TOO_LARGE', 'AgentSight 单项响应超过 2 MiB 限制', 413);
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new AgentSightError('AGENTSIGHT_INVALID_RESPONSE', 'AgentSight 响应正文缺失', 502);
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new AgentSightError('AGENTSIGHT_TOO_LARGE', 'AgentSight 单项响应超过 2 MiB 限制', 413);
      chunks.push(Buffer.from(value));
    }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch {
      throw new AgentSightError('AGENTSIGHT_INVALID_RESPONSE', 'AgentSight 响应正文不是有效 UTF-8', 502);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function readJson(response, signal) {
  const body = await readText(response, /^application\/json(?:\s*;|\s*$)/i, signal);
  try { return JSON.parse(body); } catch {
    throw new AgentSightError('AGENTSIGHT_INVALID_RESPONSE', 'AgentSight 返回了无效 JSON', 502);
  }
}

const fields = {
  processes: ['pid', 'agent_name', 'role', 'status', 'ports', 'last_check_time', 'latency_ms', 'parent_pid', 'has_crash'],
  sessions: ['session_id', 'conversation_count', 'first_seen_ns', 'last_seen_ns', 'total_input_tokens', 'total_output_tokens', 'agent_name', 'model'],
  interruptions: ['interruption_id', 'session_id', 'call_id', 'pid', 'agent_name', 'interruption_type', 'severity', 'occurred_at_ns', 'resolved'],
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const select = (value, keys) => object(value) ? Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])) : null;

function minimize(key, data) {
  const limit = key === 'processes' || key === 'latency' ? 256 : key === 'sessions' ? 500 : 200;
  const rows = key === 'processes' ? data?.agents : data;
  if (fields[key]) {
    if (!Array.isArray(rows)) return { status: 'invalid', reason: 'AgentSight 数据列表格式不兼容', data: null };
    const selected = rows.slice(0, limit).map(row => {
      const result = select(row, fields[key]);
      if (key === 'processes' && result && !Object.hasOwn(result, 'parent_pid')) result.parent_pid = null;
      return result;
    });
    return { status: rows.length > limit ? 'truncated' : 'available', reason: rows.length > limit ? `展示上限 ${limit} 条，数据未完整返回` : '',
      data: key === 'processes' ? { agents: selected, last_scan_time: data.last_scan_time, filtered_count: data.filtered_count } : selected };
  }
  if (key === 'interruptionCounts') return { status: 'available', reason: '', data: { total: data?.total, by_severity: select(data?.by_severity, ['critical', 'high', 'medium', 'low']) } };
  if (!Array.isArray(data)) return { status: 'invalid', reason: 'AgentSight 延迟数据列表格式不兼容', data: null };
  const selected = data.slice(0, limit).map(row => {
    const result = select(row, ['agent_name', 'call_count', 'streaming_call_count']);
    if (!result) return null;
    for (const name of ['ttft_ms', 'tps_tokens_per_second', 'tpot_ms_per_token', 'e2e_latency_ms']) {
      result[name] = row[name] === null ? null : select(row[name], ['p50', 'p95', 'p99']);
    }
    return result;
  });
  return { status: data.length > limit ? 'truncated' : 'available', reason: data.length > limit ? `展示上限 ${limit} 条，数据未完整返回` : '', data: selected };
}

const HISTORY_KEYS = ['usage', 'sessions', 'interruptionCounts'];
const STORED_RANGE = 'start_ns=-9223372036854775808&end_ns=9223372036854775807';
const USAGE_FAMILIES = {
  agentsight_token_input_total: { key: 'inputTokens', help: 'Total input tokens consumed by agent (all-time)' },
  agentsight_token_output_total: { key: 'outputTokens', help: 'Total output tokens consumed by agent (all-time)' },
  agentsight_llm_requests_total: { key: 'calls', help: 'Total LLM requests made by agent (all-time)' },
};
const safeCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const boundedText = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const storedNs = value => typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) &&
  value >= Number(-9223372036854775808n) && value <= Number(9223372036854775807n);
function invalidHistory() {
  throw new AgentSightError('AGENTSIGHT_INVALID_RESPONSE', 'AgentSight 历史汇总格式、数值或完整性不兼容；累计值未知', 502);
}
function historyUsage(body) {
  const families = new Map(Object.keys(USAGE_FAMILIES).map(name => [name, { help: false, type: false, agents: new Map(), sum: 0n }]));
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#\s*ERROR\b/.test(line)) invalidHistory();
    const declaration = /^#\s+(HELP|TYPE)\s+(\w+)\s+(.+)$/.exec(line);
    if (declaration && families.has(declaration[2])) {
      const [, kind, name, value] = declaration;
      const family = families.get(name);
      const field = kind === 'HELP' ? 'help' : 'type';
      if (family[field] || value !== (kind === 'HELP' ? USAGE_FAMILIES[name].help : 'counter')) invalidHistory();
      family[field] = true;
      continue;
    }
    if (line.startsWith('#')) continue;
    const name = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line)?.[0];
    if (!families.has(name)) continue; // Never add cache counters or total-token aliases.
    const sample = /^(\w+)\{agent="((?:[^"\\\r\n]|\\[\\"n])*)"\}\s+([0-9]+)$/.exec(line);
    if (!sample) invalidHistory(); // No extra labels, timestamps, exponent, negative or fractional counts.
    const agent = sample[2].replace(/\\([\\"n])/g, (_, escaped) => escaped === 'n' ? '\n' : escaped);
    const family = families.get(name);
    if (family.agents.has(agent)) invalidHistory(); // Compare decoded exact identities, not spellings of escapes.
    const digits = sample[3].replace(/^0+/, '') || '0';
    if (digits.length > 16) invalidHistory();
    const count = BigInt(digits); // Check before converting: Number must never round token counts.
    family.sum += count;
    if (count > BigInt(Number.MAX_SAFE_INTEGER) || family.sum > BigInt(Number.MAX_SAFE_INTEGER)) invalidHistory();
    family.agents.set(agent, count);
  }
  const inputAgents = families.get('agentsight_token_input_total').agents;
  for (const family of families.values()) {
    if (!family.help || !family.type || family.agents.size !== inputAgents.size ||
        [...inputAgents.keys()].some(agent => !family.agents.has(agent))) invalidHistory();
  }
  // The verified handler emits all three authoritative HELP/TYPE pairs even for an empty store.
  return Object.fromEntries([...families].map(([name, family]) => [USAGE_FAMILIES[name].key, Number(family.sum)]));
}
function historySessions(rows) {
  if (!Array.isArray(rows)) invalidHistory();
  const ids = new Set();
  for (const raw of rows) {
    const row = select(raw, fields.sessions);
    if (!row || fields.sessions.some(key => !Object.hasOwn(row, key)) || !boundedText(row.session_id) || ids.has(row.session_id) ||
        !safeCount(row.conversation_count) || !safeCount(row.total_input_tokens) || !safeCount(row.total_output_tokens) ||
        !storedNs(row.first_seen_ns) || !storedNs(row.last_seen_ns) || row.first_seen_ns > row.last_seen_ns ||
        !(row.agent_name === null || boundedText(row.agent_name)) || !(row.model === null || boundedText(row.model))) invalidHistory();
    ids.add(row.session_id);
  }
  // Count the entire bounded response, never the 500-row detail projection; do not retain metadata here.
  return { total: ids.size };
}
function historyCounts(raw) {
  const data = { total: raw?.total, by_severity: select(raw?.by_severity, ['critical', 'high', 'medium', 'low']) };
  if (!safeCount(data.total) || !object(raw?.by_severity) || Object.keys(raw.by_severity).length !== 4 ||
      !data.by_severity || !['critical', 'high', 'medium', 'low'].every(key => safeCount(data.by_severity[key]))) invalidHistory();
  const sum = Object.values(data.by_severity).reduce((total, value) => total + BigInt(value), 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum !== BigInt(data.total)) invalidHistory();
  return data;
}

async function collectAgentEvidence({ signal, baseUrl = process.env.SYSOM_AGENTSIGHT_URL || 'http://127.0.0.1:7396',
  token = process.env.SYSOM_AGENTSIGHT_TOKEN, fetchImpl = fetch, now = Date.now(), timeoutMs = 5000 } = {}) {
  const started = performance.now();
  const origin = agentSightUrl(baseUrl);
  if (token !== undefined && (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token))) throw new AgentSightError('INVALID_AGENTSIGHT_TOKEN', 'AgentSight 认证环境变量格式无效', 400);
  const end = new Date(now).toISOString();
  const start = new Date(now - 86400000).toISOString();
  const range = `start_ns=${BigInt(now - 86400000) * 1000000n}&end_ns=${BigInt(now) * 1000000n}`;
  const paths = {
    processes: '/api/agent-process-health?include_clients=true',
    sessions: `/api/sessions?${range}&include_auxiliary=true`,
    interruptions: `/api/interruptions?${range}&resolved=false&limit=200`,
    interruptionCounts: `/api/interruptions/count?${range}`,
    latency: `/api/metrics/latency?${range}`,
  };
  const historyPaths = {
    usage: '/metrics',
    sessions: `/api/sessions?${STORED_RANGE}&include_auxiliary=true`,
    interruptionCounts: `/api/interruptions/count?${STORED_RANGE}`,
  };
  async function collect(key, history = false) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const prometheus = history && key === 'usage';
    try {
      requestSignal.throwIfAborted();
      const response = await fetchImpl(`${origin}${(history ? historyPaths : paths)[key]}`, { method: 'GET', signal: requestSignal, redirect: 'error', cache: 'no-store',
        headers: { accept: prometheus ? 'text/plain' : 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!response.ok) {
        await response.body?.cancel();
        requestSignal.throwIfAborted();
        return [key, { status: 'unavailable', reason: response.status === 401 || response.status === 403 ? 'AgentSight 拒绝访问，请检查服务鉴权配置' : `AgentSight 接口返回 HTTP ${response.status}`, data: null }];
      }
      const data = prometheus ? historyUsage(await readText(response, /^text\/plain(?:\s*;|\s*$)/i, requestSignal)) : await readJson(response, requestSignal);
      return [key, history ? { status: 'available', reason: '', data: key === 'usage' ? data : key === 'sessions' ? historySessions(data) : historyCounts(data) } : minimize(key, data)];
    } catch (error) {
      if (signal?.aborted) throw new AgentSightError('COLLECTION_CANCELLED', 'Agent 诊断已停止');
      return [key, { status: timeout.aborted ? 'unavailable' : error instanceof AgentSightError ? 'invalid' : 'unavailable',
        reason: timeout.aborted ? 'AgentSight 接口响应超时' : error instanceof AgentSightError ? error.message : '无法连接本机 AgentSight，请检查是否已独立安装并运行', data: null }];
    }
  }
  const [entries, historyEntries] = await Promise.all([
    Promise.all(SOURCE_KEYS.map(key => collect(key))),
    Promise.all(HISTORY_KEYS.map(key => collect(key, true))),
  ]);
  if (signal?.aborted) throw new AgentSightError('COLLECTION_CANCELLED', 'Agent 诊断已停止');
  const sources = Object.fromEntries(entries);
  if (sources.interruptions.status === 'available' && sources.interruptionCounts.status === 'available' &&
      Number.isSafeInteger(sources.interruptionCounts.data?.total) && sources.interruptionCounts.data.total > sources.interruptions.data.length) {
    sources.interruptions.status = 'truncated';
    sources.interruptions.reason = '明细最多返回 200 条未处理中断，全部数量以汇总接口为准';
  }
  const sampledAt = new Date(now + Math.ceil(performance.now() - started)).toISOString();
  return { schema_version: '1.0', source: 'agentsight', sampled_at: sampledAt, window: { start, end }, sources,
    history: { scope: 'all_stored', sampled_at: sampledAt, sources: Object.fromEntries(historyEntries) } };
}

function createAgentSightService(options = {}) {
  const env = options.env || process.env;
  const configuredUrl = options.baseUrl || env.SYSOM_AGENTSIGHT_URL;
  let baseUrl = configuredUrl || 'http://127.0.0.1:7396';
  let collection = unavailableCollection();
  const token = options.token ?? env.SYSOM_AGENTSIGHT_TOKEN;
  const configuredConfig = options.configPath || env.SYSOM_AGENTSIGHT_CONFIG;
  let configPath = configuredConfig || '/etc/agentsight/config.json';
  const fetchImpl = options.fetchImpl || fetch;
  const spawnImpl = options.spawnImpl || spawn;
  const fsImpl = options.fsImpl || fs;
  const stopped = new AbortController();
  let current = { state: 'unavailable', managed: false, code: 'AGENTSIGHT_NOT_CHECKED', message: 'AgentSight 尚未检查' };
  let pending = null;
  let child = null;
  let childExited = true;
  let childFailed = false;
  let childDone = Promise.resolve();
  let closing = null;
  const status = () => ({ ...current, ...(options.collectionControlImpl ? { collection: { ...collection } } : {}) });
  function unavailable(code, message) {
    if (stopped.signal.aborted) return status();
    current = { state: 'unavailable', managed: false, code, message };
    return status();
  }
  function executable(file) {
    if (!path.isAbsolute(file) || !fsImpl.statSync(file).isFile()) return false;
    fsImpl.accessSync(file, fs.constants.X_OK);
    return true;
  }
  function findBinary() {
    const configured = options.binary || env.SYSOM_AGENTSIGHT_BIN;
    if (configured) {
      try { return executable(configured) ? configured : null; } catch { return null; }
    }
    for (const directory of (env.PATH || '/usr/local/bin:/usr/bin:/bin').split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const file = path.join(directory, 'agentsight');
      try { if (executable(file)) return file; } catch {}
    }
    return null;
  }
  async function probe(origin) {
    const signal = AbortSignal.any([stopped.signal, AbortSignal.timeout(options.probeTimeoutMs ?? 750)]);
    try {
      const response = await fetchImpl(`${origin}/api/agent-process-health?include_clients=true`, {
        method: 'GET', redirect: 'error', cache: 'no-store', signal,
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { kind: 'occupied', code: response.status === 401 || response.status === 403 ? 'AGENTSIGHT_AUTH_REJECTED' : 'AGENTSIGHT_PORT_OCCUPIED',
          message: response.status === 401 || response.status === 403 ? 'AgentSight 拒绝访问，请检查服务鉴权配置' : 'AgentSight 地址返回非正常响应，请检查服务或端口冲突' };
      }
      const data = await readJson(response);
      if (!object(data) || !Array.isArray(data.agents)) return { kind: 'occupied', code: 'AGENTSIGHT_PORT_OCCUPIED', message: 'AgentSight 地址返回不兼容数据，请检查服务或端口冲突' };
      return { kind: 'ready' };
    } catch (error) {
      const cause = error.cause || error;
      const refused = error.cause?.code === 'ECONNREFUSED' || Array.isArray(cause.errors) && cause.errors.length > 0 && cause.errors.every(item => item.code === 'ECONNREFUSED');
      return refused ? { kind: 'missing' } : { kind: 'occupied', code: 'AGENTSIGHT_PROBE_FAILED', message: 'AgentSight 接口检查失败或超时，未启动第二个服务，请检查连接' };
    }
  }
  async function stopChild() {
    if (!child || childExited) return;
    child.kill('SIGTERM');
    let timer;
    await Promise.race([childDone, new Promise(resolve => { timer = setTimeout(resolve, options.stopTimeoutMs ?? 2000); })]);
    clearTimeout(timer);
    if (!childExited) child.unref();
  }
  async function check() {
    let managedCollection = false;
    if (options.collectionControlImpl) {
      const custom = configuredUrl || configuredConfig || options.binary || env.SYSOM_AGENTSIGHT_BIN;
      try { collection = collectionStatus(await options.collectionControlImpl(custom ? 'status' : 'ensure')); }
      catch { collection = unavailableCollection(); }
      if (stopped.signal.aborted) return status();
      managedCollection = !custom && collection.enabled;
      baseUrl = managedCollection ? MANAGED_API : configuredUrl || 'http://127.0.0.1:7396';
      if (managedCollection && !collection.api_running) return unavailable('AGENTSIGHT_COLLECTION_API_FAILED', '已授权真实采集，但独立 API 未启动；未回退到其他数据目录');
    }
    let origin;
    try {
      origin = agentSightUrl(baseUrl);
      if (token !== undefined && (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token))) return unavailable('INVALID_AGENTSIGHT_TOKEN', 'AgentSight 认证环境变量格式无效');
    } catch (error) { return unavailable(error.code, error.message); }
    let initial = await probe(origin);
    if (managedCollection && initial.kind === 'missing') {
      const deadline = Date.now() + (options.readyTimeoutMs ?? 8000);
      while (initial.kind === 'missing' && Date.now() < deadline && !stopped.signal.aborted) {
        try { await delay(Math.min(options.pollIntervalMs ?? 150, Math.max(1, deadline - Date.now())), undefined, { signal: stopped.signal }); }
        catch { return status(); }
        initial = await probe(origin);
      }
    }
    if (stopped.signal.aborted) return status();
    if (initial.kind === 'ready') {
      current = { state: 'running', managed: !!child && !childExited, code: null, message: 'AgentSight API 已就绪' };
      return status();
    }
    if (initial.kind === 'occupied') return unavailable(initial.code, initial.message);
    if (managedCollection) return unavailable('AGENTSIGHT_COLLECTION_API_FAILED', '独立采集 API 未就绪；未启动第二个 API 或切换数据目录');
    const url = new URL(origin);
    if ((options.platform || process.platform) !== 'linux' || url.protocol !== 'http:') return unavailable('AGENTSIGHT_MANUAL_START_REQUIRED', '此平台或 HTTPS 地址需要独立启动 AgentSight 服务');
    let binary = findBinary();
    if (!binary && (options.binary || env.SYSOM_AGENTSIGHT_BIN)) return unavailable('AGENTSIGHT_BINARY_MISSING', '指定的 AgentSight 程序不可用，请检查 SYSOM_AGENTSIGHT_BIN');
    let existingConfig = false;
    try {
      if (!path.isAbsolute(configPath) || !fsImpl.statSync(configPath).isFile()) throw new Error('invalid config');
      fsImpl.accessSync(configPath, fs.constants.R_OK);
      existingConfig = true;
    } catch {
      if (configuredConfig) return unavailable('AGENTSIGHT_CONFIG_MISSING', '指定的 AgentSight 配置不可读，请检查 SYSOM_AGENTSIGHT_CONFIG；已有配置不会被覆盖');
    }
    let prepared;
    if (!binary || !existingConfig || options.deploymentRoot) {
      try {
        prepared = await prepareAgentSight({ root: options.deploymentRoot, packageDirectories: options.packageDirectories,
          binary: binary || undefined, configPath: existingConfig ? configPath : undefined, env, fsImpl, signal: stopped.signal });
        binary = prepared.binary;
        configPath = prepared.configPath;
      } catch (error) {
        if (stopped.signal.aborted) return status();
        return unavailable(error.code, error.message);
      }
    }
    if (stopped.signal.aborted) return status();
    let lock;
    if (prepared) {
      const lockPath = path.join(prepared.root, '.serve-lock');
      const lockDeadline = Date.now() + (options.readyTimeoutMs ?? 8000);
      while (!stopped.signal.aborted) {
        try {
          const handle = await fsImpl.promises.open(lockPath, 'wx', 0o600);
          lock = { handle, path: lockPath };
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') return unavailable('AGENTSIGHT_DEPLOYMENT_FAILED', 'AgentSight 启动锁不可用，请检查用户目录权限');
          const result = await probe(origin);
          if (stopped.signal.aborted) return status();
          if (result.kind === 'ready') {
            current = { state: 'running', managed: false, code: null, message: 'AgentSight API 已就绪' };
            return status();
          }
          if (result.kind === 'occupied') return unavailable(result.code, result.message);
          if (Date.now() >= lockDeadline) return unavailable('AGENTSIGHT_START_BUSY', '另一个宿主正在准备 AgentSight；请稍后刷新，未重复启动');
          try { await delay(options.pollIntervalMs ?? 150, undefined, { signal: stopped.signal }); }
          catch { return status(); }
        }
      }
    }
    try {
      if (stopped.signal.aborted) return status();
      if (prepared) {
        const result = await probe(origin);
        if (stopped.signal.aborted) return status();
        if (result.kind === 'ready') {
          current = { state: 'running', managed: false, code: null, message: 'AgentSight API 已就绪' };
          return status();
        }
        if (result.kind === 'occupied') return unavailable(result.code, result.message);
      }
      if (!child || childExited) {
        childFailed = false;
        try {
          child = spawnImpl(binary, ['serve', '--config', configPath, '--host', url.hostname.replace(/^\[|\]$/g, ''), '--port', url.port || '80'], {
            shell: false, detached: false, stdio: 'ignore',
            env: { PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: env.HOME || '', LANG: 'C.UTF-8', ...(env.TMPDIR ? { TMPDIR: env.TMPDIR } : {}) },
          });
          childExited = false;
          childDone = new Promise(resolve => {
            child.once('exit', () => { childExited = true; resolve(); });
            child.once('error', () => { childFailed = true; childExited = true; resolve(); });
          });
        } catch { return unavailable('AGENTSIGHT_START_FAILED', 'AgentSight API 启动失败，请检查独立安装和配置'); }
      }
      const deadline = Date.now() + (options.readyTimeoutMs ?? 8000);
      while (!stopped.signal.aborted) {
        const result = await probe(origin);
        if (stopped.signal.aborted) return status();
        if (result.kind === 'ready') {
          current = { state: 'running', managed: !childExited, code: null, message: 'AgentSight API 已就绪' };
          return status();
        }
        if (childFailed || childExited) return unavailable('AGENTSIGHT_START_FAILED', 'AgentSight API 未正常启动，请检查独立安装、配置或端口冲突');
        if (Date.now() >= deadline || result.kind === 'occupied') {
          await stopChild();
          return unavailable(result.kind === 'occupied' ? result.code : 'AGENTSIGHT_START_TIMEOUT',
            result.kind === 'occupied' ? result.message : 'AgentSight API 启动超时，请检查独立配置和数据目录权限');
        }
        try { await delay(Math.min(options.pollIntervalMs ?? 150, Math.max(1, deadline - Date.now())), undefined, { signal: stopped.signal }); }
        catch { return status(); }
      }
      return status();
    } finally {
      if (lock) {
        await lock.handle.close();
        await fsImpl.promises.unlink(lock.path);
      }
    }
  }
  return {
    status,
    endpoint: () => baseUrl,
    ensure() {
      if (stopped.signal.aborted) return Promise.resolve(status());
      if (!pending) pending = check().catch(() => unavailable('AGENTSIGHT_DEPLOYMENT_FAILED', 'AgentSight 准备或启动失败，请检查用户目录权限')).finally(() => { pending = null; });
      return pending.then(() => status());
    },
    close() {
      if (!closing) {
        stopped.abort();
        current = { state: 'closed', managed: false, code: null, message: 'AgentSight 宿主管理已退出' };
        closing = Promise.all([pending, stopChild()]).then(() => {});
      }
      return closing;
    },
  };
}

module.exports = { collectAgentEvidence, agentSightUrl, AgentSightError, createAgentSightService, controlAgentCollection };
