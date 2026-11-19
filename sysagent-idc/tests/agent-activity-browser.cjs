const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function main() {
  const { createServer } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const root = path.resolve(__dirname, '..');
  const start = Date.parse('2026-11-16T10:00:00Z');
  const kinds = ['session_start', 'session_end', 'prompt_submit', 'tool_start', 'tool_end', 'tool_failure', 'permission_request', 'permission_denied', 'turn_stop', 'turn_failure', 'notification', 'subagent_start', 'subagent_stop', 'task_created', 'task_completed', 'teammate_idle', 'elicitation', 'elicitation_result', 'compact', 'compact_completed'];
  const report = {
    source: 'agentsight', analyzer: 'sysom-openapi', sampledAt: new Date(start + 86400000).toISOString(),
    window: { start: new Date(start).toISOString(), end: new Date(start + 86400000).toISOString() },
    status: 'partial', outcome: 'abnormal', summary: 'Browser fixture, not local collection', lastScanAt: null, filteredProcesses: null,
    coverage: ['processes', 'sessions', 'interruptions', 'latency'].map(key => ({ key, status: 'available', reason: 'Browser fixture' })),
    totals: { sessions: 45, inputTokens: 48000, outputTokens: 6200, unresolved: 45, critical: 1, high: 2 }, findings: [],
    history: { scope: 'all_stored', sampledAt: new Date(start + 86400000).toISOString(), status: 'ok',
      coverage: ['usage', 'sessions', 'interruptionCounts'].map(key => ({ key, status: 'available', reason: 'Browser fixture AgentSight retained history' })),
      totals: { sessions: 24680, calls: 98765, inputTokens: 123456, outputTokens: 654321, unresolved: 7654, critical: 321, high: 987 } },
    processes: Array.from({ length: 45 }, (_, index) => ({ pid: 10000 + index, name: `fixture-process-${index}`, role: 'worker', status: 'no_port', ports: [], lastCheckAt: null, latencyMs: null, parentPid: null, hasCrash: false })),
    sessions: Array.from({ length: 45 }, (_, index) => ({ id: `sight-${index}`, agent: 'fixture-agent', model: 'fixture-model', conversations: 1, inputTokens: 100, outputTokens: 20, firstSeenAt: null, lastSeenAt: null })),
    interruptions: Array.from({ length: 45 }, (_, index) => ({ id: `sight-event-${index}`, agent: 'fixture-agent', sessionId: `sight-${index}`, callId: null, pid: null, type: 'llm_error', severity: 'high', occurredAt: null, resolved: false })),
    latency: Array.from({ length: 45 }, (_, index) => ({ agent: `fixture-agent-${index}`, calls: 2, streamingCalls: 1, ttftP95Ms: 820, e2eP95Ms: 12000, tpsP50: 25, tpotP95Ms: 40 })),
    hooks: { status: 'available', reason: '浏览器验收样例，非本机采集', skippedLines: 0,
      history: { scope: 'cumulative', status: 'available', reason: 'Browser fixture cumulative Hook history', sampledAt: new Date(start + 86400000).toISOString(),
        range: { start: '2026-01-01T00:00:00Z', end: new Date(start + 86399000).toISOString() },
        totals: { sessions: 432, events: 12345, prompts: 6789, toolStarts: 8901, toolEnds: 8765, toolFailures: 321, interrupts: 54, permissionDenied: 23, turnFailures: 678, openTools: 90 } },
      agents: [{ agent: 'qoder', sessions: 80, events: 5000, prompts: 1000, toolStarts: 2000, toolEnds: 1500, toolFailures: 12, interrupts: 3, permissionDenied: 2, turnFailures: 50, openTools: 4, lastEventAt: new Date(start + 86399000).toISOString() }],
      events: Array.from({ length: 250 }, (_, index) => ({ id: `fixture-hook-${index}`, agent: index % 2 ? 'qoder' : 'fixture-other', kind: kinds[index % kinds.length], occurredAt: new Date(start + index * 345000).toISOString(), sessionId: `hook-session-${index % 12}`, tool: kinds[index % kinds.length].startsWith('tool_') ? `fixture-tool-${Math.floor(index / kinds.length) % 8}` : null, callId: `fixture-call-${index}`, errorType: null, interrupt: index % 17 === 0 ? true : null, subagent: kinds[index % kinds.length].startsWith('subagent_') ? 'fixture-research' : null, model: 'fixture-model', prompt: 'PRIVATE_PROMPT_SENTINEL', toolInput: 'PRIVATE_INPUT_SENTINEL' })),
    },
  };
  const html = home => `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent 界面验收 · 样例数据</title><link rel="icon" href="data:,"></head><body style="margin:0;background:#f4f6fa"><aside style="padding:12px;background:#fff1ca">浏览器验收样例 · 非本机采集 · 不安装、不启用服务</aside><main id="fixture-root" style="max-width:1280px;margin:auto;padding:20px;box-sizing:border-box"></main><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { LiveAgentDiagnostics } from '/src/AgentDiagnostics.tsx';
    import { HealthGuardPage } from '/src/HealthGuardPage.tsx';
    import { createInitialState } from '/src/health-data.ts';
    import { devices } from '/src/data.ts';
    import '/src/styles/app.css';
    const fixtureState = createInitialState(true);
    const fixtureDevice = devices.find(device => device.local);
    window.__fixture = { report: ${JSON.stringify(report)}, initialReport: ${JSON.stringify(report)}, fail: false, hold: ${home}, pending: [], calls: [], collectorCalls: 0, notifications: [], navigations: [], unauthorized: [], apiRequests: [], healthRefreshes: [] };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname.startsWith('/api/')) { window.__fixture.apiRequests.push(url.href); return Promise.reject(Error('Fixture forbids API requests')); }
      return originalFetch(input, init);
    };
    const fixtureDesktop = new Proxy({ isElectron: false,
      agentDiagnostic: async refresh => {
        window.__fixture.calls.push(refresh);
        if (window.__fixture.hold) await new Promise((resolve, reject) => window.__fixture.pending.push({ resolve, reject }));
        if (window.__fixture.fail) throw Error('PRIVATE_ERROR_SENTINEL');
        return { ok: true, data: structuredClone(window.__fixture.report) };
      },
      collectorStatus: async () => {
        window.__fixture.collectorCalls++;
        return { ok: true, data: { schema_version: '1.1', mode: 'mock', read_only: true, device_id: fixtureDevice.id, installed: false, enabled: false,
          inspection_interval_minutes: 5, next_inspection_at: null, phase: 'disabled', api_version: '1.0', last_task: null,
          collector: null, collection: null, cloud_inspection: null, error: null, agent_sight: { state: 'running', collection: { state: 'disabled' } } } };
      },
    }, { get(client, key) { if (Object.hasOwn(client, key)) return client[key]; window.__fixture.unauthorized.push(String(key)); throw Error('Fixture forbids desktop resource: ' + String(key)); } });
    window.sysomDesktop = fixtureDesktop;
    const onNotify = message => window.__fixture.notifications.push(message);
    function Fixture() {
      const [page, setPage] = React.useState(${JSON.stringify(home ? 'overview' : 'agents')});
      const onNavigate = next => { window.__fixture.navigations.push(next); setPage(next); };
      window.__fixture.onNavigate = onNavigate;
      return page === 'overview' ? React.createElement(HealthGuardPage, { device: fixtureDevice, state: fixtureState, agentLive: true,
        loading: false, loadError: '', externalBusy: false, onBusyChange: () => {}, onNotify, onNavigate,
        onRefresh: async refresh => { window.__fixture.healthRefreshes.push(refresh); return fixtureState; } })
        : React.createElement(LiveAgentDiagnostics, { onNotify });
    }
    createRoot(document.getElementById('fixture-root')).render(React.createElement(Fixture));
  </script></body></html>`;
  const energyHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>能耗浏览器验收 · 固定样例</title><link rel="icon" href="data:,"></head><body style="margin:0;background:#f4f6fa"><aside style="padding:12px;background:#fff1ca">浏览器验收样例 · 人工固定数据 · 不执行真实进程操作</aside><main id="fixture-root" style="max-width:1280px;margin:auto;padding:20px;box-sizing:border-box"></main><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { HealthGuardPage } from '/src/HealthGuardPage.tsx';
    import { createInitialState } from '/src/health-data.ts';
    import { fetchHealthSnapshot } from '/src/health-api.ts';
    import { devices } from '/src/data.ts';
    import '/src/styles/app.css';
    const variant = new URLSearchParams(location.search).get('fixture') || 'noGPU';
    if (!['noGPU', 'withGPU', 'empty', 'unavailable'].includes(variant)) throw Error('Unknown energy fixture');
    const withGpu = variant === 'withGPU';
    const unavailable = variant === 'unavailable';
    const sampledAt = '2026-11-16T10:00:00.000Z';
    const fixtureDevice = { ...devices.find(device => device.local), id: 'energy-browser-only', name: '固定能耗样例（非本机）' };
    const health = createInitialState(withGpu);
    Object.assign(health, { mode: 'collected', hasGpu: withGpu, sampledAt, revision: 71, optimizations: [], operations: [] });
    for (const [id, snapshot] of Object.entries(health.resources)) Object.assign(snapshot, {
      usage: id === 'energy' ? null : 20, capacity: null, unit: id === 'energy' ? 'W' : '%', source: 'sysak', status: 'available', sampledAt,
      rows: [], note: '人工固定资源样例；不来自本机采集', quantity: undefined, rankUnit: id === 'energy' ? 'W' : '%', rankLabel: '进程资源排行',
    });
    health.inspections = health.inspections.map(item => ({ ...item, usage: null, status: 'unchecked', execution: 'unavailable', detail: '固定样例，无真实诊断证据', evidence: ['浏览器样例，不能判定正常'] }));
    const processes = [
      { pid: 41001, starttime: 1001, name: 'qoder-cli', watts: 16, cleanable: true, agentKind: 'Qoder CLI' },
      { pid: 41002, starttime: 1002, name: 'Browser-Worker', watts: 8, cleanable: true },
      { pid: 41003, starttime: 1003, name: 'claude', watts: 4, cleanable: true, agentKind: 'Claude Code' },
      { pid: 41004, starttime: 1004, name: 'sysagent-idc-protected', watts: 2, cleanable: false },
    ].map(({ watts, ...row }) => ({ ...row, id: 'process-' + row.pid + '-' + row.starttime, usage: watts,
      quantity: { value: watts, unit: 'W' }, powerSource: 'cpu-model', defaultSelected: false,
      detail: 'CPU 进程功率估算；人工样例，不是每进程实测', effect: row.cleanable ? '仅本地假结束整个进程，不删除文件' : '受保护的样例采集进程，不可结束' }));
    const cpuComponent = { id: 'power-cpu-rapl', name: 'CPU Package', usage: 48, quantity: { value: 48, unit: 'W' },
      powerSource: 'rapl', detail: 'RAPL 组件测量样例', cleanable: false, defaultSelected: false, effect: '组件只读，不可结束' };
    const gpuComponent = { id: 'power-gpu-sensor', name: 'GPU Board', usage: 96, quantity: { value: 96, unit: 'W' },
      powerSource: 'gpu-sensor', detail: 'GPU 传感器组件测量样例', cleanable: false, defaultSelected: false, effect: '组件只读，不归因到进程' };
    Object.assign(health.resources.energy, { status: unavailable ? 'unavailable' : 'available', rankLabel: 'CPU 进程功率估算',
      quantity: unavailable ? undefined : { value: withGpu ? 144 : 48, unit: 'W' },
      note: 'CPU 进程 W 按整机忙碌 CPU 占比估算，非进程实测；采样未覆盖部分不归因。' + (withGpu ? 'GPU 功率未归因到进程，不做进程功率分摊。' : ''),
      rows: unavailable ? [] : withGpu ? [cpuComponent, gpuComponent] : [cpuComponent],
      power: { method: unavailable ? 'unavailable' : 'measured', cpuWatts: unavailable ? null : 48, gpuWatts: withGpu ? 96 : null,
        missing: unavailable ? ['cpu'] : [], processes: unavailable || variant === 'empty' ? [] : processes,
        unattributedCpuWatts: unavailable ? null : variant === 'empty' ? 48 : 18 } });
    window.__energyFixture = { variant, initialState: structuredClone(health), state: health, snapshotCalls: [], collectorCalls: [], prepareCalls: [], executeCalls: [],
      plans: [], refreshes: [], busyChanges: [], notifications: [], navigations: [], unauthorized: [], apiRequests: [], foreignRequests: [], events: [], pendingExecutions: [] };
    const fixture = window.__energyFixture;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) { fixture.apiRequests.push(url.href); return Promise.reject(Error('Energy fixture forbids API requests')); }
      if (url.origin !== location.origin) { fixture.foreignRequests.push(url.href); return Promise.reject(Error('Energy fixture forbids external requests')); }
      return originalFetch(input, init);
    };
    const ok = data => ({ ok: true, data: structuredClone(data) });
    window.sysomDesktop = new Proxy({ isElectron: false,
      healthSnapshot: async refresh => { fixture.snapshotCalls.push(refresh); fixture.events.push('snapshot'); return ok(fixture.state); },
      collectorStatus: async () => {
        fixture.collectorCalls.push({ variant });
        // Fixed UI status only: this does not install or enable any service.
        return ok({ schema_version: '1.1', mode: 'mock', read_only: true, device_id: fixtureDevice.id, installed: true, enabled: true,
          inspection_interval_minutes: 5, next_inspection_at: null, phase: 'idle', api_version: '1.0', last_task: null,
          collector: null, collection: null, cloud_inspection: null, error: null });
      },
      prepareProcessCleanup: async payload => {
        fixture.prepareCalls.push(structuredClone(payload)); fixture.events.push('prepare');
        if (payload.resource !== 'energy' || payload.revision !== fixture.state.revision || !payload.ids.length || payload.ids.length > 10 || new Set(payload.ids).size !== payload.ids.length) throw Error('Invalid energy-only fixture prepare');
        const rows = payload.ids.map(id => fixture.state.resources.energy.power.processes.find(row => row.id === id));
        if (rows.some(row => !row || !row.cleanable || !row.id.startsWith('process-'))) throw Error('Fixture prepare forbids components and protected rows');
        const plan = { token: 'energy-fixture-only-' + fixture.prepareCalls.length, revision: payload.revision,
          expires_at: new Date(Date.now() + 60000).toISOString(), processes: rows.map(({ id, pid, starttime, name }) => ({ id, pid, starttime, name })) };
        fixture.plans.push(structuredClone(plan)); return ok(plan);
      },
      executeProcessCleanup: async payload => {
        fixture.executeCalls.push(structuredClone(payload)); fixture.events.push('execute');
        const plan = fixture.plans.find(plan => plan.token === payload.token);
        if (!plan || Date.parse(plan.expires_at) <= Date.now() || fixture.executeCalls.filter(call => call.token === payload.token).length !== 1) throw Error('Invalid/expired/repeated fixture token');
        // Hold the fake response so the browser can test duplicate clicks while busy.
        await new Promise(resolve => fixture.pendingExecutions.push(resolve));
        fixture.state = { ...fixture.state, revision: fixture.state.revision + 1 };
        return ok({ revision: fixture.state.revision, refresh_required: true, results: plan.processes.map(({ pid, starttime, name }) => ({ pid, starttime, name, eligible: true, status: 'signalled', reason: '仅假执行，未发送真实信号' })) });
      },
    }, { get(client, key) { if (Object.hasOwn(client, key)) return client[key]; fixture.unauthorized.push(String(key)); throw Error('Energy fixture forbids desktop resource: ' + String(key)); } });
    function EnergyFixture() {
      const [state, setState] = React.useState(health);
      const [busy, setBusy] = React.useState(false);
      return React.createElement(HealthGuardPage, { device: fixtureDevice, state, agentLive: false, loading: false, loadError: '', externalBusy: busy,
        onBusyChange: next => { fixture.busyChanges.push(next); setBusy(next); }, onNotify: message => fixture.notifications.push(message),
        onNavigate: page => fixture.navigations.push(page), onRefresh: async refresh => {
          fixture.refreshes.push(refresh); fixture.events.push('refresh'); const next = await fetchHealthSnapshot(refresh); setState(next); return next;
        } });
    }
    createRoot(document.getElementById('fixture-root')).render(React.createElement(EnergyFixture));
  </script></body></html>`;
  const serverApiRequests = [];
  const fixturePort = Number.parseInt(process.env.AGENT_ACTIVITY_BROWSER_PORT ?? '5174', 10);
  const server = await createServer({ configFile: false, root, plugins: [react(), { name: 'agent-activity-fixture', configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url.startsWith('/api/')) { serverApiRequests.push(request.url); response.statusCode = 503; response.end('Fixture forbids API requests'); return; }
      next();
    });
    for (const [route, home] of [['/__agent-activity', false], ['/__agent-home', true]]) server.middlewares.use(route, async (_request, response) => {
      response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml(route, html(home)));
    });
    server.middlewares.use('/__energy-home', async (_request, response) => {
      response.setHeader('Content-Type', 'text/html'); response.end(await server.transformIndexHtml('/__energy-home', energyHtml));
    });
  } }], server: { host: '127.0.0.1', port: fixturePort, strictPort: true } });
  await server.listen();
  const origin = `http://127.0.0.1:${fixturePort}`;
  const socketOrigin = `ws://127.0.0.1:${fixturePort}`;
  const url = `${origin}/__agent-activity`;
  const homeUrl = `${origin}/__agent-home`;
  const energyUrl = `${origin}/__energy-home`;
  console.log(`Fixture dev server: ${url}, ${homeUrl}, ${energyUrl}`);
  if (process.argv.includes('--serve')) return;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sysagent-activity-chrome-'));
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'sysagent-activity-screens-'));
  let chrome;
  let socket;
  let cdp;
  try {
    chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = '';
      const timer = setTimeout(() => reject(new Error('Chrome debugging startup timed out')), 20000);
      chrome.on('error', reject);
      chrome.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome exited ${code} before debugging startup`)); });
      chrome.stderr.on('data', chunk => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    });
    const port = new URL(endpoint).port;
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open');
    let sequence = 0;
    const pending = new Map();
    const errors = [];
    const consoleErrors = [];
    const apiRequests = [];
    const foreignRequests = [];
    const networkFailures = [];
    const permittedUrl = value => /^(data:|blob:|about:)/.test(value) || [origin, socketOrigin].includes(new URL(value).origin);
    const isApi = value => { const pathname = new URL(value).pathname; return pathname === '/api' || pathname.startsWith('/api/'); };
    socket.addEventListener('message', event => {
      const value = JSON.parse(event.data);
      if (value.id) { const request = pending.get(value.id); pending.delete(value.id); if (value.error) request.reject(new Error(value.error.message)); else request.resolve(value.result); }
      else if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.exception?.description ?? value.params.exceptionDetails.text);
      else if (value.method === 'Runtime.consoleAPICalled' && value.params.type === 'error') consoleErrors.push(value.params.args.map(arg => arg.value ?? arg.description).join(' '));
      else if (value.method === 'Log.entryAdded' && value.params.entry.level === 'error') consoleErrors.push([value.params.entry.text, value.params.entry.url].filter(Boolean).join(' · '));
      else if (value.method === 'Network.responseReceived' && value.params.response.status >= 400) networkFailures.push({ url: value.params.response.url, status: value.params.response.status });
      else if (value.method === 'Network.requestWillBeSent') {
        const requested = value.params.request.url;
        if (isApi(requested)) apiRequests.push(requested);
        if (!permittedUrl(requested)) foreignRequests.push(requested);
      } else if (value.method === 'Network.webSocketCreated' && !permittedUrl(value.params.url)) foreignRequests.push(value.params.url);
      else if (value.method === 'Fetch.requestPaused') {
        const { requestId, request } = value.params;
        // Block accidental API/cloud traffic before it can leave the browser.
        void cdp(isApi(request.url) || !permittedUrl(request.url) ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          isApi(request.url) || !permittedUrl(request.url) ? { requestId, errorReason: 'BlockedByClient' } : { requestId }).catch(error => errors.push(error.message));
      }
    });
    cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await cdp('Network.enable');
    await cdp('Log.enable');
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.navigate', { url });
    const evaluate = async expression => { const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
    await evaluate(`new Promise((resolve,reject)=>{ const begin=Date.now(); const check=()=>{if(document.querySelector('[aria-label="事件构成"] svg')) resolve(true); else if(Date.now()-begin>20000) reject(Error('Fixture did not render: '+document.body.innerText.slice(0,400))); else requestAnimationFrame(check);};check();})`);
    const check = async expression => assert.equal(await evaluate(expression), true, expression);
    const waitFor = async expression => evaluate(`new Promise((resolve,reject)=>{const begin=Date.now();const check=()=>{if(${expression}) resolve(true);else if(Date.now()-begin>20000) reject(Error('Fixture wait timed out: '+${JSON.stringify(expression)}));else requestAnimationFrame(check);};check();})`);
    const click = async label => { await evaluate(`[...document.querySelectorAll('[aria-label]')].find(node=>node.getAttribute('aria-label')===${JSON.stringify(label)}).click(); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`); };
    const tab = async label => { await evaluate(`[...document.querySelectorAll('[role=tab]')].find(node=>node.textContent===${JSON.stringify(label)}).click(); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`); };
    const screenshot = async name => { await evaluate(`Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))`); const image = await cdp('Page.captureScreenshot', { captureBeyondViewport: true }); fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(image.data, 'base64')); };
    await check(`document.querySelector('[aria-label="Hook 累计总体统计"]').textContent.includes('12,345') && document.querySelector('[aria-label="事件构成"] svg').textContent.includes('200')`);
    const checkNoAgentSightStatistics = async () => check(`!document.querySelector('[aria-label="AgentSight 已保留历史用量"],[aria-label="AgentSight 累计用量"],.ad-sight-kpis') && document.querySelectorAll('.ad-hook-kpis > div').length===6 && document.body.innerText.includes('Hook 独立持久累计，不受明细限制或轮转影响；启用前已删除记录无法恢复。') && !document.body.innerText.includes('AgentSight · 已保留历史') && !document.body.innerText.includes('AgentSight · 累计历史') && !document.body.innerText.includes('AgentSight 保持自身历史保留规则')`);
    await check(`window.__fixture.report.history.scope==='all_stored' && window.__fixture.report.hooks.history.scope==='cumulative'`);
    await checkNoAgentSightStatistics();
    await check(`document.querySelectorAll('.ad-hook-kpis').length===1 && !document.querySelector('.ad-live .ad-stats') && JSON.stringify([...document.querySelectorAll('.ad-hook-kpis > div > span')].map(node=>node.textContent))===JSON.stringify(['已记录会话','Hook 事件','提交提问','工具开始','轮次失败','未配对开始'])`);
    await check(`JSON.stringify([...document.querySelectorAll('.ad-hook-kpis strong')].map(node=>node.textContent))===JSON.stringify(['432','12,345','6,789','8,901','678','90']) && document.querySelector('.ad-hook-kpis').getBoundingClientRect().top<document.querySelector('.ad-live-tabs').getBoundingClientRect().top`);
    await check(`!document.querySelector('.ad-hook-kpis').textContent.includes('Token') && document.querySelectorAll('[aria-label="Hook 分类统计"] tbody tr').length===5 && document.querySelectorAll('.ad-activity-chart svg').length===2`);
    const checkKpiColors = async () => {
      const colors = await evaluate(`[...document.querySelectorAll('.ad-hook-kpis > div')].map(card=>({background:getComputedStyle(card).backgroundColor,border:getComputedStyle(card).borderTopColor,number:getComputedStyle(card.querySelector('strong')).color,label:getComputedStyle(card.querySelector('span')).color}))`);
      assert.deepEqual(colors.map(card => [card.background, card.border, card.number]), [
        ['rgb(239, 246, 255)', 'rgb(191, 219, 254)', 'rgb(29, 78, 216)'],
        ['rgb(245, 243, 255)', 'rgb(221, 214, 254)', 'rgb(109, 40, 217)'],
        ['rgb(236, 254, 255)', 'rgb(165, 243, 252)', 'rgb(14, 116, 144)'],
        ['rgb(240, 253, 250)', 'rgb(153, 246, 228)', 'rgb(15, 118, 110)'],
        ['rgb(255, 241, 242)', 'rgb(254, 205, 211)', 'rgb(190, 18, 60)'],
        ['rgb(255, 251, 235)', 'rgb(253, 230, 138)', 'rgb(180, 83, 9)'],
      ]);
      const luminance = color => color.match(/\d+/g).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      for (const card of colors) {
        for (const foreground of [card.number, card.label]) {
          const light = luminance(card.background);
          const dark = luminance(foreground);
          assert((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) >= 4.5, 'card text meets WCAG AA contrast');
        }
      }
    };
    await checkKpiColors();
    await screenshot('overview');
    await evaluate(`document.querySelector('[aria-label="活动趋势"] g[role="button"]').focus()`);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.querySelector('[role="tab"][aria-selected="true"]').textContent==='会话与明细' && document.querySelector('.ad-filter-context').textContent.includes('时段')`);
    await tab('总体统计');
    await click('分类统计下一页');
    await check(`document.querySelector('[aria-label="分类统计分页"]').textContent.includes('6–10 / 20')`);
    await tab('会话与明细');
    await evaluate(`[...document.querySelectorAll('button')].find(node=>node.textContent==='清除 Hook 筛选').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.querySelectorAll('[aria-label="Hook 事件元数据"] tbody tr').length===10 && document.querySelectorAll('[aria-label="Hook 会话列表"] tbody tr').length===5`);
    await click('Hook 事件末页');
    await check(`document.querySelector('[aria-label="Hook 事件分页"]').textContent.includes('191–200 / 200')`);
    await screenshot('sessions');
    await evaluate(`const select=document.querySelector('[aria-label="Hook 事件每页条数"]');select.value='20';select.dispatchEvent(new Event('change',{bubbles:true}));new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.querySelector('[aria-label="Hook 事件分页"]').textContent.includes('1–20 / 200')`);
    await evaluate(`document.querySelector('[aria-label="Hook 会话列表"] button').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.querySelector('[aria-label="会话轨迹分页"]')!==null && document.querySelectorAll('.ad-hook-timeline li').length===8`);
    await evaluate(`document.querySelector('.ad-hook-timeline button').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.querySelector('dialog')?.open===true && !document.body.innerText.includes('PRIVATE_')`);
    await screenshot('evidence');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`!document.querySelector('dialog')`);
    await tab('工具与协作');
    await check(`document.querySelectorAll('[aria-label="Hook 工具统计"] tbody tr').length===5 && document.querySelector('[aria-label="任务与交互"]') && document.querySelector('[aria-label="上下文压缩"] svg').getAttribute('aria-label').includes('/')`);
    await click('工具统计下一页');
    await check(`document.querySelector('[aria-label="工具统计分页"]').textContent.includes('6–8 / 8')`);
    await screenshot('tools');
    await evaluate(`document.querySelector('[aria-label="Hook 工具统计"] button').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.querySelector('.ad-filter-context').textContent.includes('fixture-tool-') && window.__fixture.calls.length===1`);
    await check(`document.querySelectorAll('.ad-hook-kpis').length===1 && JSON.stringify([...document.querySelectorAll('.ad-hook-kpis strong')].map(node=>node.textContent))===JSON.stringify(['432','12,345','6,789','8,901','678','90'])`);
    for (const label of ['会话', '中断', '延迟']) {
      await tab(label);
      const region = label === '会话' ? '已采集会话列表' : label === '中断' ? '已采集中断元数据' : '完整 LLM 调用延迟';
      await check(`document.querySelectorAll('[aria-label="${region}"] tbody tr').length===20`);
    }
    for (const width of [1280, 720, 390]) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await tab('总体统计');
      await check(`document.documentElement.scrollWidth<=${width} && [...document.querySelectorAll('.ad-activity-chart')].every(node=>node.scrollWidth<=node.clientWidth)`);
      await check(`document.querySelectorAll('.ad-hook-kpis > div').length===6 && getComputedStyle(document.querySelector('.ad-hook-kpis')).gridTemplateColumns.split(' ').length===${width > 900 ? 6 : width > 600 ? 3 : 2}`);
      await checkKpiColors();
    }
    await screenshot('narrow');
    await evaluate(`delete window.__fixture.report.hooks.history;[...document.querySelectorAll('button')].find(node=>node.textContent==='刷新诊断').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`[...document.querySelectorAll('.ad-hook-kpis strong')].every(node=>node.textContent==='—') && document.querySelector('[aria-label="事件构成"] .ad-donut-total').textContent==='200' && document.querySelector('[aria-label="Hook 累计总体统计"]')!==null && document.body.innerText.includes('汇总不可用或不完整，— 表示未知（原因未知）')`);
    await checkNoAgentSightStatistics();
    await evaluate(`window.__fixture.report.hooks.history={...window.__fixture.initialReport.hooks.history,status:'unavailable',reason:'累计历史尚未初始化',totals:Object.fromEntries(Object.keys(window.__fixture.initialReport.hooks.history.totals).map(key=>[key,null]))};[...document.querySelectorAll('button')].find(node=>node.textContent==='刷新诊断').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.body.innerText.includes('汇总不可用或不完整，— 表示未知（累计历史尚未初始化）') && [...document.querySelectorAll('.ad-hook-kpis strong')].every(node=>node.textContent==='—') && document.querySelector('[aria-label="事件构成"] .ad-donut-total').textContent==='200'`);
    await checkNoAgentSightStatistics();
    for (const status of ['unavailable', 'invalid', 'truncated', 'available']) {
      await evaluate(`window.__fixture.report.hooks={status:${JSON.stringify(status)},reason:'fixture coverage',skippedLines:${status === 'truncated' ? 1 : 0},agents:[],events:[]};[...document.querySelectorAll('button')].find(node=>node.textContent==='刷新诊断').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await check(`!document.body.innerText.includes('PRIVATE_') && document.querySelectorAll('.ad-hook-kpis').length===1 && [...document.querySelectorAll('.ad-hook-kpis strong')].every(node=>node.textContent==='—')`);
      await checkKpiColors();
      if (status === 'unavailable' || status === 'invalid') await check(`!document.querySelector('[aria-label="活动趋势"]') && document.body.innerText.includes('不能将缺失当作零')`);
    }
    await evaluate(`window.__fixture.report.hooks={status:'available',reason:'fixture observed zero',skippedLines:0,history:{...window.__fixture.initialReport.hooks.history,reason:'fixture cumulative observed zero',range:{start:null,end:null},totals:Object.fromEntries(Object.keys(window.__fixture.initialReport.hooks.history.totals).map(key=>[key,0]))},agents:[{agent:'qoder',sessions:0,events:0,prompts:0,toolStarts:0,toolEnds:0,toolFailures:0,interrupts:0,permissionDenied:0,turnFailures:0,openTools:0,lastEventAt:'2026-11-17T10:00:00.000Z'}],events:[]};[...document.querySelectorAll('button')].find(node=>node.textContent==='刷新诊断').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`[...document.querySelectorAll('.ad-hook-kpis strong')].every(node=>node.textContent==='0')`);
    await evaluate(`window.__fixture.fail=true;[...document.querySelectorAll('button')].find(node=>node.textContent==='刷新诊断').click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await check(`document.body.innerText.includes('旧结果') && !document.body.innerText.includes('PRIVATE_ERROR_SENTINEL') && [...document.querySelectorAll('.ad-hook-kpis strong')].every(node=>node.textContent==='0')`);
    await checkKpiColors();
    await checkNoAgentSightStatistics();
    await check(`performance.getEntriesByType('resource').every(entry=>!new URL(entry.name).pathname.startsWith('/api/')) && window.__fixture.apiRequests.length===0 && window.__fixture.unauthorized.length===0`);
    for (const width of [1280, 390]) {
      const viewport = width === 1280 ? 'desktop' : 'mobile';
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await cdp('Page.navigate', { url: homeUrl });
      await waitFor(`document.querySelector('[aria-label="Agent 总体统计"][aria-busy="true"]') && window.__fixture?.pending.length===1 && document.querySelector('[aria-label="系统资源"]')`);
      await check(`document.querySelector('.sh-hero .sh-score-ring strong')!==null && !document.querySelector('.sh-agent-overview') && !document.querySelector('[data-agent-stat]')`);
      await check(`document.querySelector('.sh-hero').getBoundingClientRect().top<document.querySelector('[aria-label="Agent 总体统计"]').getBoundingClientRect().top && document.querySelector('[aria-label="Agent 总体统计"]').getBoundingClientRect().top<document.querySelector('[aria-label="系统资源"]').getBoundingClientRect().top`);
      await check(`(document.querySelector('.sh-hero').compareDocumentPosition(document.querySelector('[aria-label="Agent 总体统计"]'))&Node.DOCUMENT_POSITION_FOLLOWING)!==0 && (document.querySelector('[aria-label="Agent 总体统计"]').compareDocumentPosition(document.querySelector('[aria-label="系统资源"]'))&Node.DOCUMENT_POSITION_FOLLOWING)!==0`);
      await check(`JSON.stringify(window.__fixture.calls)===JSON.stringify([false]) && document.querySelector('[aria-label="刷新 Agent 总体统计"]').disabled && document.querySelector('[aria-label="Agent 总体统计"]').textContent.includes('正在获取 Agent 统计')`);
      await check(`[...document.querySelectorAll('.ad-hook-kpis strong')].every(node=>node.textContent==='—') && !document.querySelector('[aria-label="Agent 总体统计"]').textContent.includes('Demo')`);
      await screenshot(`home-loading-${viewport}`);
      await evaluate(`window.__fixture.hold=false;window.__fixture.pending.shift().resolve()`);
      await waitFor(`document.querySelector('[aria-label="Agent 总体统计"][aria-busy="false"]') && document.querySelector('.ad-hook-kpis strong')?.textContent==='432'`);
      const checkHomeCardsOnly = async () => {
        await check(`!document.querySelector('.sh-agent-summary .ad-activity-chart') && !/活动趋势|事件构成|会话活动排行|工具活动排行|近 24h 最新明细|统计图不可用/.test(document.querySelector('[aria-label="Agent 总体统计"]').textContent)`);
      };
      const checkHomeTotals = async () => {
        await check(`JSON.stringify([...document.querySelectorAll('.ad-hook-kpis strong')].map(node=>node.textContent))===JSON.stringify(['432','12,345','6,789','8,901','678','90'])`);
        await checkNoAgentSightStatistics();
      };
      await checkHomeTotals();
      await checkHomeCardsOnly();
      await check(`document.querySelector('[aria-label="Hook 累计总体统计"]')!==null && document.querySelector('[aria-label="Agent 总体统计"]').textContent.includes('Hook 累计历史')`);
      await check(`document.documentElement.scrollWidth<=${width} && [...document.querySelectorAll('.ad-activity-chart,.ad-hook-kpis')].every(node=>node.scrollWidth<=node.clientWidth)`);
      await check(`document.querySelector('.sh-agent-summary .sh-panel-head h2').getBoundingClientRect().height<40 && document.querySelector('.sh-agent-summary .sh-panel-head').getBoundingClientRect().height<120`);
      await checkKpiColors();
      await screenshot(`home-overview-${viewport}`);
      await evaluate(`window.__fixture.hold=true;window.__fixture.previousCards=document.querySelector('.ad-hook-kpis').outerHTML;document.querySelector('[aria-label="刷新 Agent 总体统计"]').click()`);
      await waitFor(`window.__fixture.pending.length===1 && document.querySelector('[aria-label="Agent 总体统计"]').getAttribute('aria-busy')==='true'`);
      await checkHomeTotals();
      await check(`document.querySelector('[aria-label="Agent 总体统计"]').textContent.includes('当前显示上次报告') && document.querySelector('[aria-label="刷新 Agent 总体统计"]').disabled`);
      await click('刷新 Agent 总体统计');
      await check(`JSON.stringify(window.__fixture.calls)===JSON.stringify([false,true])`);
      await evaluate(`window.__fixture.fail=true;window.__fixture.hold=false;window.__fixture.pending.shift().resolve()`);
      await waitFor(`document.querySelector('[aria-label="Agent 总体统计"] [role="alert"]') && document.querySelector('[aria-label="Agent 总体统计"]').getAttribute('aria-busy')==='false'`);
      await checkHomeTotals();
      await checkHomeCardsOnly();
      await check(`document.querySelector('[aria-label="Agent 总体统计"] [role="alert"]').textContent.includes('保留上次报告，不代表本次状态') && document.querySelector('.ad-hook-kpis').outerHTML===window.__fixture.previousCards && !document.body.innerText.includes('PRIVATE_')`);
      await screenshot(`home-stale-${viewport}`);
      await evaluate(`window.__fixture.fail=false;window.__fixture.report.hooks.status='unavailable';window.__fixture.report.hooks.events=[];window.__fixture.report.hooks.agents=[];window.__fixture.report.coverage=window.__fixture.report.coverage.map(item=>({...item,status:'unavailable'}));document.querySelector('[aria-label="刷新 Agent 总体统计"]').click()`);
      await waitFor(`document.querySelector('[aria-label="Agent 总体统计"][aria-busy="false"]') && !document.querySelector('[aria-label="Agent 总体统计"] [role="alert"]')`);
      await checkHomeTotals();
      await checkHomeCardsOnly();
      await check(`JSON.stringify(window.__fixture.calls)===JSON.stringify([false,true,true])`);
      await evaluate(`window.__fixture.report.history={...window.__fixture.report.history,status:'unavailable',totals:Object.fromEntries(Object.keys(window.__fixture.report.history.totals).map(key=>[key,null]))};window.__fixture.report.hooks.history={...window.__fixture.report.hooks.history,status:'unavailable',range:{start:null,end:null},totals:Object.fromEntries(Object.keys(window.__fixture.report.hooks.history.totals).map(key=>[key,null]))};document.querySelector('[aria-label="刷新 Agent 总体统计"]').click()`);
      await waitFor(`[...document.querySelectorAll('.ad-hook-kpis strong')].every(node=>node.textContent==='—')`);
      await checkHomeCardsOnly();
      await check(`!document.querySelector('[aria-label="Agent 总体统计"]').textContent.includes('Demo') && document.documentElement.scrollWidth<=${width}`);
      await screenshot(`home-unavailable-${viewport}`);
      await evaluate(`window.__fixture.report=structuredClone(window.__fixture.initialReport);document.querySelector('[aria-label="刷新 Agent 总体统计"]').click()`);
      await waitFor(`document.querySelector('[aria-label="Agent 总体统计"][aria-busy="false"]') && document.querySelector('.ad-hook-kpis strong')?.textContent==='432'`);
      await checkHomeTotals();
      await checkHomeCardsOnly();
      await check(`JSON.stringify(window.__fixture.calls)===JSON.stringify([false,true,true,true,true]) && window.__fixture.healthRefreshes.length===0 && window.__fixture.unauthorized.length===0 && window.__fixture.apiRequests.length===0`);
      await evaluate(`[...document.querySelectorAll('[aria-label="Agent 总体统计"] button')].find(node=>node.textContent.includes('进入 Agent 管家')).click()`);
      await waitFor(`document.querySelector('.agent-diagnostics .ad-live-tabs') && document.querySelector('[aria-label="事件构成"] .ad-donut-total')?.textContent==='200'`);
      await check(`JSON.stringify(window.__fixture.navigations)===JSON.stringify(['agents']) && JSON.stringify(window.__fixture.calls)===JSON.stringify([false,true,true,true,true,false]) && !document.querySelector('.sh-hero') && !document.querySelector('[aria-label="系统资源"]')`);
      await checkHomeTotals();
      await tab('会话与明细');
      await click('Hook 事件末页');
      await check(`document.querySelector('[aria-label="Hook 事件分页"]').textContent.includes('191–200 / 200') && document.querySelectorAll('[aria-label="Hook 事件元数据"] tbody tr').length===10`);
      await checkHomeTotals();
      await check(`document.documentElement.scrollWidth<=${width} && window.__fixture.unauthorized.length===0 && window.__fixture.apiRequests.length===0`);
      await screenshot(`home-agent-details-${viewport}`);
      await check(`performance.getEntriesByType('resource').every(entry=>!new URL(entry.name).pathname.startsWith('/api/'))`);
    }
    if (process.argv.includes('--agent-only')) {
      assert.deepEqual(apiRequests, []);
      assert.deepEqual(serverApiRequests, []);
      assert.deepEqual(foreignRequests, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(consoleErrors, []);
      assert.deepEqual(networkFailures, []);
      console.log(JSON.stringify({ result: 'PASS', source: 'actual LiveAgentDiagnostics and HealthGuardPage with browser-only fixtures', routes: [url, homeUrl], screenshots: output, viewports: [1280, 720, 390], runtimeErrors: errors, consoleErrors, networkFailures, apiRequests, foreignRequests, serverApiRequests }, null, 2));
      return;
    }
    const energyResults = [];
    const energyDialog = `document.querySelector('dialog[open]')`;
    const processInputs = `[...document.querySelectorAll('dialog[open] input[type="checkbox"][aria-label^="选择进程 "]')]`;
    const processIds = `${processInputs}.map(input=>input.closest('[data-row-id]').dataset.rowId)`;
    const selectedProcessCount = `${processInputs}.filter(input=>input.checked).length`;
    const cleanupButton = `[...document.querySelectorAll('dialog[open] button')].find(button=>button.textContent.includes('清理所选进程'))`;
    const confirmation = `document.querySelector('[role="group"][aria-label="确认结束进程"]')`;
    const processId = pid => `process-${pid}-${pid - 40000}`;
    const inputQuery = async query => {
      await evaluate(`(()=>{const input=document.querySelector('dialog[open] input[aria-label="搜索进程名称或 PID"]');if(!input)throw Error('缺少能耗名称/PID搜索输入');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    };
    const energyButton = async (text, scope = 'dialog[open]') => {
      await evaluate(`(()=>{const button=[...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(button=>button.textContent.replace(/\\s/g,'').includes(${JSON.stringify(text.replace(/\s/g, ''))}));if(!button)throw Error('缺少能耗按钮 '+${JSON.stringify(text)});if(button.disabled)throw Error('能耗按钮意外禁用 '+${JSON.stringify(text)});button.click();return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));})()`);
    };
    const checkProcessIds = async pids => assert.deepEqual(await evaluate(processIds), pids.map(processId), `能耗进程排行应为 PID ${pids.join(', ')}`);
    const checkNoGpuEnergy = async () => {
      await check(`! /gpu/i.test(document.querySelector('[data-resource="energy"]').textContent+' '+[...document.querySelector('[data-resource="energy"]').querySelectorAll('[aria-label],[title]')].map(node=>node.getAttribute('aria-label')+' '+node.getAttribute('title')).join(' '))`);
      await check(`! /gpu/i.test(${energyDialog}.textContent+' '+[...${energyDialog}.querySelectorAll('[aria-label],[title]')].map(node=>node.getAttribute('aria-label')+' '+node.getAttribute('title')).join(' '))`);
    };
    const checkEnergySafety = async () => {
      await check(`window.__energyFixture.unauthorized.length===0 && window.__energyFixture.apiRequests.length===0 && window.__energyFixture.foreignRequests.length===0 && window.__energyFixture.navigations.length===0`);
      await check(`performance.getEntriesByType('resource').every(entry=>new URL(entry.name).origin===location.origin && !new URL(entry.name).pathname.startsWith('/api/'))`);
      assert.deepEqual(apiRequests, []);
      assert.deepEqual(serverApiRequests, []);
      assert.deepEqual(foreignRequests, []);
      assert.deepEqual(errors, []);
      assert.deepEqual(networkFailures, []);
      assert.deepEqual(consoleErrors, []);
    };
    const openEnergy = async (variant, width) => {
      console.log(`Energy acceptance: ${variant}, ${width}px`);
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width === 390 });
      await cdp('Page.navigate', { url: energyUrl + '?fixture=' + variant });
      await waitFor(`window.__energyFixture?.variant===${JSON.stringify(variant)} && document.querySelector('[data-resource="energy"]') && window.__energyFixture.collectorCalls.length>0`);
      await check(`window.__energyFixture.state.mode==='collected' && window.__energyFixture.state.hasGpu===${variant === 'withGPU'} && window.__energyFixture.snapshotCalls.length===0 && window.__energyFixture.prepareCalls.length===0 && window.__energyFixture.executeCalls.length===0`);
      await check(`document.documentElement.scrollWidth<=${width}`);
      await screenshot(`energy-${variant}-home-${width}`);
      await click('查看能耗详情');
      await waitFor(`${energyDialog} && ${energyDialog}.querySelector('[aria-label="功率构成"]')`);
    };
    const assertPrepare = async (pids, count) => {
      await waitFor(`${confirmation} && window.__energyFixture.prepareCalls.length===${count}`);
      assert.deepEqual(await evaluate(`window.__energyFixture.prepareCalls.at(-1)`), { resource: 'energy', ids: pids.map(processId), revision: 71 });
      await check(`${confirmation}.textContent.includes('60 秒') && ${confirmation}.textContent.includes('不清理文件') && window.__energyFixture.executeCalls.length===0`);
      assert.deepEqual(await evaluate(`[...${confirmation}.querySelectorAll('p strong')].map(node=>node.textContent)`),
        pids.map(pid => ({ 41001: 'qoder-cli', 41002: 'Browser-Worker', 41003: 'claude' })[pid]));
      await check(`window.__energyFixture.plans.at(-1).processes.every(row=>row.id.startsWith('process-')) && Date.parse(window.__energyFixture.plans.at(-1).expires_at)-Date.now()>50000 && Date.parse(window.__energyFixture.plans.at(-1).expires_at)-Date.now()<=60000`);
    };
    const checkSelectionCleared = async () => check(`${selectedProcessCount}===0 && !${confirmation} && ${cleanupButton}?.disabled===true && window.__energyFixture.executeCalls.length===0`);
    for (const width of [1280, 390]) {
      await openEnergy('noGPU', width);
      await checkNoGpuEnergy();
      await check(`window.__energyFixture.state.resources.energy.power.gpuWatts===null && !window.__energyFixture.state.resources.energy.power.missing.includes('gpu') && !document.querySelector('[data-resource="gpu"]')`);
      await check(`document.querySelector('[data-resource="energy"]').textContent.includes('48 W') && ${energyDialog}.textContent.includes('CPU') && ${energyDialog}.textContent.includes('估算') && /非.{0,12}实测|不是.{0,12}实测/.test(${energyDialog}.textContent) && /未归因[^。\\n]*18 W/.test(${energyDialog}.textContent)`);
      await check(`document.querySelector('[aria-label="功率构成"] [data-component-id="power-cpu-rapl"]').textContent.includes('48 W') && document.querySelectorAll('[aria-label="功率构成"] tbody tr').length===1 && !document.querySelector('[aria-label="功率构成"] input')`);
      await check(`document.querySelector('input[aria-label="搜索进程名称或 PID"]')?.value==='' && ${cleanupButton}?.disabled===true && ${selectedProcessCount}===0`);
      await checkProcessIds([41001, 41002, 41003, 41004]);
      await check(`(()=>{const table=${processInputs}[0].closest('table');return /CPU/.test(table.querySelector('thead').textContent)&&/估算/.test(table.querySelector('thead').textContent)&&/W/.test(table.querySelector('thead').textContent)&&! /实测|GPU/i.test(table.querySelector('thead').textContent);})()`);
      for (const [pid, watts] of [[41001, 16], [41002, 8], [41003, 4], [41004, 2]]) await check(`document.querySelector('[data-row-id="${processId(pid)}"]').textContent.includes('${watts} W')`);
      await check(`document.querySelector('input[aria-label="选择进程 sysagent-idc-protected PID 41004"]').disabled===true && !document.querySelector('input[aria-label="选择进程 sysagent-idc-protected PID 41004"]').checked && ${processInputs}.filter(input=>!input.disabled).length===3`);
      await screenshot(`energy-noGPU-ranking-${width}`);
      if (width === 390) {
        await evaluate(`(()=>{const wrapper=document.querySelector('[data-row-id]').closest('.sh-rank-table');wrapper.scrollLeft=wrapper.scrollWidth;})()`);
        await check(`(()=>{const wrapper=document.querySelector('[data-row-id]').closest('.sh-rank-table');const watts=wrapper.querySelector('tbody tr td:nth-child(4) b').getBoundingClientRect();const bounds=wrapper.getBoundingClientRect();return wrapper.scrollLeft>0&&watts.left>=bounds.left&&watts.right<=bounds.right;})()`);
        await screenshot('energy-noGPU-watts-390');
        await evaluate(`document.querySelector('[data-row-id]').closest('.sh-rank-table').scrollLeft=0`);
      }
      for (const [query, pids] of [['browser-worker', [41002]], ['BROWSER-WORKER', [41002]], ['qOdEr', [41001]], ['41003', [41003]], ['1002', [41002]]]) {
        await inputQuery(query); await checkProcessIds(pids); await checkSelectionCleared();
      }
      await inputQuery('NO-SUCH-ENERGY-PROCESS');
      await checkProcessIds([]);
      await check(`${energyDialog}.textContent.includes('没有匹配') && !document.querySelector('[aria-label="功率构成"]').textContent.includes('未知') && ${energyDialog}.textContent.includes('48 W') && document.querySelector('input[aria-label="全选可结束进程"]').disabled && ${cleanupButton}.disabled`);
      await screenshot(`energy-noGPU-no-match-${width}`);
      await inputQuery('');
      await energyButton('只看Agent');
      await checkProcessIds([41001, 41003]);
      await check(`[...document.querySelectorAll('[aria-label="排行筛选"] button')].find(button=>button.textContent.replace(/\\s/g,'').includes('只看Agent')).getAttribute('aria-pressed')==='true'`);
      await click('全选可结束进程');
      await check(`${selectedProcessCount}===2`);
      await energyButton('全部程序');
      await checkProcessIds([41001, 41002, 41003, 41004]);
      await checkSelectionCleared();
      await click('全选可结束进程');
      await check(`${selectedProcessCount}===3 && !document.querySelector('input[aria-label="选择进程 sysagent-idc-protected PID 41004"]').checked`);
      await inputQuery('qoder');
      await checkProcessIds([41001]);
      await checkSelectionCleared();
      await click('选择进程 qoder-cli PID 41001');
      await energyButton('清理所选进程');
      await assertPrepare([41001], 1);
      await screenshot(`energy-noGPU-query-plan-${width}`);
      await inputQuery('');
      await checkSelectionCleared();
      await click('选择进程 qoder-cli PID 41001');
      await energyButton('清理所选进程');
      await assertPrepare([41001], 2);
      await energyButton('只看Agent');
      await checkProcessIds([41001, 41003]);
      await checkSelectionCleared();
      // Test invalidation in the opposite filter direction as well.
      await click('全选可结束进程');
      await energyButton('清理所选进程');
      await assertPrepare([41001, 41003], 3);
      await energyButton('全部程序');
      await checkSelectionCleared();
      await click('全选可结束进程');
      await energyButton('清理所选进程');
      await assertPrepare([41001, 41002, 41003], 4);
      await evaluate(`${confirmation}.scrollIntoView({block:'end'})`);
      await screenshot(`energy-noGPU-confirm-cancel-${width}`);
      await energyButton('取消', '[role="group"][aria-label="确认结束进程"]');
      await check(`!${confirmation} && window.__energyFixture.executeCalls.length===0 && window.__energyFixture.refreshes.length===0 && window.__energyFixture.snapshotCalls.length===0`);
      await energyButton('清理所选进程');
      await assertPrepare([41001, 41002, 41003], 5);
      await evaluate(`${confirmation}.scrollIntoView({block:'end'})`);
      await screenshot(`energy-noGPU-confirm-execute-${width}`);
      await evaluate(`window.__energyFixture.confirmButton=[...${confirmation}.querySelectorAll('button')].find(button=>button.textContent==='确认结束进程');window.__energyFixture.confirmButton.click();window.__energyFixture.confirmButton.click()`);
      await waitFor(`window.__energyFixture.pendingExecutions.length===1 && !${confirmation}`);
      await evaluate(`window.__energyFixture.confirmButton.click();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      await check(`window.__energyFixture.executeCalls.length===1 && window.__energyFixture.refreshes.length===0 && document.querySelector('input[aria-label="全选可结束进程"]').disabled`);
      assert.deepEqual(await evaluate(`window.__energyFixture.executeCalls`), [{ token: 'energy-fixture-only-5' }]);
      await evaluate(`window.__energyFixture.pendingExecutions.shift()()`);
      await waitFor(`document.querySelector('[data-resource="energy"]').dataset.version==='72' && window.__energyFixture.refreshes.length===1 && window.__energyFixture.busyChanges.at(-1)===false`);
      assert.deepEqual(await evaluate(`window.__energyFixture.refreshes`), [true]);
      assert.deepEqual(await evaluate(`window.__energyFixture.snapshotCalls`), [true]);
      assert.deepEqual(await evaluate(`window.__energyFixture.events`), ['prepare', 'prepare', 'prepare', 'prepare', 'prepare', 'execute', 'refresh', 'snapshot']);
      await check(`${selectedProcessCount}===0 && !${confirmation} && ${cleanupButton}.disabled && window.__energyFixture.executeCalls.length===1 && window.__energyFixture.notifications.length===1 && ${energyDialog}.textContent.includes('不代表已退出')`);
      await checkNoGpuEnergy();
      await check(`document.documentElement.scrollWidth<=${width} && ${energyDialog}.getBoundingClientRect().width<=${width} && ${energyDialog}.getBoundingClientRect().left>=0 && document.querySelector('[aria-label="搜索进程名称或 PID"]').getBoundingClientRect().right<=${width}`);
      await screenshot(`energy-noGPU-refreshed-${width}`);
      await checkEnergySafety();
      energyResults.push({ variant: 'noGPU', width, prepareCalls: 5, fakeExecuteCalls: 1, refreshes: 1 });
      await openEnergy('withGPU', width);
      await check(`document.querySelector('[data-resource="energy"]').textContent.includes('144 W') && document.querySelector('[data-resource="energy"]').textContent.includes('GPU 96 W')`);
      await check(`document.querySelectorAll('[aria-label="功率构成"] tbody tr').length===2 && document.querySelector('[aria-label="功率构成"] [data-component-id="power-cpu-rapl"]').textContent.includes('48 W') && document.querySelector('[aria-label="功率构成"] [data-component-id="power-gpu-sensor"]').textContent.includes('96 W') && !document.querySelector('[aria-label="功率构成"] input')`);
      await checkProcessIds([41001, 41002, 41003, 41004]);
      await check(`(()=>{const table=${processInputs}[0].closest('table');return /CPU/.test(table.querySelector('thead').textContent)&&/估算/.test(table.querySelector('thead').textContent)&&! /GPU|实测/.test(table.querySelector('thead').textContent)&&! /GPU/.test(table.querySelector('tbody').textContent);})()`);
      await check(`${energyDialog}.textContent.includes('未归因') && /GPU[^。\\n]*(不归因|不.*分摊|不.*实测)|不[^。\\n]*GPU/.test(${energyDialog}.textContent) && window.__energyFixture.prepareCalls.length===0 && window.__energyFixture.executeCalls.length===0`);
      await check(`document.documentElement.scrollWidth<=${width} && ${energyDialog}.getBoundingClientRect().width<=${width}`);
      await screenshot(`energy-withGPU-ranking-${width}`);
      await checkEnergySafety();
      energyResults.push({ variant: 'withGPU', width, fakeExecuteCalls: 0 });
      for (const variant of ['empty', 'unavailable']) {
        await openEnergy(variant, width);
        await checkNoGpuEnergy();
        await checkProcessIds([]);
        await check(`${energyDialog}.textContent.includes('进程功率未知') && !/未归因[^。\\n]*\\b0 W/.test(${energyDialog}.textContent) && ${cleanupButton}?.disabled===true && document.querySelector('input[aria-label="全选可结束进程"]').disabled && window.__energyFixture.prepareCalls.length===0 && window.__energyFixture.executeCalls.length===0`);
        await check(variant === 'unavailable'
          ? `window.__energyFixture.state.resources.energy.power.unattributedCpuWatts===null && /未归因[^。\\n]*未知/.test(${energyDialog}.textContent)`
          : `window.__energyFixture.state.resources.energy.power.unattributedCpuWatts===48 && /未归因[^。\\n]*48 W/.test(${energyDialog}.textContent)`);
        await check(`${energyDialog}.textContent.includes('没有可用') || ${energyDialog}.textContent.includes('暂无')`);
        if (variant === 'unavailable') await check(`document.querySelector('[data-resource="energy"]').textContent.includes('不可用') && !document.querySelector('[data-resource="energy"]').textContent.includes('0 W') && !document.querySelector('[aria-label="功率构成"] input')`);
        else await check(`document.querySelector('[aria-label="功率构成"]').textContent.includes('48 W')`);
        await inputQuery('no-match');
        await checkProcessIds([]);
        await check(`${cleanupButton}.disabled && document.documentElement.scrollWidth<=${width}`);
        await screenshot(`energy-${variant}-ranking-${width}`);
        await checkEnergySafety();
        energyResults.push({ variant, width, fakeExecuteCalls: 0 });
      }
    }
    assert.deepEqual(apiRequests, []);
    assert.deepEqual(serverApiRequests, []);
    assert.deepEqual(foreignRequests, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(networkFailures, []);
    console.log(JSON.stringify({ result: 'PASS', source: 'actual HealthGuardPage, ResourceRankings and LiveAgentDiagnostics with browser-only fixtures', routes: [url, homeUrl, energyUrl], screenshots: output, viewports: [1280, 720, 390], energyResults, runtimeErrors: errors, consoleErrors, networkFailures, apiRequests, foreignRequests, serverApiRequests }, null, 2));
  } catch (error) {
    if (cdp && socket?.readyState === WebSocket.OPEN) {
      const image = await cdp('Page.captureScreenshot', { captureBeyondViewport: true }).catch(() => null);
      if (image) fs.writeFileSync(path.join(output, 'failure.png'), Buffer.from(image.data, 'base64'));
      const evidence = await cdp('Runtime.evaluate', { returnByValue: true, expression: `(()=>{const fixture=window.__energyFixture;if(!fixture)return {url:location.href};return {url:location.href,variant:fixture.variant,body:document.body.innerText,prepareCalls:fixture.prepareCalls,executeCalls:fixture.executeCalls,refreshes:fixture.refreshes,snapshotCalls:fixture.snapshotCalls,events:fixture.events,unauthorized:fixture.unauthorized,apiRequests:fixture.apiRequests,foreignRequests:fixture.foreignRequests};})()` }).catch(() => null);
      if (evidence) console.error('Browser failure evidence:', JSON.stringify(evidence.result?.value, null, 2));
    }
    console.error(`Failure screenshots: ${output}`);
    throw error;
  } finally {
    if (cdp && socket?.readyState === WebSocket.OPEN) await cdp('Browser.close').catch(() => {});
    socket?.close();
    if (chrome && chrome.exitCode === null) { await Promise.race([once(chrome, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]); if (chrome.exitCode === null) { chrome.kill('SIGTERM'); await once(chrome, 'exit'); } }
    await server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
