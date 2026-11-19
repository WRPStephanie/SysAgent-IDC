const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

require.extensions['.tsx'] = require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};
const shared = require('../src/agent-diagnostics-data.ts');
const absolute = path.resolve(__dirname, '../src/AgentDiagnostics.tsx');
const source = fs.readFileSync(absolute, 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  fileName: absolute,
}).outputText;

function diagnostic(overrides = {}) {
  return {
    source: 'agentsight', analyzer: 'sysom-openapi', sampledAt: '2026-11-11T12:00:00Z',
    window: { start: '2026-11-10T12:00:00Z', end: '2026-11-11T12:00:00Z' },
    status: 'ok', outcome: 'observed', summary: 'actual report summary', lastScanAt: null,
    filteredProcesses: null,
    coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status: 'available', reason: `actual-${key}` })),
    totals: { sessions: null, inputTokens: null, outputTokens: null, unresolved: null, critical: null, high: null },
    findings: [], processes: [], sessions: [], interruptions: [], latency: [],
    hooks: { status: 'unavailable', reason: '', skippedLines: null, agents: [], events: [] },
    ...overrides,
  };
}
test('service strip distinguishes collection state from data-service connectivity without disclosing deployment or messages', async () => {
  const labels = [['running', '采集中'], ['disabled', '采集停用'], ['failed', '采集失败'], ['unavailable', '采集不可用']];
  const actualLabels = [];
  for (const [state] of labels) {
    const h = harness(undefined, { fetchCollectorStatus: async () => ({ agent_sight: {
      state: 'running', message: 'API 服务可用',
      collection: { state, enabled: state === 'running', scope: state === 'running' ? 'host' : 'none', trace_running: state === 'running', api_running: true, message: `actual collection ${state}` },
    } }) });
    h.render(); h.mount(); await settle();
    const tree = h.render();
    const status = elements(tree, node => node.props.role === 'status' && node.props['aria-label'] === '真实调用采集状态')[0];
    assert(status, 'collection has an accessible status, independent of report outcome');
    const collection = elements(status, node => node.props.className?.split(' ').includes('ad-service-state'))[0];
    assert(collection);
    actualLabels.push([state, text(collection)]);
    assert.match(text(status), /数据服务 可用/);
    assert.doesNotMatch(text(collection), /API|采集完成|\(observed\)/);
    const disclosure = collectionDetails(tree);
    assert.match(text(disclosure), /缺失数据不代表正常.*— 表示未知/);
    assert.match(text(disclosure), /Token 为来源已记录用量，未报告用量可能未计入/);
    assert.equal(text(disclosure).includes('采集停用，当前显示历史记录。'), state === 'disabled');
    assert.doesNotMatch(renderToStaticMarkup(tree), /--enable-agent-collection|主机级采集|本地会话内容保存|actual collection|API 服务可用|SYSOM_AGENTSIGHT_|127\.0\.0\.1:739[67]|CAP_SYS_ADMIN|systemd/);
    assertCompactShell(tree);
    h.unmount();
  }
  for (const fetchCollectorStatus of [async () => ({}), async () => { throw new Error('collector status unavailable'); }]) {
    const h = harness(undefined, { fetchCollectorStatus });
    h.render(); h.mount(); await settle();
    assert.match(text(outsideDetails(h.render())), /采集状态未知/);
    assert.doesNotMatch(text(h.render()), /诊断请求失败/);
    h.unmount();
  }
  assert.deepEqual(actualLabels, labels, 'strip uses the confirmed short collection-state labels');
});

function processEvidence(overrides = {}) {
  return { pid: 801, name: 'actual-cli', role: 'worker', status: 'healthy', ports: [8001], lastCheckAt: null, latencyMs: null, parentPid: null, hasCrash: false, ...overrides };
}
function sessionEvidence(overrides = {}) {
  return { id: 'actual-session', agent: 'actual-agent', model: 'actual-model', conversations: 0, inputTokens: 0, outputTokens: 0, firstSeenAt: null, lastSeenAt: null, ...overrides };
}
function interruption(overrides = {}) {
  return { id: 'actual-event', sessionId: null, callId: null, pid: null, agent: null, type: 'llm_error', severity: 'high', occurredAt: null, resolved: false, ...overrides };
}
function hookAgentSummary(overrides = {}) {
  return { agent: 'qoder', sessions: 0, events: 0, prompts: 0, toolStarts: 0, toolEnds: 0, toolFailures: 0,
    interrupts: 0, permissionDenied: 0, turnFailures: 0, openTools: 0, lastEventAt: '2026-11-11T11:00:00Z', ...overrides };
}
function hookActivity(count = 200, overrides = {}) {
  const kinds = Object.keys(shared.agentHookKindLabels).map((kind, index) => ({ kind, count: index === 0 ? count : 0 }));
  const bins = count === 0 ? [] : Array.from({ length: 12 }, (_, index) => ({
    start: new Date(Date.parse('2026-11-10T23:00:00Z') + index * 3600000).toISOString(),
    end: new Date(Date.parse('2026-11-11T00:00:00Z') + index * 3600000).toISOString(),
    count: index === 11 ? count : 0, failures: 0, interrupts: 0,
  }));
  return {
    events: count,
    range: count === 0 ? { start: null, end: null } : { start: bins[0].start, end: bins.at(-1).end },
    reason: 'Aggregate enabled after prior rotation', kinds, bins,
    sessions: count === 0 ? [] : [{ key: 'a'.repeat(64), agent: 'qoder', events: count, prompts: 0, toolStarts: 0,
      turnFailures: 0, firstEventAt: bins.at(-1).start, lastEventAt: bins.at(-1).end }],
    tools: [], subagents: [], ...overrides,
  };
}
function hookCumulativeEvidence(overrides = {}) {
  const { agent, lastEventAt, ...totals } = hookAgentSummary(overrides);
  return { status: 'available', reason: 'Actual bounded summary', skippedLines: 0,
    agents: [hookAgentSummary(overrides)], events: [],
    history: hookHistory({ range: totals.events === 0 ? { start: null, end: null } : hookHistory().range, totals }),
  };
}
function hookEvent(overrides = {}) {
  return { id: 'hook-event', agent: 'qoder', kind: 'session_start', occurredAt: '2026-11-11T11:00:00Z',
    sessionId: null, tool: null, callId: null, errorType: null, interrupt: null, subagent: null, model: null, ...overrides };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }

// Load the actual TSX with hook slots, effects and cleanup; no additional renderer dependency.
function harness(fetchAgentDiagnostic = async () => diagnostic(), options = {}) {
  const slots = [];
  const effects = new Map();
  const pendingEffects = [];
  const calls = [];
  const collectorCalls = [];
  const unexpectedClientAccess = [];
  const notifications = [];
  let cursor = 0;
  let writes = 0;
  const hooks = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {
        writes++;
        slots[index] = typeof value === 'function' ? value(slots[index]) : value;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(setup, dependencies) {
      const index = cursor++;
      const previous = effects.get(index);
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        const effect = { setup, dependencies, cleanup: previous?.cleanup };
        effects.set(index, effect);
        pendingEffects.push(effect);
      }
    },
  };
  const MockModal = ({ title, subtitle, children }) => React.createElement('section', { role: 'dialog' }, React.createElement('h2', null, title), subtitle, children);
  const demoPoison = {
    get agentSummary() { throw new Error('Live UI accessed Demo summary'); },
    formatNumber() { throw new Error('Live UI accessed Demo formatter'); },
  };
  const home = options.component === 'HomeAgentStatistics';
  const filename = home ? path.resolve(__dirname, '../src/AgentOverviewCards.tsx') : absolute;
  const output = home ? ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: filename,
  }).outputText : compiled;
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const execute = vm.runInThisContext(`(function(require,module,exports){${output}\n})`, { filename });
  execute(id => {
    if (id === 'react') return hooks;
    if (id === './components') return { Modal: MockModal };
    if (id === './idc-client') return new Proxy({
      fetchAgentDiagnostic: refresh => { calls.push(refresh); return fetchAgentDiagnostic(refresh); },
      fetchCollectorStatus: (...args) => { collectorCalls.push(args); return (options.fetchCollectorStatus || (async () => ({})))(...args); },
    }, {
      get(client, key) {
        if (Object.hasOwn(client, key)) return client[key];
        unexpectedClientAccess.push(String(key));
        throw new Error(`Live UI accessed an unauthorized client resource: ${String(key)}`);
      },
    });
    if (id === './agent-summary' && !options.demo) return demoPoison;
    return localRequire(id);
  }, module, module.exports);
  const opened = [];
  const props = home ? { onOpen: () => opened.push('agents') } : { onNotify: message => notifications.push(message) };
  return {
    calls, collectorCalls, notifications, opened,
    render(overrides = {}) {
      cursor = 0;
      const tree = module.exports[home ? 'HomeAgentStatistics' : 'LiveAgentDiagnostics']({ ...props, ...overrides });
      assert.deepEqual(unexpectedClientAccess, [], 'live UI may only access read-only report and collector status, never conversation/session or destructive resources');
      return tree;
    },
    renderDemo() {
      cursor = 0;
      return home ? module.exports.AgentOverviewCards({ recovered: false, disabled: false, ...props })
        : module.exports.AgentDiagnostics({ recovered: false, onRestart() {}, ...props });
    },
    mount() { for (const effect of pendingEffects.splice(0)) { effect.cleanup?.(); effect.cleanup = effect.setup(); } },
    replayEffects() { for (const effect of effects.values()) { effect.cleanup?.(); effect.cleanup = effect.setup(); } },
    unmount() { for (const effect of effects.values()) effect.cleanup?.(); },
    writes() { return writes; },
  };
}
function elements(element, predicate) {
  if (Array.isArray(element)) return element.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(element)) return [];
  return [...(predicate(element) ? [element] : []), ...elements(element.props.children, predicate)];
}
function text(element) {
  if (Array.isArray(element)) return element.map(text).join('');
  if (React.isValidElement(element)) return text(element.props.children);
  return element == null || typeof element === 'boolean' ? '' : String(element);
}
function button(tree, label) {
  // Legacy bare next/previous actions belong to the process table, not new independent pagers.
  if (label === '上一页' || label === '下一页') {
    const processPager = elements(tree, node => node.props['aria-label'] === '进程探活分页')[0];
    if (processPager) tree = processPager;
  }
  const result = elements(tree, node => node.type === 'button' && (text(node).includes(label) || node.props['aria-label'] === label))[0];
  assert(result, `Missing button: ${label}`);
  return result;
}
function region(tree, label) {
  const result = elements(tree, node => node.props.role === 'region' && node.props['aria-label'] === label)[0];
  assert(result, `Missing region: ${label}`);
  return result;
}
function collectionDetails(tree) {
  const result = elements(tree, node => node.type === 'details' && node.props.className?.split(' ').includes('ad-collection-details'))[0];
  assert(result, 'collection disclosure must be a native details element');
  assert.equal(elements(result, node => node.type === 'summary').length, 1);
  assert.equal(text(elements(result, node => node.type === 'summary')[0]), '数据范围');
  assert(!result.props.open && result.props.defaultOpen !== true, 'data scope is folded by default');
  const ordered = elements(tree, () => true);
  const panel = elements(tree, node => node.props.role === 'tabpanel')[0];
  assert(panel && ordered.indexOf(result) > ordered.indexOf(panel), 'data scope follows the active tab panel');
  assert(!elements(panel, node => node === result).length, 'data scope is not inside the tab panel');
  return result;
}
function outsideDetails(tree) {
  if (Array.isArray(tree)) return tree.map(outsideDetails);
  if (!React.isValidElement(tree)) return tree;
  if (tree.type === 'details') return null;
  return React.cloneElement(tree, {}, outsideDetails(tree.props.children));
}
function tab(tree, label) {
  const result = elements(tree, node => node.props.role === 'tab' && text(node) === label)[0];
  assert(result, `Missing tab: ${label}`);
  assert.equal(typeof result.props.onClick, 'function');
  return result;
}
function selectTab(h, label) {
  tab(h.render(), label).props.onClick();
  const tree = h.render();
  for (const name of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) assert.equal(tab(tree, name).props['aria-selected'], name === label);
  const panels = elements(tree, node => node.props.role === 'tabpanel');
  assert.equal(panels.length, 1, 'only the active tab panel is rendered');
  assert.equal(tab(tree, label).props['aria-controls'], panels[0].props.id);
  assert.equal(panels[0].props['aria-labelledby'], tab(tree, label).props.id);
  return tree;
}
function tableRows(tree) {
  return elements(tree, node => node.type === 'tr' && elements(node, cell => cell.type === 'td' && !cell.props.colSpan).length > 0);
}
function pagination(tree, name) {
  const matches = elements(tree, node => node.type === 'nav' && node.props['aria-label'] === `${name}分页`);
  assert.equal(matches.length, 1, `Missing or duplicate pagination: ${name}`);
  return matches[0];
}
function pageButton(tree, name, action) {
  const matches = elements(pagination(tree, name), node => node.type === 'button' && node.props['aria-label'] === `${name}${action}`);
  assert.equal(matches.length, 1);
  return matches[0];
}
function allTablePages(h, name, label) {
  pageButton(h.render(), name, '首页').props.onClick();
  const rows = [];
  for (let attempts = 0; attempts < 200; attempts++) {
    const tree = h.render();
    rows.push(...tableRows(region(tree, label)));
    const next = pageButton(tree, name, '下一页');
    if (next.props.disabled) {
      pageButton(tree, name, '首页').props.onClick();
      return rows;
    }
    next.props.onClick();
  }
  assert.fail(`Pagination did not terminate: ${name}`);
}
function hookIds(tree) {
  const metadata = elements(tree, node => node.props.role === 'region' && node.props['aria-label'] === 'Hook 事件元数据')[0];
  return metadata ? tableRows(metadata).map(row => elements(row, node => node.type === 'button')[0].props['aria-label'].slice('查看 Hook 证据 '.length)) : [];
}
const hookKpiKeys = ['sessions', 'events', 'prompts', 'toolStarts', 'turnFailures', 'openTools'];
const hookKpiLabels = ['已记录会话', 'Hook 事件', '提交提问', '工具开始', '轮次失败', '未配对开始'];
function shellChildren(children) {
  return React.Children.toArray(children).flatMap(child => React.isValidElement(child) && child.type === React.Fragment ? shellChildren(child.props.children) : [child]);
}
function hookKpiCards(tree, { home = false } = {}) {
  const matches = elements(tree, node => node.props.className?.split(' ').includes('ad-hook-kpis'));
  assert.equal(matches.length, 1, 'exactly one six-card Hook block exists, including loading and every tab');
  const block = matches[0];
  assert.equal(block.type, 'section');
  assert.equal(block.props.className, 'ad-hook-kpis', 'keep the original six-card styling hook');
  assert.equal(block.props['aria-label'], 'Hook 累计总体统计');
  const cards = block.props.children;
  assert.equal(cards.length, 6);
  assert.deepEqual(cards.map(card => card.key), hookKpiKeys);
  assert.deepEqual(cards.map(card => text(card.props.children[1])), hookKpiLabels);
  for (const card of cards) {
    assert.equal(card.type, 'div');
    assert.equal(card.props.className, undefined);
    assert.deepEqual(React.Children.toArray(card.props.children).map(child => child.type), ['strong', 'span'], 'preserve section > div > strong + span, without nested wrappers');
  }
  const children = shellChildren(tree.props.children);
  const index = children.indexOf(children.find(child => child.props?.className === 'ad-hook-kpis'));
  assert(index > 0, 'KPI section is a direct DOM child of the live shell, allowing shared fragments');
  assertNoAgentSightStatistics(tree);
  assert.equal(children[index - 1].props.className, home ? 'sh-panel-head' : 'ad-section-head');
  if (home) {
    assert.deepEqual(elements(children[index - 1], node => node.type === 'h2').map(text), ['Agent 总体统计']);
    assert.equal(elements(tree, node => node.props.role === 'tablist').length, 0);
  } else {
    assert.deepEqual(elements(children[index - 1], node => node.type === 'h3').map(text), ['Agent 活动总体统计']);
    assert.equal(elements(tree, node => node.type === 'h3' && text(node) === 'Agent 活动总体统计').length, 1);
    const ordered = elements(tree, () => true);
    const tablist = elements(tree, node => node.props.role === 'tablist')[0];
    const panel = elements(tree, node => node.props.role === 'tabpanel')[0];
    assert(ordered.indexOf(block) < ordered.indexOf(tablist) && ordered.indexOf(block) < ordered.indexOf(panel), 'all six cards precede every tab and panel');
    assert.equal(elements(panel, node => node === block).length, 0);
  }
  assert.equal(elements(tree, node => node.props.className?.split(' ').includes('ad-stats')).length, 0, 'old AgentSight four-card block is fully removed');
  assert.doesNotMatch(text(block), /输入\s*Token|输出\s*Token/i, 'Hook metrics remain independent of AgentSight historical Token usage');
  return cards;
}
function hookKpiValues(tree, options) {
  return hookKpiCards(tree, options).map(card => text(card.props.children[0]));
}
function assertCompactShell(tree) {
  assert.match(text(tree), /本机 Agent 诊断/);
  hookKpiCards(tree);
  const all = elements(tree, () => true);
  const beforeMetrics = all.slice(0, all.findIndex(node => node.props.className === 'ad-hook-kpis'));
  assert.equal(beforeMetrics.filter(node => node.type === 'p').length, 0, 'no wall of copy ahead of metrics');
  collectionDetails(tree);
  assert.deepEqual(elements(tree, node => node.props.role === 'tab').map(text), ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']);
}
async function loaded(report) {
  const h = harness(async () => report);
  h.render();
  h.mount();
  await settle();
  return h;
}

function hookHistory(overrides = {}) {
  const value = {
    scope: 'cumulative', status: 'available', reason: 'PRIVATE_HISTORY_REASON', sampledAt: '2026-11-11T12:00:00Z',
    range: { start: '2026-01-01T00:00:00Z', end: '2026-11-11T11:00:00Z' },
    totals: { sessions: 432, events: 12345, prompts: 6789, toolStarts: 8901, toolEnds: 8765, toolFailures: 321,
      interrupts: 54, permissionDenied: 23, turnFailures: 678, openTools: 90 },
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'activity')) value.activity = value.status === 'available' && Number.isSafeInteger(value.totals.events)
    ? hookActivity(Math.min(value.totals.events, 200)) : null;
  return value;
}
function homeHarness(fetch, options = {}) {
  return harness(fetch, { ...options, component: 'HomeAgentStatistics' });
}
async function loadedHome(report) {
  const h = homeHarness(async () => report);
  h.render(); h.mount(); await settle();
  return h;
}
const historyKpis = ['432', '12,345', '6,789', '8,901', '678', '90'];
function assertHomeCardsOnly(tree) {
  assert.equal(elements(tree, node => node.props.className?.split(' ').includes('ad-activity-chart')).length, 0);
  assert.doesNotMatch(text(tree), /活动趋势|事件构成|会话活动排行|工具活动排行|近 24h 最新明细|统计图不可用/);
}

test('HomeAgentStatistics loads only after mount, shares its replay lock and shows only cards with navigation', async () => {
  const demo = homeHarness(undefined, { demo: true });
  assert.match(renderToStaticMarkup(demo.renderDemo()), /Demo 数据/);
  assert.deepEqual(demo.calls, []);
  const pending = deferred();
  const h = homeHarness(() => pending.promise);
  const initial = h.render();
  assert.equal(initial.props['aria-label'], 'Agent 总体统计');
  assert.deepEqual(hookKpiValues(initial, { home: true }), Array(6).fill('—'));
  button(initial, '刷新 Agent 总体统计').props.onClick();
  assert.deepEqual(h.calls, [], 'unmounted actions cannot request a report');
  h.mount(); h.replayEffects(); h.replayEffects();
  const loading = h.render();
  assert.equal(loading.props['aria-busy'], true);
  assert.equal(button(loading, '刷新 Agent 总体统计').props.disabled, true);
  assert.match(text(loading), /正在获取 Agent 统计/);
  button(initial, '刷新 Agent 总体统计').props.onClick();
  assert.deepEqual(h.calls, [false]);
  pending.resolve(freezeEvidence(diagnostic({ hooks: { ...hookCumulativeEvidence({ events: 5000 }), history: hookHistory(), events: timedHooks(250) } })));
  await settle();
  const tree = h.render();
  assert.equal(tree.props['aria-busy'], false);
  assert.deepEqual(hookKpiValues(tree, { home: true, history: true }), historyKpis);
  assert.match(text(tree), /Hook 累计历史.*更新于/s);
  for (const state of [initial, loading, tree]) assertHomeCardsOnly(state);
  button(tree, '进入 Agent 管家').props.onClick();
  assert.deepEqual(h.opened, ['agents']);
  assert.deepEqual(h.calls, [false]);
  assert.deepEqual(h.collectorCalls, []);
  assert.deepEqual(h.notifications, []);
  assertNoDemo(renderToStaticMarkup(tree));
  assert.doesNotMatch(renderToStaticMarkup(tree), /PRIVATE_|sh-agent-overview|data-agent-stat/);
  h.unmount();
});

test('HomeAgentStatistics refresh is immediately locked, preserves frozen historical totals on stale failure and retries with true', async () => {
  const old = freezeEvidence(diagnostic({ hooks: { ...hookCumulativeEvidence({ events: 5000 }), history: hookHistory(), events: timedHooks(250) } }));
  const original = structuredClone(old);
  const pending = deferred();
  const next = freezeEvidence(diagnostic({ sampledAt: '2026-11-11T13:00:00Z', hooks: { ...old.hooks,
    history: hookHistory({ totals: { ...old.hooks.history.totals, events: 23456 } }), events: [] } }));
  let refreshes = 0;
  const h = homeHarness(refresh => !refresh ? Promise.resolve(old) : ++refreshes === 1 ? pending.promise : Promise.resolve(next));
  h.render(); h.mount(); await settle();
  const refresh = button(h.render(), '刷新 Agent 总体统计');
  refresh.props.onClick(); refresh.props.onClick(); refresh.props.onClick();
  const busy = h.render();
  assert.equal(busy.props['aria-busy'], true);
  assert.match(text(busy), /正在更新，当前显示上次报告/);
  assert.deepEqual(hookKpiValues(busy, { home: true, history: true }), historyKpis);
  assert.deepEqual(h.calls, [false, true]);
  pending.reject(new Error('PRIVATE_REFRESH_ERROR /api/idc/operations credentials'));
  await settle();
  const stale = h.render();
  assert.equal(stale.props['aria-busy'], false);
  assert.match(text(elements(stale, node => node.props.role === 'alert')), /暂时无法更新 Agent 统计，请稍后重试.*保留上次报告，不代表本次状态/s);
  assert.deepEqual(hookKpiValues(stale, { home: true, history: true }), historyKpis);
  for (const state of [busy, stale]) assertHomeCardsOnly(state);
  assert.doesNotMatch(renderToStaticMarkup(stale), /PRIVATE_|credentials|\/api\//);
  refresh.props.onClick(); await settle();
  const updated = h.render();
  assert.deepEqual(hookKpiValues(updated, { home: true, history: true }), ['432', '23,456', '6,789', '8,901', '678', '90']);
  assert.equal(elements(updated, node => node.props.role === 'alert').length, 0);
  assertHomeCardsOnly(updated);
  assert.deepEqual(h.calls, [false, true, true]);
  assert.deepEqual(h.collectorCalls, []);
  assert.deepEqual(old, original);
  h.unmount();
});

test('HomeAgentStatistics unknown and failed initial reports never substitute Demo data or observed zeros', async () => {
  for (const failure of [new Error('PRIVATE_INITIAL_FAILURE'), 'PRIVATE_STRING_FAILURE', { message: 'PRIVATE_OBJECT_FAILURE' }, null, new Error('')]) {
    const h = homeHarness(async () => { throw failure; });
    h.render(); h.mount(); await settle();
    const tree = h.render();
    assert.deepEqual(hookKpiValues(tree, { home: true }), Array(6).fill('—'));
    assert.equal(tree.props['aria-busy'], false);
    assert.equal(text(elements(tree, node => node.props.role === 'alert')), '暂时无法更新 Agent 统计，请稍后重试。');
    assert.match(text(tree), /尚未取得本机报告.*未知/);
    assert.equal(button(tree, '刷新 Agent 总体统计').props.disabled, false);
    assertNoDemo(renderToStaticMarkup(tree));
    assert.doesNotMatch(renderToStaticMarkup(tree), /PRIVATE_|\[object Object\]|Demo 数据/);
    assert.deepEqual(h.calls, [false]);
    assert.deepEqual(h.collectorCalls, []);
    h.unmount();
  }
  const h = await loadedHome(diagnostic({ status: 'unavailable', outcome: 'unknown' }));
  assert.deepEqual(hookKpiValues(h.render(), { home: true }), Array(6).fill('—'));
  assert.match(text(h.render()), /汇总不可用或不完整，— 表示未知/);
  assertHomeCardsOnly(h.render());
  assertNoDemo(renderToStaticMarkup(h.render()));
  h.unmount();
});

test('HomeAgentStatistics mount and refresh settlements after cleanup never write state, notify or initiate another request', async () => {
  for (const refresh of [false, true]) for (const reject of [false, true]) {
    const pending = deferred();
    const h = homeHarness(isRefresh => refresh && !isRefresh ? Promise.resolve(diagnostic()) : pending.promise);
    h.render(); h.mount(); await settle();
    if (refresh) button(h.render(), '刷新 Agent 总体统计').props.onClick();
    const callback = button(h.render(), '刷新 Agent 总体统计').props.onClick;
    h.unmount();
    const before = h.writes();
    if (reject) pending.reject(new Error('PRIVATE_UNMOUNT_FAILURE')); else pending.resolve(diagnostic());
    await settle();
    assert.equal(h.writes(), before);
    callback(); await settle();
    assert.equal(h.writes(), before);
    assert.deepEqual(h.calls, refresh ? [false, true] : [false]);
    assert.deepEqual(h.collectorCalls, []);
    assert.deepEqual(h.notifications, []);
  }
});

for (const status of ['available', 'truncated', 'invalid', 'unavailable']) {
  test(`shared Hook cumulative-history cards and aggregates exceed detail limits independently of ${status} details and local filters`, async () => {
    const events = timedHooks(250).map((event, index) => ({ ...event, kind: index < 50 ? 'turn_failure' : 'tool_start',
      sessionId: index < 50 ? 'excluded-session' : 'retained-session' }));
    const report = freezeEvidence(diagnostic({ status: 'partial', totals: { sessions: 99999, inputTokens: 77777, outputTokens: 88888, unresolved: 55555, critical: 22222, high: 33333 },
      hooks: { ...hookCumulativeEvidence({ sessions: 9, events: 5000, turnFailures: 50 }), status, history: hookHistory(), events } }));
    const original = structuredClone(report);
    const home = await loadedHome(report);
    const live = await loaded(report);
    assert.deepEqual(hookKpiValues(home.render(), { home: true, history: true }), historyKpis);
    for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
      const tree = selectTab(live, label);
      assert.deepEqual(hookKpiValues(tree, { history: true }), historyKpis);
      assertNoDemo(renderToStaticMarkup(tree));
    }
    const overview = selectTab(live, '总体统计');
    const usable = status === 'available' || status === 'truncated';
    assertHomeCardsOnly(home.render());
    if (usable) {
      assert.equal(text(elements(chart(overview, '事件构成'), node => node.props.className === 'ad-donut-total')[0]), '200');
      assert.doesNotMatch(text(chart(overview, '会话活动排行')), /excluded-session/);
    } else {
      assert.equal(elements(overview, node => node.props.className?.split(' ').includes('ad-activity-chart')).length, 0);
      assert.match(text(overview), /累计统计图不可用，不能将最新明细当作全量历史/);
    }
    if (usable) {
      selectTab(live, '会话与明细');
      assertActivityPage(live.render(), 'Hook 事件', 1, 20, 1, 10, 200);
      change(live, '筛选 Hook 类型', 'turn_failure');
      assert.deepEqual(hookIds(live.render()), []);
      assert.deepEqual(hookKpiValues(live.render(), { history: true }), historyKpis);
    }
    assert.deepEqual(home.calls, [false]);
    assert.deepEqual(home.collectorCalls, []);
    assert.deepEqual(live.calls, [false]);
    assert.deepEqual(report, original);
    home.unmount(); live.unmount();
  });
}

test('shared Hook cumulative-history unknown and zero totals never fall back to nonzero bounded groups or details', async () => {
  for (const status of ['available', 'truncated', 'invalid', 'unavailable']) {
    const totals = { ...hookHistory().totals, sessions: 0, events: null, prompts: 0, toolStarts: null, turnFailures: 0, openTools: null };
    const report = freezeEvidence(diagnostic({ hooks: { ...hookCumulativeEvidence({ sessions: 9, events: 5000, prompts: 100, toolStarts: 200, turnFailures: 50, openTools: 60 }),
      history: hookHistory({ status, reason: '累计历史尚未初始化', range: { start: null, end: null }, totals }), events: timedHooks(250) } }));
    const home = await loadedHome(report);
    const live = await loaded(report);
    assert.deepEqual(hookKpiValues(home.render(), { home: true, history: true }), ['0', '—', '0', '—', '0', '—']);
    assert.deepEqual(hookKpiValues(live.render(), { history: true }), ['0', '—', '0', '—', '0', '—']);
    assertHomeCardsOnly(home.render());
    assert.equal(elements(live.render(), node => node.props.className?.split(' ').includes('ad-activity-chart')).length, 0);
    assert.match(text(live.render()), /累计统计图不可用，不能将最新明细当作全量历史/);
    for (const tree of [home.render(), live.render()]) {
      assert.match(text(tree), /Hook 独立持久累计，不受明细限制或轮转影响；启用前已删除记录无法恢复。/);
      assert.equal(text(tree).includes('累计历史尚未初始化'), status !== 'available');
      assert.doesNotMatch(renderToStaticMarkup(tree), /AgentSight 保持自身历史保留规则|NaN|Infinity/);
    }
    home.unmount(); live.unmount();
  }
});

test('shared unavailable Hook cumulative history discloses its reason or a short unknown fallback without AgentSight totals', async () => {
  for (const status of ['unavailable', 'invalid', 'truncated']) {
    for (const reason of ['累计历史文件不可读取', '<script>历史不可读取</script>', '', '   ', undefined]) {
      const history = hookHistory({ status, reason, totals: Object.fromEntries(Object.keys(hookHistory().totals).map(key => [key, null])) });
      const report = freezeEvidence(diagnostic({ history: storedHistory(), hooks: { ...hookCumulativeEvidence(), history, events: timedHooks(250) } }));
      const home = await loadedHome(report);
      const live = await loaded(report);
      for (const tree of [home.render(), live.render()]) {
        assert.deepEqual(hookKpiValues(tree, { home: tree.props['aria-label'] === 'Agent 总体统计' }), Array(6).fill('—'));
        const note = elements(tree, node => node.type === 'p' && node.props.className === 'ad-live-note' && text(node).startsWith('Hook 累计历史'))[0];
        assert(text(note).includes(`汇总不可用或不完整，— 表示未知（${reason?.trim() || '原因未知'}）`));
        assert.doesNotMatch(renderToStaticMarkup(note), /<script>/);
      }
      home.unmount(); live.unmount();
    }
  }
  const report = freezeEvidence(diagnostic({ history: storedHistory(), hooks: { ...hookCumulativeEvidence({ events: 5000 }), history: undefined, events: timedHooks(250) } }));
  const home = await loadedHome(report);
  const live = await loaded(report);
  for (const tree of [home.render(), live.render()]) {
    assert.deepEqual(hookKpiValues(tree, { home: tree.props['aria-label'] === 'Agent 总体统计' }), Array(6).fill('—'));
    assert.match(text(tree), /汇总不可用或不完整，— 表示未知（原因未知）/);
  }
  home.unmount(); live.unmount();
});

function storedHistory(overrides = {}) {
  return { scope: 'all_stored', sampledAt: '2026-11-11T12:00:00Z', status: 'ok',
    coverage: ['usage', 'sessions', 'interruptionCounts'].map(key => ({ key, status: 'available', reason: 'PRIVATE_STORED_REASON' })),
    totals: { sessions: 24680, calls: 98765, inputTokens: 123456, outputTokens: 654321, unresolved: 7654, critical: 321, high: 987 },
    ...overrides };
}
function assertNoAgentSightStatistics(tree) {
  assert.equal(elements(tree, node => node.props['aria-label'] === 'AgentSight 已保留历史用量' || node.props['aria-label'] === 'AgentSight 累计用量' || node.props.className?.split(' ').includes('ad-sight-kpis')).length, 0);
  assert.doesNotMatch(text(tree), /AgentSight · 已保留历史|AgentSight · 累计历史|AgentSight 保持自身历史保留规则/);
}

test('shared statistics show only six Hook cumulative cards regardless of AgentSight all_stored history, window usage or failed detail coverage', async () => {
  for (const history of [storedHistory(), storedHistory({ status: 'partial', totals: { sessions: 0, calls: null, inputTokens: 0, outputTokens: null, unresolved: 0, critical: null, high: null } }),
    storedHistory({ status: 'unavailable', coverage: ['usage', 'sessions', 'interruptionCounts'].map(key => ({ key, status: 'unavailable', reason: 'PRIVATE_STORED_REASON' })),
      totals: { sessions: null, calls: null, inputTokens: null, outputTokens: null, unresolved: null, critical: null, high: null } }), undefined]) {
    const report = freezeEvidence(diagnostic({ status: 'partial', history,
      coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status: 'unavailable', reason: 'PRIVATE_DETAIL_FAILURE' })),
      totals: { sessions: 99999, inputTokens: 88888, outputTokens: 77777, unresolved: 55555, critical: 22222, high: 33333 },
      hooks: { ...hookCumulativeEvidence({ events: 5000 }), history: hookHistory(), events: timedHooks(250) } }));
    const home = await loadedHome(report);
    const live = await loaded(report);
    for (const tree of [home.render(), live.render(), selectTab(live, '会话'), selectTab(live, '中断')]) {
      assertNoAgentSightStatistics(tree);
      assert.deepEqual(hookKpiValues(tree, { history: true, home: tree.props['aria-label'] === 'Agent 总体统计' }), historyKpis);
      assert.doesNotMatch(renderToStaticMarkup(tree), /PRIVATE_STORED_REASON|PRIVATE_DETAIL_FAILURE/);
    }
    assert.deepEqual(home.calls, [false]);
    assert.deepEqual(home.collectorCalls, []);
    assert.deepEqual(live.calls, [false]);
    home.unmount(); live.unmount();
  }
});

test('homepage wiring explicitly selects live statistics between scoring hero and systems and keeps Demo cards independent', () => {
  const pagePath = path.resolve(__dirname, '../src/HealthGuardPage.tsx');
  const pageSource = fs.readFileSync(pagePath, 'utf8');
  const page = ts.createSourceFile(pagePath, pageSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const nodes = [];
  function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
  visit(page);
  const jsx = nodes.filter(node => ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node));
  const hero = jsx.find(node => node.tagName.getText(page) === 'section' && /className="sh-hero"/.test(node.getText(page)));
  const summary = jsx.find(node => node.tagName.getText(page) === 'HomeAgentStatistics');
  const systems = jsx.find(node => node.tagName.getText(page) === 'section' && /aria-label="系统资源"/.test(node.getText(page)));
  assert(hero && summary && systems);
  assert(hero.pos < summary.pos && summary.pos < systems.pos, 'scoring hero < actual live Agent summary < systems');
  const conditional = nodes.find(node => ts.isConditionalExpression(node) && node.whenTrue === summary);
  assert(conditional && conditional.condition.getText(page) === 'agentLive');
  assert(ts.isJsxSelfClosingElement(conditional.whenFalse));
  assert.equal(conditional.whenFalse.tagName.getText(page), 'AgentOverviewCards');
  assert.match(summary.getText(page), /onOpen=\{\(\) => onNavigate\('agents'\)\}/);
  assert.match(pageSource, /agentLive:\s*boolean;/);
  const app = fs.readFileSync(path.resolve(__dirname, '../src/App.tsx'), 'utf8');
  assert.match(app, /<HealthGuardPage\b[^>]*agentLive=\{!offlineDemo\}/);
  const liveSource = fs.readFileSync(path.resolve(__dirname, '../src/AgentDiagnostics.tsx'), 'utf8');
  assert.match(liveSource, /import\s*\{[^}]*agentStatisticsCards[^}]*agentStatisticsCharts[^}]*\}\s*from ['"]\.\/AgentActivityCharts['"]/);
  assert.match(liveSource, /agentStatisticsCards\(report\)/);
  assert.match(liveSource, /agentStatisticsCharts\(report,/);
  const homeSource = fs.readFileSync(path.resolve(__dirname, '../src/AgentOverviewCards.tsx'), 'utf8');
  assert.match(homeSource, /import\s*\{\s*agentStatisticsCards\s*\}\s*from ['"]\.\/AgentActivityCharts['"]/);
  assert.match(homeSource, /agentStatisticsCards\(report\)/);
  assert.doesNotMatch(homeSource, /agentStatisticsCharts/);
  const implementation = homeSource.slice(homeSource.indexOf('export function HomeAgentStatistics'), homeSource.indexOf('const agentColors'));
  assert.doesNotMatch(implementation, /agentSummary|formatNumber|\bfetch\s*\(|XMLHttpRequest|sessionStorage|localStorage|cleanup|restart|setCollectorEnabled|healthOperation|prepareProcessCleanup|executeProcessCleanup/);
  assert.match(homeSource, /import\s*\{\s*fetchAgentDiagnostic\s*\}\s*from ['"]\.\/idc-client['"]/);
});

test('top Hook six-card shell remains above all tabs while the initial report is loading', async () => {
  const waiting = deferred();
  const h = harness(() => waiting.promise);
  assert.deepEqual(hookKpiValues(h.render()), Array(6).fill('—'));
  h.mount();
  for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
    const tree = selectTab(h, label);
    assert.equal(tree.props['aria-busy'], true);
    assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
    assert.match(text(tree), /正在获取诊断结果/);
  }
  assert.deepEqual(h.calls, [false]);
  waiting.resolve(diagnostic({ hooks: { ...hookCumulativeEvidence(), history: hookHistory({
    range: { start: null, end: null }, totals: Object.fromEntries(Object.keys(hookHistory().totals).map(key => [key, 0])),
  }) } }));
  await settle();
  assert.equal(h.render().props['aria-busy'], false);
  assert.deepEqual(hookKpiValues(h.render()), Array(6).fill('0'));
  h.unmount();
});

for (const status of ['available', 'truncated']) {
  for (const detailCount of [0, 250]) {
    test(`top ${status} Hook KPIs stay unknown without cumulative history despite 16 bounded Agent summaries and ${detailCount} recent details`, async () => {
      const report = freezeEvidence(diagnostic({
        totals: { sessions: 999, inputTokens: 12345, outputTokens: 67890, unresolved: 777, critical: 500, high: 277 },
        hooks: { status, reason: 'Backend 5,000-event bound', skippedLines: status === 'truncated' ? 2 : 0,
          agents: [...Array.from({ length: 16 }, (_, index) => hookAgentSummary({ agent: `summary-${index}`,
            sessions: 2, events: 250, prompts: 31, toolStarts: 40, turnFailures: 3, openTools: 7 })),
          hookAgentSummary({ agent: 'outside-16-agent-bound', sessions: 99999, events: 99999, prompts: 99999,
            toolStarts: 99999, turnFailures: 99999, openTools: 99999 })],
          events: timedHooks(detailCount, { kind: 'tool_end' }),
        },
      }));
      const h = await loaded(report);
      const unchanged = assertLocalOnly(h, report);
      const expected = Array(6).fill('—');
      for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
        const tree = selectTab(h, label);
        assert.deepEqual(hookKpiValues(tree), expected, 'bounded groups, latest 200 details and AgentSight totals never supply cumulative Hook KPIs');
        const heading = elements(tree, node => node.props.className === 'ad-hook-kpis')[0];
        assert.doesNotMatch(text(heading), /99999|12,345|67,890|777/);
        unchanged();
      }
      selectTab(h, '会话与明细');
      pageButton(h.render(), 'Hook Agent 汇总', '末页').props.onClick();
      assertActivityPage(h.render(), 'Hook Agent 汇总', 4, 4, 16, 16, 16);
      assert.deepEqual(hookKpiValues(h.render()), expected);
      assert.doesNotMatch(text(region(h.render(), 'Hook Agent 汇总')), /outside-16-agent-bound/);
      if (detailCount) {
        pageButton(h.render(), 'Hook 事件', '末页').props.onClick();
        assertActivityPage(h.render(), 'Hook 事件', 20, 20, 191, 200, 200);
        assert.deepEqual(hookKpiValues(change(h, '筛选 Hook 类型', 'turn_failure')), expected);
        assert.deepEqual(hookIds(h.render()), [], 'bounded failure summary remains separate from unknown cumulative KPIs');
      } else assert.deepEqual(hookIds(h.render()), []);
      unchanged();
      h.unmount();
    });
  }
}

test('top Hook KPIs retain all six values through failed refresh and update only when Hook summary changes', async () => {
  const old = freezeEvidence(diagnostic({
    sessions: [sessionEvidence({ inputTokens: 125, outputTokens: 64 })],
    hooks: { ...hookCumulativeEvidence({ sessions: 2, events: 4000, prompts: 30, toolStarts: 40, turnFailures: 5, openTools: 6 }),
      history: hookHistory({ totals: { ...hookHistory().totals, sessions: 2, events: 40000, prompts: 30, toolStarts: 40, turnFailures: 5, openTools: 6 } }), events: timedHooks(23) },
  }));
  const sightOnly = freezeEvidence({ ...old,
    totals: { sessions: 999, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
    sessions: [sessionEvidence({ inputTokens: 1000, outputTokens: 200 })],
  });
  const hookChanged = freezeEvidence({ ...sightOnly, hooks: {
    ...hookCumulativeEvidence({ sessions: 3, events: 5000, prompts: 31, toolStarts: 41, turnFailures: 0, openTools: 0 }),
    status: 'truncated', history: hookHistory({ totals: { ...hookHistory().totals, sessions: 3, events: 50000, prompts: 31, toolStarts: 41, turnFailures: 0, openTools: 0 } }),
    events: [hookEvent({ kind: 'tool_end' })],
  } });
  const waiting = deferred();
  let refreshes = 0;
  const h = harness(refresh => !refresh ? Promise.resolve(old)
    : ++refreshes === 1 ? waiting.promise : Promise.resolve(refreshes === 2 ? sightOnly : hookChanged));
  h.render(); h.mount(); await settle();
  selectTab(h, '会话与明细');
  change(h, '筛选 Hook 类型', 'tool_start');
  pageButton(h.render(), 'Hook 事件', '末页').props.onClick();
  const pending = button(h.render(), '刷新诊断').props.onClick();
  const before = ['2', '40,000', '30', '40', '5', '6'];
  for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
    const tree = selectTab(h, label);
    assert.equal(tree.props['aria-busy'], true);
    assert.deepEqual(hookKpiValues(tree), before);
  }
  selectTab(h, '会话与明细');
  waiting.reject(new Error('PRIVATE_TOP_KPI_REFRESH_ERROR'));
  await pending;
  assert.deepEqual(hookKpiValues(h.render()), before);
  assertActivityPage(h.render(), 'Hook 事件', 3, 3, 21, 23, 23);
  assert.match(text(h.render()), /旧结果 · 刷新失败/);
  assert.deepEqual(h.notifications, []);
  await button(h.render(), '刷新诊断').props.onClick();
  assert.deepEqual(hookKpiValues(h.render()), before, 'AgentSight-only refresh cannot update Hook values');
  assertActivityPage(h.render(), 'Hook 事件', 1, 3, 1, 10, 23);
  const session = region(selectTab(h, '会话'), '已采集会话列表');
  assert.deepEqual(elements(tableRows(session)[0], node => node.type === 'td').map(text).slice(5, 7), ['1,000', '200']);
  await button(h.render(), '刷新诊断').props.onClick();
  for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
    assert.deepEqual(hookKpiValues(selectTab(h, label)), ['3', '50,000', '31', '41', '0', '0']);
  }
  selectTab(h, '会话与明细');
  assert.equal(control(h.render(), '筛选 Hook 类型').props.value, 'tool_start');
  assert.deepEqual(hookIds(h.render()), [], 'retained filter may match no recent details without erasing the new summary');
  assertActivityPage(h.render(), 'Hook 事件', 1, 1, 0, 0, 0);
  assert.doesNotMatch(renderToStaticMarkup(h.render()), /PRIVATE_TOP_KPI_REFRESH_ERROR|旧结果/);
  assert.deepEqual(h.calls, [false, true, true, true]);
  assert.deepEqual(h.notifications, ['诊断已更新。', '诊断已更新。']);
  h.unmount();
});

const residualHookEvidence = {
  agents: [hookAgentSummary({ sessions: 9, events: 5000, prompts: 80, toolStarts: 90, turnFailures: 7, openTools: 8 })],
  events: [hookEvent({ kind: 'prompt_submit' }), hookEvent({ id: 'residual-start', kind: 'tool_start' }), hookEvent({ id: 'residual-failure', kind: 'turn_failure' })],
};
for (const [name, hooks] of [
  ['missing Hook report', undefined],
  ['null Hook report', null],
  ['unavailable despite residual evidence', { status: 'unavailable', reason: '', skippedLines: null, ...residualHookEvidence }],
  ['invalid despite residual evidence', { status: 'invalid', reason: '', skippedLines: 3, ...residualHookEvidence }],
  ['available without summary but with details', { status: 'available', reason: '', skippedLines: 0, agents: [], events: residualHookEvidence.events }],
  ['truncated without summary but with details', { status: 'truncated', reason: '', skippedLines: 1, agents: [], events: residualHookEvidence.events }],
]) {
  test(`top Hook KPIs stay unknown for ${name}, independently of real AgentSight usage`, async () => {
    const report = freezeEvidence(diagnostic({ hooks,
      totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
      sessions: [sessionEvidence({ inputTokens: 125, outputTokens: 64 })],
      interruptions: [interruption({ sessionId: 'actual-session' })],
    }));
    const h = await loaded(report);
    const unchanged = assertLocalOnly(h, report);
    for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
      assert.deepEqual(hookKpiValues(selectTab(h, label)), Array(6).fill('—'), 'missing summary never becomes recent-detail counts, AgentSight totals or zero');
    }
    const session = region(selectTab(h, '会话'), '已采集会话列表');
    assert.deepEqual(elements(tableRows(session)[0], node => node.type === 'td').map(text).slice(5, 7), ['125', '64']);
    assert.match(text(selectTab(h, '中断')), /近 24h 未处理 73 · 匹配 1 \/ 已取得明细 1/);
    unchanged();
    h.unmount();
  });
}

for (const status of ['available', 'truncated']) {
  test(`top ${status} Hook cumulative history preserves six genuine zeros despite nonzero recent details`, async () => {
    const h = await loaded(diagnostic({ hooks: { status, reason: '', skippedLines: 0,
      ...hookCumulativeEvidence(), status, events: residualHookEvidence.events } }));
    for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
      assert.deepEqual(hookKpiValues(selectTab(h, label)), Array(6).fill('0'));
    }
    selectTab(h, '会话与明细');
    assert.equal(hookIds(h.render()).length, 3);
    assert.deepEqual(hookKpiValues(change(h, '筛选 Hook 类型', 'turn_failure')), Array(6).fill('0'));
    assert.equal(hookIds(h.render()).length, 1);
    assert.deepEqual(h.calls, [false]);
    h.unmount();
  });
}

function control(tree, label) {
  const matches = elements(tree, node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === label);
  assert.equal(matches.length, 1, `Missing or duplicate control: ${label}`);
  return matches[0];
}
function change(h, label, value) {
  control(h.render(), label).props.onChange({ target: { value } });
  return h.render();
}
function processNames(tree) {
  return tableRows(region(tree, '已采集进程探活')).map(row => text(elements(row, node => node.type === 'strong')[0]));
}
function assertProcessPage(tree, page, pages, expected) {
  const pagination = elements(tree, node => node.props['aria-label'] === '进程探活分页')[0];
  assert(pagination);
  assert.match(text(pagination), new RegExp(`第 ${page} / ${pages} 页 · 每页 20 条`));
  assert.equal(button(pagination, '上一页').props.disabled, page === 1);
  assert.equal(button(pagination, '下一页').props.disabled, page === pages);
  assert.deepEqual(processNames(tree), expected.map(process => process.name));
}
function freezeEvidence(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}
function assertLocalOnly(h, report) {
  const original = structuredClone(report);
  const calls = [...h.calls];
  const collectorCalls = structuredClone(h.collectorCalls);
  const notifications = [...h.notifications];
  const stable = tree => [
    hookKpiValues(tree), text(collectionDetails(tree)),
    text(elements(tree, node => node.props['aria-label'] === '诊断结论')[0]),
    text(elements(tree, node => node.props['aria-label'] === '真实调用采集状态')[0]),
  ];
  const baseline = stable(h.render());
  return () => {
    assert.deepEqual(stable(h.render()), baseline, 'local controls never alter global KPI, conclusion, service state or data scope');
    assert.deepEqual(h.calls, calls, 'local controls do not fetch or refresh the report');
    assert.deepEqual(h.collectorCalls, collectorCalls, 'local controls do not reload service status');
    assert.deepEqual(h.notifications, notifications);
    assert.deepEqual(report, original, 'local controls must not mutate source evidence');
  };
}
function fortyFiveProcesses(overrides = {}) {
  const statuses = Object.keys(shared.agentProcessLabels);
  return Array.from({ length: 45 }, (_, index) => processEvidence({
    pid: 9100 + index, name: `Agent-${String(index + 1).padStart(2, '0')}-${index % 2 ? 'Beta' : 'Alpha'}`,
    role: ['worker', 'supervisor', 'cli'][index % 3], status: statuses[Math.floor(index / 3) % statuses.length],
    hasCrash: index % 4 === 0, ...overrides,
  }));
}

function assertNoDemo(html) {
  assert.doesNotMatch(html, /Cosh|qwen-plus|qwen3\.5|6731|7118|6716d2b5|140740|Demo 模拟|总输入 Token|重启进程|Resolve|Hide/);
}

test('only mounting Live loads cache once; Demo remains independent and live never reads demo summary', async () => {
  const demo = harness(undefined, { demo: true });
  assert.match(renderToStaticMarkup(demo.renderDemo()), /Demo 数据/);
  assert.deepEqual(demo.calls, []);
  const waiting = deferred();
  const h = harness(() => waiting.promise);
  const firstTree = h.render();
  assert.deepEqual(h.calls, []);
  assertCompactShell(firstTree);
  assert.deepEqual(hookKpiValues(firstTree), Array(6).fill('—'));
  assert.equal(tab(firstTree, '总体统计').props['aria-selected'], true);
  assertNoDemo(renderToStaticMarkup(firstTree));
  h.mount();
  assert.deepEqual(h.calls, [false]);
  await button(firstTree, '开始诊断').props.onClick();
  assert.deepEqual(h.calls, [false], 'a stale button cannot race the mount fetch');
  assert.equal(button(h.render(), '正在更新诊断').props.disabled, true);
  h.render({ onNotify() {} });
  h.mount();
  assert.deepEqual(h.calls, [false], 'parent rerenders do not refetch');
  waiting.resolve(diagnostic());
  await settle();
  assert.match(text(collectionDetails(h.render())), /更新时间2026\/11\/11 20:00:00/);
  assert.doesNotMatch(text(h.render()), /actual report summary/);
  assert.equal(h.notifications.length, 0, 'cached mount is not a manual diagnostic notification');
  assertNoDemo(renderToStaticMarkup(h.render()));
});

test('effect replay shares the component request lock and uses the returned real report', async () => {
  const waiting = deferred();
  const h = harness(() => waiting.promise);
  h.render(); h.mount(); h.replayEffects();
  assert.deepEqual(h.calls, [false]);
  waiting.resolve(diagnostic({ sampledAt: '2026-11-11T05:00:00.000Z', totals: { sessions: 8, inputTokens: 0, outputTokens: 0, unresolved: 0, critical: 0, high: 0 },
    hooks: hookCumulativeEvidence({ sessions: 2, events: 80, prompts: 3, toolStarts: 4, turnFailures: 5, openTools: 6 }),
    sessions: [sessionEvidence()],
  }));
  await settle();
  assert.match(text(collectionDetails(h.render())), /2026\/11\/11 13:00:00/);
  assert.deepEqual(hookKpiValues(h.render()), ['2', '80', '3', '4', '5', '6']);
  assert.match(text(selectTab(h, '中断')), /近 24h 未处理 0 · 匹配 0 \/ 已取得明细 0/);
  assert.deepEqual(elements(tableRows(region(selectTab(h, '会话'), '已采集会话列表'))[0], node => node.type === 'td').map(text).slice(4, 7), ['0', '0', '0']);
  assert.equal(button(h.render(), '刷新诊断').props.disabled, false);
});

test('execution and outcome stay separate; front-loaded conclusion is evidence-scoped and data scope shows only time and five Chinese source states', async () => {
  for (const status of ['ok', 'partial', 'unavailable']) {
    for (const outcome of ['observed', 'abnormal', 'unknown']) {
      const h = await loaded(diagnostic({ status, outcome, lastScanAt: 'actual scan timestamp' }));
      const tree = h.render();
      const details = collectionDetails(tree);
      const output = text(details);
      assertCompactShell(tree);
      const strip = elements(tree, node => node.props['aria-label'] === '真实调用采集状态')[0];
      assert(text(strip).includes({ ok: '采集完成', partial: '部分采集', unavailable: '采集不可用' }[status]));
      const conclusion = elements(tree, node => node.props['aria-label'] === '诊断结论')[0];
      assert(conclusion);
      assert.equal(text(elements(conclusion, node => node.type === 'strong')[0]), outcome === 'abnormal' ? '发现需关注事件' : status === 'ok' && outcome === 'observed' ? '本次证据未发现异常' : '证据不足，暂无法判断');
      if (status === 'ok' && outcome === 'observed') assert.match(text(conclusion), /仅依据本次已采集记录，不代表业务整体正常/);
      const ordered = elements(tree, () => true);
      assert(ordered.indexOf(conclusion) < ordered.findIndex(node => node.props.role === 'tablist'), 'conclusion precedes navigation and evidence');
      assert.deepEqual(elements(details, node => node.type === 'dt').map(text), ['统计时间', '更新时间']);
      assert.match(output, /统计时间2026\/11\/10 20:00:00 — 2026\/11\/11 20:00:00更新时间2026\/11\/11 20:00:00/);
      assert.doesNotMatch(text(outsideDetails(tree)), /2026\/11\/10 20:00:00/);
      const coverage = elements(details, node => node.props.className === 'ad-live-coverage')[0];
      assert.equal(elements(coverage, node => node.type === 'li').length, 5);
      for (const label of Object.values(shared.agentSourceLabels)) assert(output.includes(`${label}：可用`));
      assert.doesNotMatch(text(tree), /actual-|sysom-openapi|agentsight|sampledAt|lastScanAt|执行状态|观测结果|\(observed\)|\(abnormal\)|\(unknown\)|诊断请求失败|业务健康正常/);
      assertNoDemo(renderToStaticMarkup(h.render()));
    }
  }
});

test('zero metrics stay zero and null totals, timestamps and complete-call latency remain missing', async () => {
  const h = await loaded(diagnostic({
    totals: { sessions: 0, inputTokens: null, outputTokens: 0, unresolved: 42, critical: 0, high: null },
    processes: [processEvidence({ latencyMs: 0 })],
    sessions: [sessionEvidence(), sessionEvidence({ id: 'unknown-tokens', conversations: null, inputTokens: null, outputTokens: null })],
    latency: [{ agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: 0, e2eP95Ms: null, tpsP50: 0, tpotP95Ms: null }],
  }));
  let tree = h.render();
  assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'), 'AgentSight zero/unknown totals cannot populate absent Hook summary');
  assert.doesNotMatch(text(collectionDetails(tree)), /lastScanAt|已过滤进程/);
  assert.match(text(tree), /匹配 1 \/ 已采集 1 条/);
  const process = tableRows(tree).find(row => text(row).includes('actual-cli'));
  assert(process, 'overview contains actual process evidence in a table');
  assert(elements(process, node => node.type === 'td').some(cell => /(?:^|\s)0 ms$/.test(text(cell))));
  tree = selectTab(h, '会话');
  const sessionCells = elements(tableRows(region(tree, '已采集会话列表'))[0], node => node.type === 'td').map(text);
  assert.deepEqual(sessionCells.slice(1, 8), ['actual-session', 'actual-agent', 'actual-model', '0', '0', '0', '—']);
  assert.deepEqual(elements(tableRows(region(tree, '已采集会话列表'))[1], node => node.type === 'td').map(text).slice(4, 7), ['—', '—', '—'], 'unreported AgentSight usage remains unknown, never zero');
  button(tree, '展开会话 actual-session').props.onClick();
  assert.match(text(elements(h.render(), node => node.props.className === 'ad-interruption-panel')[0]), /首次出现 — · 最后活跃 —/);
  tree = selectTab(h, '延迟');
  const latency = region(tree, '完整 LLM 调用延迟');
  assert.match(text(latency), /TTFT p95E2E p95TPS p50TPOT p95/);
  const cells = elements(latency, node => node.type === 'td').map(text);
  assert.deepEqual(cells, ['未关联', '0', '0', '0 ms', '— · 未采集', '0 Token/s', '— · 未采集']);
  assert.match(text(tree), /仅统计完整调用.*首 Token 与单 Token 耗时仅针对流式调用/);
  assert.doesNotMatch(text(latency), /故障阈值|业务健康正常/);
  tree = selectTab(h, '中断');
  assert.match(text(tree), /近 24h 未处理 42 · 匹配 0 \/ 已取得明细 0/);
  assert.match(text(tree), /没有已采集的中断明细，不代表全窗口无中断/);
  assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
  const allNull = await loaded(diagnostic());
  assert.deepEqual(hookKpiValues(allNull.render()), Array(6).fill('—'));
});

test('latency stays grouped by agent and an available empty array does not fabricate a measurement row', async () => {
  const report = diagnostic({ latency: [
    { agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: null, tpsP50: null, tpotP95Ms: null },
    { agent: 'actual-agent-a', calls: 2, streamingCalls: 1, ttftP95Ms: 0, e2eP95Ms: 12, tpsP50: 0, tpotP95Ms: null },
    { agent: 'actual-agent-b', calls: 3, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: 0, tpsP50: null, tpotP95Ms: null },
  ] });
  const original = structuredClone(report);
  const h = await loaded(report);
  const latency = region(selectTab(h, '延迟'), '完整 LLM 调用延迟');
  const rows = elements(latency, node => node.type === 'tr' && elements(node, cell => cell.type === 'td').length > 0);
  assert.deepEqual(rows.map(row => elements(row, node => node.type === 'td').map(text)), [
    ['未关联', '0', '0', '— · 未采集', '— · 未采集', '— · 未采集', '— · 未采集'],
    ['actual-agent-a', '2', '1', '0 ms', '12 ms', '0 Token/s', '— · 未采集'],
    ['actual-agent-b', '3', '0', '— · 未采集', '0 ms', '— · 未采集', '— · 未采集'],
  ]);
  assert.deepEqual(report, original);
  assert.deepEqual(h.calls, [false]);
  assertNoDemo(renderToStaticMarkup(h.render()));
  const empty = await loaded(diagnostic({ outcome: 'unknown' }));
  const tree = selectTab(empty, '延迟');
  const coverage = elements(tree, node => node.props.className === 'ad-live-coverage')[0];
  const latencySource = elements(coverage, node => node.type === 'li').find(node => text(node).includes(shared.agentSourceLabels.latency));
  assert(latencySource);
  assert.match(text(latencySource), /可用/);
  assert.match(text(tree), /未采集到完整调用的延迟指标/);
  assert.equal(elements(tree, node => node.props.role === 'region' && node.props['aria-label'] === '完整 LLM 调用延迟').length, 0);
  assert.match(text(elements(tree, node => node.props['aria-label'] === '诊断结论')[0]), /证据不足，暂无法判断/);
});

test('latency chart exposes the confirmed accessible metric labels and value keys', async () => {
  const h = await loaded(diagnostic());
  const tree = selectTab(h, '延迟');
  const select = elements(tree, node => node.type === 'select' && node.props['aria-label'] === '对比指标')[0];
  assert(select);
  assert.deepEqual(elements(select, node => node.type === 'option').map(option => [option.props.value, text(option)]), [
    ['e2eP95Ms', '总耗时 P95'], ['ttftP95Ms', '首 Token P95'], ['tpsP50', '生成速度 P50'],
  ]);
});

test('latency chart switches real per-agent measurements locally, preserves null versus zero and scales numeric widths', async () => {
  const report = diagnostic({ latency: [
    { agent: null, calls: 0, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: null, tpsP50: null, tpotP95Ms: null },
    { agent: 'actual-agent-a', calls: 2, streamingCalls: 1, ttftP95Ms: 0, e2eP95Ms: 40, tpsP50: 8, tpotP95Ms: null },
    { agent: 'actual-agent-b', calls: 3, streamingCalls: 0, ttftP95Ms: 20, e2eP95Ms: 10, tpsP50: 0, tpotP95Ms: 0 },
    { agent: 'actual-agent-c', calls: 1, streamingCalls: 1, ttftP95Ms: 5, e2eP95Ms: 0, tpsP50: null, tpotP95Ms: 2 },
  ] });
  const original = structuredClone(report);
  const h = await loaded(report);
  const baselineCollectorCalls = h.collectorCalls.length;
  let tree = selectTab(h, '延迟');
  const select = () => elements(h.render(), node => node.type === 'select' && node.props['aria-label'] === '对比指标')[0];
  assert(select(), 'chart has an accessible metric select');
  assert.equal(select().props.value, 'e2eP95Ms');
  assert.deepEqual(elements(select(), node => node.type === 'option').map(option => option.props.value), ['e2eP95Ms', 'ttftP95Ms', 'tpsP50']);
  const originalTable = elements(region(tree, '完整 LLM 调用延迟'), node => node.type === 'td').map(text);
  const expected = [
    ['e2eP95Ms', ['— · 未采集', '40 ms', '10 ms', '0 ms'], [0, 100, 25, 0]],
    ['ttftP95Ms', ['— · 未采集', '0 ms', '20 ms', '5 ms'], [0, 0, 100, 25]],
    ['tpsP50', ['— · 未采集', '8 Token/s', '0 Token/s', '— · 未采集'], [0, 100, 0, 0]],
  ];
  for (const [metric, measurements, widths] of expected) {
    select().props.onChange({ target: { value: metric } });
    tree = h.render();
    assert.equal(select().props.value, metric);
    const chart = elements(tree, node => node.props.className?.split(' ').includes('ad-latency-chart'))[0];
    assert(chart);
    const rows = elements(chart, node => node.props.className === 'ad-bar-row');
    assert.equal(rows.length, report.latency.length, 'one independent row per reported Agent, including unassociated evidence');
    assert.deepEqual(rows.map(row => text(elements(row, node => node.type === 'strong')[0])), ['未关联', 'actual-agent-a', 'actual-agent-b', 'actual-agent-c']);
    for (const [index, row] of rows.entries()) {
      assert(text(row).endsWith(measurements[index]));
      const bars = elements(row, node => node.props.style && Object.hasOwn(node.props.style, 'width'));
      if (report.latency[index][metric] === null && bars.length === 0) continue;
      assert.equal(bars.length, 1);
      assert.match(bars[0].props.style.width, /^\d+(?:\.\d+)?%$/);
      assert.equal(Number.parseFloat(bars[0].props.style.width), widths[index], 'width derives only from the selected measurement');
    }
    assert.deepEqual(elements(region(tree, '完整 LLM 调用延迟'), node => node.type === 'td').map(text), originalTable, 'chart selection never modifies seven-column evidence');
    assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
  }
  tree = selectTab(h, '总体统计');
  assert.equal(select().props.value, 'tpsP50', 'local chart choice remains on returning to overview');
  assert.deepEqual(h.calls, [false]);
  assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(report, original);
  assertNoDemo(renderToStaticMarkup(tree));
  const zeros = await loaded(diagnostic({ latency: [{ agent: 'zero-agent', calls: 0, streamingCalls: 0, ttftP95Ms: 0, e2eP95Ms: 0, tpsP50: 0, tpotP95Ms: 0 }] }));
  const zeroChart = elements(selectTab(zeros, '延迟'), node => node.props.className?.split(' ').includes('ad-latency-chart'))[0];
  assert.match(text(zeroChart), /zero-agent0 ms/);
  assert.deepEqual(elements(zeroChart, node => node.props.style && Object.hasOwn(node.props.style, 'width')).map(node => node.props.style.width), ['0%'], 'all-zero data never divides by zero or invents a positive bar');
});

test('process evidence does not equate HTTP response with business health, CLI with failure, offline with crash or timeout with loops', async () => {
  const h = await loaded(diagnostic({ processes: Object.keys(shared.agentProcessLabels).map((status, index) => processEvidence({
    pid: 801 + index, name: `actual-${status}`, status, ports: status === 'no_port' ? [] : [8100],
    hasCrash: status === 'unhealthy', lastCheckAt: '2026-11-11T02:00:00.000Z',
  })) }));
  const tree = h.render();
  assert.equal(elements(tree, node => node.type === 'section' && node.props.className?.includes('ad-live-process')).length, 0, 'old process cards are not the compact live UI');
  const notes = {
    healthy: '仅表示 HTTP 有响应，不代表业务健康。',
    unhealthy: '端口不可达，未推断具体业务故障。',
    hung: '仅表示 HTTP 响应超时，不等同于死循环。',
    unknown: '暂无探活结果，不能判定业务健康。',
    no_port: '正常 CLI 可无监听端口，不据此判定故障。',
    offline: '进程已退出，不能仅据此判定崩溃。',
  };
  const rows = tableRows(tree).filter(row => text(row).includes('actual-'));
  assert.equal(rows.length, 6);
  for (const [index, status] of Object.keys(shared.agentProcessLabels).entries()) {
    const row = rows.find(item => text(item).includes(`actual-${status}`));
    assert(row);
    const tooltip = elements(row, node => typeof node.props.title === 'string' && node.props.title.includes(notes[status]))[0];
    assert(tooltip, `process ${status} has its liveProcessNotes tooltip`);
    assert(text(tooltip).includes(shared.agentProcessLabels[status]));
    assert(text(row).includes(String(801 + index)));
    assert.match(text(row), /未关联.*— · 未采集.*2026\/11\/11 10:00:00/);
    assert.equal(elements(row, node => node.type === 'button').length, 0);
    assert.doesNotMatch(text(row), /业务健康正常|死循环检测|进程崩溃|lastCheckAt|hasCrash/);
    assert(!text(row).includes(notes[status]), 'health interpretation stays in the tooltip, not repeated in every row');
    assert.equal(text(row).includes('有崩溃记录'), status === 'unhealthy', 'only reported true hasCrash is displayed');
  }
  assert.match(text(rows.find(row => text(row).includes('actual-no_port'))), /无/);
  assert.match(text(rows.find(row => text(row).includes('actual-unhealthy'))), /有崩溃记录/);
  assert.doesNotMatch(text(rows.find(row => text(row).includes('actual-offline'))), /有崩溃记录|false|未报告崩溃证据/);
});

test('truncated, invalid and unavailable sources retain distinct Chinese states without exposing reasons or inventing evidence', async () => {
  const h = await loaded(diagnostic({ status: 'unavailable', outcome: 'unknown',
    coverage: Object.keys(shared.agentSourceLabels).map((key, i) => ({ key, status: ['unavailable', 'truncated', 'invalid'][i % 3], reason: `limited-${key}` })),
  }));
  const tree = h.render();
  const output = text(tree);
  const disclosure = text(collectionDetails(tree));
  assert.match(disclosure, /进程探活：未取得数据/);
  assert.match(disclosure, /会话与 Token：明细不完整/);
  assert.match(disclosure, /中断明细：数据无法使用/);
  assert.doesNotMatch(output, /limited-|\(unavailable\)|\(truncated\)|\(invalid\)/);
  assert.match(output, /没有已采集的进程记录/);
  assert.match(text(selectTab(h, '会话')), /没有已采集的会话记录/);
  assert.match(text(selectTab(h, '中断')), /没有已采集的中断明细/);
  assert.match(text(selectTab(h, '延迟')), /未采集到完整调用的延迟指标/);
  assert.match(output, /证据不足，暂无法判断/);
  assert.match(disclosure, /缺失数据不代表正常/);
  assert.doesNotMatch(output, /诊断请求失败/);
  assertNoDemo(renderToStaticMarkup(tree));
  const missing = await loaded(diagnostic({ coverage: [] }));
  const list = elements(missing.render(), node => node.props.className === 'ad-live-coverage')[0];
  assert.equal(elements(list, node => node.type === 'li').length, 5);
  assert.equal(elements(list, node => node.type === 'li').filter(node => text(node).includes('数据范围未知')).length, 5);
});

test('available-but-empty sources remain distinct from unavailable sources and neither fabricates evidence', async () => {
  for (const available of [true, false]) {
    const report = diagnostic({ status: available ? 'ok' : 'unavailable', outcome: 'unknown',
      coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status: available ? 'available' : 'unavailable', reason: available ? `empty-success-${key}` : `not-running-${key}` })),
    });
    const h = await loaded(report);
    const baselineCollectorCalls = h.collectorCalls.length;
    const details = collectionDetails(h.render());
    const coverage = elements(details, node => node.props.className === 'ad-live-coverage')[0];
    for (const key of Object.keys(shared.agentSourceLabels)) {
      const item = elements(coverage, node => node.type === 'li').find(node => text(elements(node, child => child.type === 'strong')[0]) === shared.agentSourceLabels[key]);
      assert(item);
      assert.equal(text(elements(item, node => node.type === 'span')[0]), `${shared.agentSourceLabels[key]}：${available ? '可用' : '未取得数据'}`);
      assert.doesNotMatch(text(item), /empty-success|not-running/);
    }
    for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
      const tree = selectTab(h, label);
      assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
      assert.doesNotMatch(text(tree), /业务健康正常|本次未发现异常|诊断请求失败/);
      assertNoDemo(renderToStaticMarkup(tree));
    }
    assert.equal(elements(h.render(), node => node.props['aria-label'] === '完整 LLM 调用延迟').length, 0);
    assert.deepEqual(h.calls, [false]);
    assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  }
  for (const status of ['available', 'unavailable']) {
    const h = await loaded(diagnostic({ coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status, reason: '' })) }));
    const coverage = elements(collectionDetails(h.render()), node => node.props.className === 'ad-live-coverage')[0];
    assert.equal(elements(coverage, node => node.type === 'li').filter(node => text(node).includes(status === 'available' ? '：可用' : '：未取得数据')).length, 5);
    assert.doesNotMatch(text(coverage), /原因|available|unavailable/);
  }
});

test('sessions search Agent, ID and Model locally, sort by last activity, and expand only linked interruption metadata', async () => {
  const report = diagnostic({ totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
    hooks: hookCumulativeEvidence({ sessions: 7, events: 5000, prompts: 10, toolStarts: 20, turnFailures: 3, openTools: 4 }),
    sessions: [
      sessionEvidence({ id: 'older-id', agent: 'Older-Agent', model: 'older-model', lastSeenAt: '2026-11-10T13:00:00Z' }),
      sessionEvidence({ id: 'unknown-time', agent: null, model: null }),
      sessionEvidence({ id: 'newer-id', agent: 'Newer-Agent', model: 'newer-model', inputTokens: 125, outputTokens: 64, lastSeenAt: '2026-11-11T11:00:00Z' }),
    ],
    interruptions: [interruption({ id: 'linked-new', sessionId: 'newer-id' }), interruption({ id: 'linked-old', sessionId: 'older-id' }), interruption({ id: 'unlinked-event' })],
  });
  const h = await loaded(report);
  let tree = selectTab(h, '会话');
  const initialStats = hookKpiValues(tree);
  const initialCollectorCalls = h.collectorCalls.length;
  const ids = elements(region(tree, '已采集会话列表'), node => node.type === 'tr' && node.props.className !== undefined).map(row => text(row.props.children[1]));
  assert.deepEqual(ids, ['newer-id', 'older-id', 'unknown-time']);
  const search = () => elements(h.render(), node => node.type === 'input' && node.props.type === 'search')[0];
  for (const query of ['NEWER-AGENT', 'newer-id', 'newer-model']) {
    search().props.onChange({ target: { value: query } });
    tree = h.render();
    const list = region(tree, '已采集会话列表');
    assert.match(text(list), /newer-id/);
    assert.doesNotMatch(text(list), /older-id|unknown-time/);
    assert.match(text(tree), /当前列表匹配 1 \/ 3/);
    assert.deepEqual(elements(list, node => node.type === 'th').map(text).slice(5, 7), ['输入 TOKEN', '输出 TOKEN']);
    assert.deepEqual(elements(tableRows(list)[0], node => node.type === 'td').map(text).slice(5, 7), ['125', '64']);
    assert.deepEqual(hookKpiValues(tree), initialStats, 'filtering never recalculates aggregate totals');
    assert.deepEqual(hookKpiValues(tree), ['7', '5,000', '10', '20', '3', '4']);
  }
  search().props.onChange({ target: { value: '' } });
  button(h.render(), '展开会话 newer-id').props.onClick();
  tree = h.render();
  const panel = elements(tree, node => node.props.className === 'ad-interruption-panel')[0];
  assert.match(text(panel), /linked-new/);
  assert.doesNotMatch(text(panel), /linked-old|unlinked-event/);
  assert.equal(button(tree, '收起会话 newer-id').props['aria-expanded'], true);
  button(tree, '展开会话 unknown-time').props.onClick();
  assert.match(text(elements(h.render(), node => node.props.className === 'ad-interruption-panel')[0]), /无此会话关联事件，不代表全窗口无中断/);
  search().props.onChange({ target: { value: 'not-found' } });
  assert.match(text(h.render()), /没有匹配的会话/);
  assert.deepEqual(hookKpiValues(h.render()), initialStats);
  assert.deepEqual(h.calls, [false], 'search and expand never fetch session or conversation resources');
  assert.equal(h.collectorCalls.length, initialCollectorCalls, 'local search and expansion do not reload collector status');
  assert.deepEqual(report.sessions.map(item => item.id), ['older-id', 'unknown-time', 'newer-id'], 'sorting must not mutate report');
  assert.match(text(selectTab(h, '中断')), /近 24h 未处理 73 · 匹配 3 \/ 已取得明细 3/, 'AgentSight full-window interruption total stays independent of Hook');
});

test('incident tab groups five compact columns and keeps full linkage in read-only evidence', async () => {
  const h = await loaded(diagnostic({ interruptions: [
    interruption({ id: 'compact-linked-event', sessionId: 'unknown-session', agent: 'actual-agent', occurredAt: '2026-11-11T03:30:00.000Z', callId: 'modal-only-call', pid: 812 }),
    interruption({ id: 'compact-unlinked-event', type: 'user_cancel', severity: 'low' }),
  ] }));
  const list = region(selectTab(h, '中断'), '已采集中断元数据');
  const headers = elements(list, node => node.type === 'th').map(text);
  assert.equal(headers.length, 5);
  assert.deepEqual(headers, ['事件 / Agent', '严重度', '处理状态', '发生时间', '证据']);
  const rows = tableRows(list);
  assert.equal(rows.length, 2);
  assert(rows.every(row => elements(row, node => node.type === 'td').length === 5));
  const cells = rows.map(row => elements(row, node => node.type === 'td').map(text));
  assert.match(cells[0][0], /模型调用错误.*actual-agent.*compact-linked-event/);
  assert.deepEqual(cells[0].slice(1, 4), ['高危', '未处理', '2026/11/11 11:30:00']);
  assert.match(cells[1][0], /用户取消.*未关联/);
  assert.deepEqual(cells[1].slice(1, 4), ['低', '未处理', '—']);
  assert.doesNotMatch(text(list), /modal-only-call|812|unknown-session/, 'verbose evidence fields stay in the existing Modal');
  button(list, '查看中断证据 compact-linked-event').props.onClick();
  const modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert.match(text(modal), /unknown-session.*modal-only-call.*812/);
  button(list, '查看中断证据 compact-unlinked-event');
});

test('all interruption types use mappings or escaped raw text, including prototype keys; unlinked evidence Modal stays read-only', async () => {
  const unsafe = '<script>alert("event")</script>';
  const h = await loaded(diagnostic({
    summary: '<b>summary & evidence</b>',
    findings: [{ severity: 'warning', title: '<img src=x onerror=1>', detail: '<svg>detail</svg>', suggestion: '<script>suggestion</script>' }],
    processes: [processEvidence({ name: '<b>actual-name</b>' })],
    interruptions: [
      ...Object.keys(shared.agentInterruptionLabels).map((type, index) => interruption({ type, id: `mapped-${index}`, severity: ['critical', 'high', 'medium', 'low'][index % 4] })),
      interruption({ id: 'unsafe-event', type: unsafe, agent: '<img>agent', sessionId: null, callId: null, pid: 0 }),
      ...['__proto__', 'constructor', 'toString', 'future-type'].map(type => interruption({ id: `raw-${type}`, type })),
      interruption({ id: 'not-in-session-list', sessionId: 'unknown-session' }),
    ],
  }));
  const overviewHtml = renderToStaticMarkup(h.render());
  let tree = selectTab(h, '中断');
  const list = region(tree, '已采集中断元数据');
  for (const label of Object.values(shared.agentInterruptionLabels)) assert(text(list).includes(label));
  for (const raw of ['__proto__', 'constructor', 'toString', 'future-type', unsafe]) assert(text(list).includes(raw));
  for (const [index, label] of ['严重', '高危', '中', '低'].entries()) {
    const row = tableRows(list).find(item => elements(item, node => node.props['aria-label'] === `查看中断证据 mapped-${index}`).length);
    assert(row);
    const severityCell = elements(row, node => node.type === 'td')[1];
    assert.equal(text(severityCell), label);
    assert.doesNotMatch(text(severityCell), /critical|high|medium|low/);
  }
  button(tree, '查看中断证据 unsafe-event').props.onClick();
  tree = h.render();
  const modal = elements(tree, node => typeof node.type === 'function' && node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert(modal);
  assert.equal(modal.props.title, `${unsafe} · 高危`);
  const fields = elements(modal, node => node.type === 'dt').map(text);
  const values = elements(modal, node => node.type === 'dd').map(text);
  assert.deepEqual(fields, ['事件 ID', '类型', '严重度', '发生时间', 'Session ID', 'Call ID', 'PID', 'Agent', '处理状态']);
  assert.deepEqual(values, ['unsafe-event', `${unsafe} (${unsafe})`, '高危', '—', '未关联', '未关联', '0', '<img>agent', '未处理']);
  assert.equal(text(elements(modal, node => node.props.className === 'ad-modal-note')[0]), '仅展示本次报告已有证据，未确认故障根因。');
  assert.deepEqual(elements(modal, node => node.type === 'button').map(text), ['关闭']);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /&lt;script&gt;alert\(&quot;event&quot;\)&lt;\/script&gt;/);
  assert.doesNotMatch(html + overviewHtml, /summary &amp; evidence|img src=x onerror=1|svg&gt;detail|script&gt;suggestion/, 'summary and findings are not exposed even as escaped text');
  assert.match(overviewHtml, /&lt;b&gt;actual-name&lt;\/b&gt;/);
  assert.doesNotMatch(html + overviewHtml, /<script>|<img|<b>actual-name|<svg>detail/);
  assertNoDemo(html);
  assert.deepEqual(h.calls, [false]);
  button(modal, '关闭').props.onClick();
  assert.equal(elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读').length, 0);
  assert.doesNotMatch(text(collectionDetails(tree)), /对话|会话资源|部署|权限/);
  assert.match(text(modal), /仅展示本次报告已有证据，未确认故障根因/);
  assert.deepEqual(h.collectorCalls.length, 2, 'evidence viewing makes no conversation, session or service request');
});

test('default overview is compact; accessible tabs isolate session, incident and latency tables without requests', async () => {
  const report = diagnostic({
    processes: [processEvidence()], sessions: [sessionEvidence({ conversations: 7, inputTokens: 125, outputTokens: 64, lastSeenAt: '2026-11-11T04:00:00.000Z' })],
    interruptions: [interruption({ id: 'overview-event', agent: 'actual-agent', occurredAt: '2026-11-11T03:00:00.000Z' })],
    latency: [{ agent: 'actual-agent', calls: 3, streamingCalls: 2, ttftP95Ms: 12, e2eP95Ms: 24, tpsP50: 8, tpotP95Ms: 2 }],
  });
  const original = structuredClone(report);
  const h = await loaded(report);
  const baselineCollectorCalls = h.collectorCalls.length;
  let tree = h.render();
  assertCompactShell(tree);
  assert.equal(tab(tree, '总体统计').props['aria-selected'], true);
  assert.equal(elements(tree, node => node.type === 'input' && node.props['aria-label'] === '搜索进程名或 PID').length, 1);
  assert.equal(elements(tree, node => node.props['aria-label'] === '搜索会话 Agent / ID / Model').length, 0);
  assert.equal(elements(tree, node => node.props['aria-label'] === '已采集会话列表').length, 0);
  assert.equal(elements(tree, node => node.props['aria-label'] === '完整 LLM 调用延迟').length, 0);
  assert(tableRows(tree).some(row => text(row).includes('actual-cli')), 'overview contains a process table');
  const incident = button(tree, '查看事件证据 llm_error');
  assert.match(text(incident), /高危.*模型调用错误 · 1 条/);
  assert.doesNotMatch(text(incident), /overview-event|actual-agent|2026\/11\/11 11:00:00/);
  assert.equal(elements(incident, node => node.type === 'p').length, 0, 'overview incidents stay compact');
  assert(elements(tree, node => node.props.role === 'img' || node.type === 'svg' || node.props.className?.includes('chart')).length, 'overview contains a chart');
  tree = selectTab(h, '会话');
  const sessionList = region(tree, '已采集会话列表');
  const cells = elements(tableRows(sessionList)[0], node => node.type === 'td').map(text);
  assert(cells.includes('actual-session'));
  assert(cells.includes('7') && cells.includes('125') && cells.includes('64') && cells.includes('2026/11/11 12:00:00'));
  assert.equal(elements(tree, node => node.type === 'input' && node.props.type === 'search').length, 1);
  for (const label of ['中断', '延迟', '总体统计']) {
    tree = selectTab(h, label);
    assert.equal(elements(tree, node => node.props['aria-label'] === '已采集会话列表').length, 0);
    assert.equal(elements(tree, node => node.type === 'input' && node.props.type === 'search').length, label === '总体统计' ? 1 : 0);
    assertCompactShell(tree);
  }
  assert.deepEqual(report, original);
  assert.deepEqual(h.calls, [false]);
  assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  assert.deepEqual(h.notifications, []);
});

test('incident Modal preserves existing evidence and navigates only to an actually collected linked session', async () => {
  const sessionId = 'linked-full-session-0123456789-abcdef';
  const event = interruption({ id: 'linked-evidence', sessionId, callId: 'actual-call-id', pid: 812, agent: 'actual-agent', occurredAt: '2026-11-11T01:00:00.000Z', resolved: true });
  const report = diagnostic({ sessions: [sessionEvidence({ id: sessionId }), sessionEvidence({ id: 'other-session' })], interruptions: [event, interruption({ id: 'missing-session-evidence', sessionId: 'missing-session' })] });
  const original = structuredClone(report);
  const h = await loaded(report);
  const baselineCollectorCalls = h.collectorCalls.length;
  let tree = selectTab(h, '中断');
  button(tree, '查看中断证据 linked-evidence').props.onClick();
  tree = h.render();
  let modal = elements(tree, node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert(modal);
  assert.deepEqual(elements(modal, node => node.type === 'dd').map(text), ['linked-evidence', '模型调用错误 (llm_error)', '高危', '2026/11/11 09:00:00', sessionId, 'actual-call-id', '812', 'actual-agent', '已处理（来源记录）']);
  button(modal, '查看关联会话').props.onClick();
  tree = h.render();
  assert.equal(tab(tree, '会话').props['aria-selected'], true);
  assert.equal(elements(tree, node => node.type === 'input' && node.props.type === 'search')[0].props.value, sessionId);
  assert.equal(button(tree, `收起会话 ${sessionId}`).props['aria-expanded'], true);
  assert.match(text(region(tree, '已采集会话列表')), /linked-evidence/);
  assert.doesNotMatch(text(region(tree, '已采集会话列表')), /other-session/);
  assert.equal(elements(tree, node => node.props.subtitle === '本地报告已有证据 · 只读').length, 0);
  tree = selectTab(h, '中断');
  button(tree, '查看中断证据 missing-session-evidence').props.onClick();
  modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
  assert(modal);
  assert.match(text(modal), /missing-session/);
  assert.equal(elements(modal, node => node.type === 'button' && text(node).includes('查看关联会话')).length, 0);
  assert.deepEqual(elements(modal, node => node.type === 'button').map(text), ['关闭']);
  button(modal, '关闭').props.onClick();
  assert.deepEqual(h.calls, [false]);
  assert.equal(h.collectorCalls.length, baselineCollectorCalls);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(report, original, 'viewing resolved evidence never changes source records');
});

test('refresh is Promise-locked, retains the old report on API failure, then retries with refresh=true', async () => {
  const waiting = deferred();
  let stage = 0;
  const h = harness(async refresh => {
    if (!refresh) return diagnostic({ processes: [processEvidence({ name: 'retained actual evidence' })], totals: { sessions: 11, inputTokens: 0, outputTokens: null, unresolved: 4, critical: 1, high: 3 },
      sessions: [sessionEvidence({ inputTokens: 0, outputTokens: null })],
      hooks: hookCumulativeEvidence({ sessions: 2, events: 4000, prompts: 30, toolStarts: 40, turnFailures: 5, openTools: 6 }),
    });
    stage++;
    if (stage === 1) return waiting.promise;
    return diagnostic({ processes: [processEvidence({ name: 'new actual evidence' })], sampledAt: '2026-11-11T06:00:00.000Z', totals: { sessions: 12, inputTokens: 100, outputTokens: 0, unresolved: 0, critical: 0, high: 0 },
      sessions: [sessionEvidence({ inputTokens: 100, outputTokens: 0 })],
      hooks: hookCumulativeEvidence({ sessions: 3, events: 5000, prompts: 31, toolStarts: 41, turnFailures: 0, openTools: 0 }),
    });
  });
  h.render(); h.mount(); await settle();
  const trigger = button(h.render(), '刷新诊断');
  const pending = trigger.props.onClick();
  await trigger.props.onClick();
  assert.deepEqual(h.calls, [false, true]);
  assert.equal(button(h.render(), '正在更新诊断').props.disabled, true);
  assert.match(text(outsideDetails(h.render())), /以下为上次报告，尚未更新/);
  assert.match(text(region(h.render(), '已采集进程探活')), /retained actual evidence/);
  assert.deepEqual(hookKpiValues(h.render()), ['2', '4,000', '30', '40', '5', '6']);
  const collectorCallsWhileBusy = h.collectorCalls.length;
  assert.deepEqual(hookKpiValues(selectTab(h, '会话')), ['2', '4,000', '30', '40', '5', '6']);
  assert.deepEqual(elements(tableRows(region(h.render(), '已采集会话列表'))[0], node => node.type === 'td').map(text).slice(5, 7), ['0', '—']);
  assert.deepEqual(hookKpiValues(selectTab(h, '总体统计')), ['2', '4,000', '30', '40', '5', '6']);
  assert.match(text(h.render()), /近 24h 未处理 4 · 已取得中断明细 0 条/);
  assert.equal(h.collectorCalls.length, collectorCallsWhileBusy, 'tabs are local even during refresh');
  waiting.reject(new Error('<script>OpenAPI unavailable</script>'));
  await pending;
  let tree = h.render();
  assert.match(text(outsideDetails(tree)), /旧结果：刷新失败/);
  assert.match(text(region(tree, '已采集进程探活')), /retained actual evidence/);
  assert.match(text(collectionDetails(tree)), /2026\/11\/11 20:00:00/);
  assert.deepEqual(hookKpiValues(tree), ['2', '4,000', '30', '40', '5', '6']);
  assert.match(text(elements(tree, node => node.props.role === 'alert')[0]), /暂时无法更新诊断，请稍后重试/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /OpenAPI unavailable|&lt;script&gt;/);
  assert.equal(button(tree, '刷新诊断').props.disabled, false);
  assertNoDemo(renderToStaticMarkup(tree));
  await button(tree, '刷新诊断').props.onClick();
  tree = h.render();
  assert.deepEqual(h.calls, [false, true, true]);
  assert.match(text(region(tree, '已采集进程探活')), /new actual evidence/);
  const refreshedCoverage = elements(collectionDetails(tree), node => node.props.className === 'ad-live-coverage')[0];
  assert.equal(elements(refreshedCoverage, node => node.type === 'li').length, 5);
  for (const label of Object.values(shared.agentSourceLabels)) assert(text(refreshedCoverage).includes(`${label}：可用`));
  assert.match(text(collectionDetails(tree)), /2026\/11\/11 14:00:00/);
  assert.deepEqual(hookKpiValues(tree), ['3', '5,000', '31', '41', '0', '0']);
  assert.match(text(tree), /近 24h 未处理 0 · 已取得中断明细 0 条/);
  assert.deepEqual(elements(tableRows(region(selectTab(h, '会话'), '已采集会话列表'))[0], node => node.type === 'td').map(text).slice(5, 7), ['100', '0']);
  assert.doesNotMatch(text(tree), /OpenAPI unavailable|旧结果|retained actual evidence/);
  assert.equal(h.notifications.length, 1);
});

test('API failure without a report gives only a fixed safe retry prompt without deployment details or Demo fallback', async () => {
  let fail = true;
  const h = harness(async () => {
    if (fail) throw new Error('OpenAPI connection refused');
    return diagnostic({ status: 'unavailable', outcome: 'unknown', summary: 'AgentSight unavailable report', coverage: Object.keys(shared.agentSourceLabels).map(key => ({ key, status: 'unavailable', reason: 'AgentSight not running' })) });
  });
  h.render(); h.mount(); await settle();
  let tree = h.render();
  assert.equal(text(elements(elements(tree, node => node.props.role === 'alert')[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
  const disclosure = collectionDetails(tree);
  assert.match(text(disclosure), /尚未取得诊断数据/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /OpenAPI connection refused|127\.0\.0\.1:739[67]|SYSOM_AGENTSIGHT_|CAP_SYS_ADMIN|systemd|开机自启|\/var\/lib\/sysom-agentsight|root|50 MiB|WAL|未授权|用户配置|联网下载/);
  assertNoAgentSightStatistics(tree);
  assert.doesNotMatch(text(elements(tree, node => node.props.className === 'ad-hook-kpis')[0]), /模型调用|Token/);
  assert.match(text(tree), /尚未取得本机报告/);
  assertCompactShell(tree);
  assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
  assert.deepEqual(elements(tree, node => node.type === 'button' && node.props.role !== 'tab').map(text), ['重试诊断']);
  assertNoDemo(renderToStaticMarkup(tree));
  fail = false;
  await button(tree, '重试诊断').props.onClick();
  tree = h.render();
  assert.deepEqual(h.calls, [false, true]);
  assert.doesNotMatch(text(tree), /AgentSight unavailable report|AgentSight not running/);
  assert.match(text(tree), /采集不可用/);
  assert.match(text(tree), /证据不足，暂无法判断/);
  assert.doesNotMatch(text(tree), /诊断请求失败|connection refused/);
  assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
});

test('empty or non-Error API failures still show a retryable error rather than hiding the failure', async () => {
  for (const failure of [new Error(''), '', null, { reason: 'transport rejected' }]) {
    const h = harness(async () => { throw failure; });
    h.render(); h.mount(); await settle();
    const tree = h.render();
    assert.equal(text(elements(elements(tree, node => node.props.role === 'alert')[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
    assert.doesNotMatch(renderToStaticMarkup(tree), /transport rejected|\[object Object\]|rawerror/);
    assert.equal(button(tree, '重试诊断').props.disabled, false);
    assertCompactShell(tree);
    assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
    assertNoDemo(renderToStaticMarkup(tree));
  }
});

test('mount and refresh completions do not write state or notify after cleanup, whether resolved or rejected', async () => {
  for (const refresh of [false, true]) {
    for (const rejected of [false, true]) {
      const waiting = deferred();
      const h = harness(async isRefresh => refresh && !isRefresh ? diagnostic() : waiting.promise);
      h.render(); h.mount();
      let pending;
      if (refresh) {
        await settle();
        pending = button(h.render(), '刷新诊断').props.onClick();
      }
      const oldButton = button(h.render(), '正在更新诊断');
      h.unmount();
      const before = h.writes();
      if (rejected) waiting.reject(new Error('late failure'));
      else waiting.resolve(diagnostic({ summary: 'late report' }));
      if (pending) await pending;
      await settle();
      assert.equal(h.writes(), before, `post-cleanup state update: refresh=${refresh}, rejected=${rejected}`);
      assert.deepEqual(h.notifications, []);
      const beforeCalls = [...h.calls];
      await oldButton.props.onClick();
      assert.deepEqual(h.calls, beforeCalls, 'an unmounted component cannot start another request');
    }
  }
});

test('collector status resolution or failure cannot write state after unmount', async () => {
  for (const rejected of [false, true]) {
    const waiting = deferred();
    const h = harness(undefined, { fetchCollectorStatus: () => waiting.promise });
    h.render(); h.mount(); await settle();
    const beforeCalls = [...h.calls];
    h.unmount();
    const beforeWrites = h.writes();
    if (rejected) waiting.reject(new Error('late service failure'));
    else waiting.resolve({ agent_sight: { state: 'running', collection: { state: 'running', message: 'late service evidence' } } });
    await settle();
    assert.equal(h.writes(), beforeWrites);
    assert.deepEqual(h.calls, beforeCalls);
    assert.deepEqual(h.notifications, []);
  }
});

test('live implementation uses only the report client, no direct transport, destructive controls or demo constants; small styles stay scoped', () => {
  const liveSource = source.slice(source.indexOf('const liveSeverityLabels'));
  assert.match(source, /import \{ fetchAgentDiagnostic, fetchCollectorStatus \} from '\.\/idc-client'/);
  assert.match(source, /import type \{[^}]*\bAgentDiagnostic\b[^}]*\bAgentInterruptionEvidence\b[^}]*\} from '\.\/agent-diagnostics-data'/);
  assert.match(liveSource, /fetchAgentDiagnostic\(refresh\)/);
  assert.match(liveSource, /loadReport\(false\)/);
  assert.doesNotMatch(liveSource, /dangerouslySetInnerHTML|\bfetch\s*\(|XMLHttpRequest|axios|agentSummary|formatNumber|navigator|setTimeout|restartProcess|resolvedIds|onRestart|exe_path|access_token/);
  assert.doesNotMatch(liveSource, /fetch(?:Session|Conversation)|get(?:Session|Conversation)|report\.(?:summary|findings)|coverage\.reason|collection\.message|service\??\.message|error\.message/);
  assert.doesNotMatch(liveSource, /Cosh|qwen-plus|6731|7118|140740|Resolve|Hide/);
  const css = fs.readFileSync(path.resolve(__dirname, '../src/styles/app.css'), 'utf8');
  const additions = css.slice(css.indexOf('/* Real Agent diagnostics:'));
  assert.match(additions, /\.ad-live \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
  assert.match(additions, /\.ad-live \.ad-session-table \{[^}]*min-width: 0;[^}]*max-width: 100%;/);
  assert.match(css, /\.ad-session-table \{[^}]*overflow-x: auto;/);
  assert.match(additions, /\.ad-live \.ad-session-table th, \.ad-live \.ad-session-table td \{[^}]*white-space: normal;/);
  assert.match(additions, /\[aria-label="已采集会话列表"\] > table \{ min-width: 1000px; \}/);
  assert.match(additions, /\[aria-label="已采集会话列表"\] > table > thead > tr > th:first-child \{ width: 40px; \}/);
  assert.match(css, /@media \(max-width: 600px\) \{\s*body \{\s*min-width: 0;/);
  assert.match(additions, /\.ad-live-meta \{ grid-template-columns: 1fr; \}/);
  assert.match(additions, /\.ad-live \.ad-hook-kpis \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  assert.match(additions, /\.ad-live \.ad-hook-kpis > div \{[^}]*padding: 16px;[^}]*border: 1px solid var\(--ad-kpi-border\);[^}]*border-radius: 12px;[^}]*background: var\(--ad-kpi-background\);[^}]*box-shadow: inset 0 3px 0 var\(--ad-kpi-accent\);/);
  assert.match(additions, /\.ad-live \.ad-hook-kpis strong \{[^}]*color: var\(--ad-kpi-accent\);/);
  assert.deepEqual([...additions.matchAll(/\.ad-live \.ad-hook-kpis > div:nth-child\((\d)\)/g)].map(match => Number(match[1])), [2, 3, 4, 5, 6]);
  assert.match(additions, /@media \(max-width: 900px\) \{ \.ad-live \.ad-hook-kpis \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(additions, /@media \(max-width: 600px\) \{ \.ad-live \.ad-hook-kpis \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
});

test('45 processes paginate locally as 20, 20 and 5 rows; last-page clamping never duplicates or loses evidence', async () => {
  const report = freezeEvidence(diagnostic({
    processes: fortyFiveProcesses(),
    totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
    hooks: hookCumulativeEvidence({ sessions: 7, events: 5000, prompts: 10, toolStarts: 20, turnFailures: 3, openTools: 4 }),
  }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const seen = [];
  for (let page = 1; page <= 3; page++) {
    const tree = h.render();
    assertProcessPage(tree, page, 3, report.processes.slice((page - 1) * 20, page * 20));
    seen.push(...processNames(tree));
    unchanged();
    if (page < 3) button(tree, '下一页').props.onClick();
  }
  assert.deepEqual(seen, report.processes.map(process => process.name));
  assert.equal(new Set(seen).size, 45);
  // Simulate a queued callback beyond the last page: display still clamps to the last real page.
  button(h.render(), '下一页').props.onClick();
  assertProcessPage(h.render(), 3, 3, report.processes.slice(40));
  button(h.render(), '上一页').props.onClick();
  assertProcessPage(h.render(), 2, 3, report.processes.slice(20, 40));
  button(h.render(), '上一页').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  selectTab(h, '会话');
  selectTab(h, '中断');
  selectTab(h, '延迟');
  assertProcessPage(selectTab(h, '总体统计'), 1, 3, report.processes.slice(0, 20));
  unchanged();
  assert.deepEqual(hookKpiValues(h.render()), ['7', '5,000', '10', '20', '3', '4']);
  assert.match(text(h.render()), /近 24h 未处理 73 · 已取得中断明细 0 条/);
  assert.deepEqual(h.calls, [false]);
});

test('process name/PID search, role and all six states plus attention combine without changing reports or global totals', async () => {
  const report = freezeEvidence(diagnostic({ processes: fortyFiveProcesses() }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const options = elements(control(h.render(), '筛选探活状态'), node => node.type === 'option').map(node => [node.props.value, text(node)]);
  assert.deepEqual(options, [['', '全部状态'], ['attention', '需检查'], ...Object.entries(shared.agentProcessLabels)]);
  assert.deepEqual(elements(control(h.render(), '筛选进程角色'), node => node.type === 'option').map(node => node.props.value), ['', 'cli', 'supervisor', 'worker']);
  for (const status of Object.keys(shared.agentProcessLabels)) {
    const expected = report.processes.filter(process => process.status === status);
    assertProcessPage(change(h, '筛选探活状态', status), 1, 1, expected);
    unchanged();
  }
  change(h, '筛选探活状态', '');
  let expected = report.processes.filter(process => process.name.toLowerCase().includes('alpha'));
  let tree = change(h, '搜索进程名或 PID', '  ALPHA  ');
  assertProcessPage(tree, 1, 2, expected.slice(0, 20));
  button(tree, '下一页').props.onClick();
  assertProcessPage(h.render(), 2, 2, expected.slice(20));
  tree = change(h, '筛选进程角色', 'worker');
  expected = expected.filter(process => process.role === 'worker');
  assertProcessPage(tree, 1, 1, expected);
  tree = change(h, '筛选探活状态', 'hung');
  expected = expected.filter(process => process.status === 'hung');
  assert(expected.length > 0, 'combination fixture must actually contain a match');
  assertProcessPage(tree, 1, 1, expected);
  unchanged();
  button(tree, '清除筛选').props.onClick();
  tree = change(h, '搜索进程名或 PID', '  9134  ');
  assertProcessPage(tree, 1, 1, report.processes.filter(process => process.pid === 9134));
  tree = change(h, '筛选进程角色', 'worker');
  assertProcessPage(tree, 1, 1, []);
  assert.match(text(tree), /没有匹配的进程/);
  assert.doesNotMatch(text(tree), /没有已采集的进程记录/);
  button(tree, '清除筛选').props.onClick();
  tree = change(h, '筛选探活状态', 'attention');
  expected = report.processes.filter(process => ['unhealthy', 'hung'].includes(process.status) || (process.status === 'offline' && process.hasCrash === true));
  assertProcessPage(tree, 1, 1, expected);
  tree = change(h, '筛选进程角色', 'supervisor');
  expected = expected.filter(process => process.role === 'supervisor');
  assertProcessPage(tree, 1, 1, expected);
  tree = change(h, '搜索进程名或 PID', 'beta');
  assertProcessPage(tree, 1, 1, expected.filter(process => process.name.toLowerCase().includes('beta')));
  unchanged();
  button(tree, '清除筛选').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  unchanged();
});

test('every process-filter change and clear resets page 1 even when the matching data still spans three pages', async () => {
  const report = freezeEvidence(diagnostic({ processes: fortyFiveProcesses({ role: 'worker', status: 'healthy', hasCrash: false }) }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  function lastPage() {
    button(h.render(), '下一页').props.onClick();
    button(h.render(), '下一页').props.onClick();
    assertProcessPage(h.render(), 3, 3, report.processes.slice(40));
  }
  assert.equal(button(h.render(), '清除筛选').props.disabled, true);
  for (const [label, value] of [['搜索进程名或 PID', 'AGENT'], ['筛选进程角色', 'worker'], ['筛选探活状态', 'healthy']]) {
    lastPage();
    assertProcessPage(change(h, label, value), 1, 3, report.processes.slice(0, 20));
    unchanged();
  }
  lastPage();
  assert.equal(button(h.render(), '清除筛选').props.disabled, false);
  button(h.render(), '清除筛选').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  for (const label of ['搜索进程名或 PID', '筛选进程角色', '筛选探活状态']) assert.equal(control(h.render(), label).props.value, '');
  assert.equal(button(h.render(), '清除筛选').props.disabled, true);
  for (const [label, value] of [['搜索进程名或 PID', 'no-such-process'], ['筛选进程角色', 'worker'], ['筛选探活状态', 'unhealthy']]) change(h, label, value);
  assertProcessPage(h.render(), 1, 1, []);
  button(h.render(), '清除筛选').props.onClick();
  assertProcessPage(h.render(), 1, 3, report.processes.slice(0, 20));
  unchanged();
});

test('report refresh resets page 1 for unchanged-length and shortened process data; stale pagination clamps to new data', async () => {
  const reports = [45, 45, 7].map((count, index) => freezeEvidence(diagnostic({
    sampledAt: `2026-11-11T${String(7 + index).padStart(2, '0')}:00:00.000Z`,
    processes: fortyFiveProcesses({ role: 'worker', status: 'healthy', hasCrash: false }).slice(0, count).map(process => ({ ...process, name: `Agent-revision-${index}-${process.pid}` })),
    totals: { sessions: 30 + index, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
    hooks: hookCumulativeEvidence({ sessions: 5 + index, events: 5000, prompts: 10, toolStarts: 20, turnFailures: 3, openTools: 4 }),
  })));
  let stage = 0;
  const h = harness(async () => reports[stage++]);
  h.render(); h.mount(); await settle();
  change(h, '搜索进程名或 PID', 'Agent');
  change(h, '筛选进程角色', 'worker');
  change(h, '筛选探活状态', 'healthy');
  for (let index = 1; index <= 2; index++) {
    button(h.render(), '下一页').props.onClick();
    button(h.render(), '下一页').props.onClick();
    assertProcessPage(h.render(), 3, 3, reports[index - 1].processes.slice(40));
    const staleNext = button(h.render(), '下一页');
    await button(h.render(), '刷新诊断').props.onClick();
    await settle();
    const tree = h.render();
    assertProcessPage(tree, 1, index === 1 ? 3 : 1, reports[index].processes.slice(0, 20));
    assert.equal(control(tree, '搜索进程名或 PID').props.value, 'Agent');
    assert.equal(control(tree, '筛选进程角色').props.value, 'worker');
    assert.equal(control(tree, '筛选探活状态').props.value, 'healthy');
    assert.deepEqual(hookKpiValues(tree), [String(5 + index), '5,000', '10', '20', '3', '4']);
    assert.match(text(tree), /近 24h 未处理 73 · 已取得中断明细 0 条/);
    assert.match(text(collectionDetails(tree)), new RegExp(`2026/11/11 ${String(15 + index).padStart(2, '0')}:00:00`));
    assert.deepEqual(h.calls, [false, ...Array(index).fill(true)]);
    if (index === 2) {
      const unchanged = assertLocalOnly(h, reports[index]);
      staleNext.props.onClick();
      assertProcessPage(h.render(), 1, 1, reports[index].processes);
      unchanged();
      button(h.render(), '清除筛选').props.onClick();
      assertProcessPage(h.render(), 1, 1, reports[index].processes);
      unchanged();
    }
  }
  assert.deepEqual(h.notifications, ['诊断已更新。', '诊断已更新。']);
});

test('attention includes unhealthy/hung regardless of crash and offline only with true crash; process card clears other filters', async () => {
  const processes = Object.keys(shared.agentProcessLabels).flatMap((status, index) => [false, true].map((hasCrash, offset) => processEvidence({
    pid: 9200 + index * 2 + offset, name: `fixture-${status}-${hasCrash}`, status, hasCrash, role: offset ? 'supervisor' : 'worker',
  })));
  const report = freezeEvidence(diagnostic({ outcome: 'abnormal', processes }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const expected = processes.filter(process => ['unhealthy', 'hung'].includes(process.status) || (process.status === 'offline' && process.hasCrash === true));
  assert.equal(expected.length, 5);
  assertProcessPage(change(h, '筛选探活状态', 'attention'), 1, 1, expected);
  assert.doesNotMatch(text(region(h.render(), '已采集进程探活')), /fixture-no_port|fixture-healthy|fixture-unknown|fixture-offline-false/);
  change(h, '搜索进程名或 PID', 'missing');
  change(h, '筛选进程角色', 'supervisor');
  change(h, '筛选探活状态', 'healthy');
  assertProcessPage(h.render(), 1, 1, []);
  const card = button(h.render(), '查看异常进程证据');
  assert.match(text(card), /进程探活异常 · 5 个/);
  card.props.onClick();
  const tree = h.render();
  assert.equal(tab(tree, '总体统计').props['aria-selected'], true);
  assert.equal(control(tree, '搜索进程名或 PID').props.value, '');
  assert.equal(control(tree, '筛选进程角色').props.value, '');
  assert.equal(control(tree, '筛选探活状态').props.value, 'attention');
  assertProcessPage(tree, 1, 1, expected);
  assert.match(text(elements(tree, node => node.props['aria-label'] === '诊断结论')[0]), /进程需检查 5 个/);
  unchanged();
  const noPort = await loaded(diagnostic({ processes: [processEvidence({ status: 'no_port', ports: [], hasCrash: true })] }));
  assert.equal(elements(noPort.render(), node => node.props['aria-label'] === '查看异常进程证据').length, 0, 'a CLI with no port is not an inferred failure, even with a recorded crash flag');
});

test('overview groups only unresolved events by type, orders highest severity, caps four groups and opens locally filtered evidence', async () => {
  const events = [
    interruption({ id: 'llm-low', severity: 'low' }),
    interruption({ id: 'tool-medium', type: 'tool_error', severity: 'medium' }),
    interruption({ id: 'dead-medium', type: 'dead_loop', severity: 'medium' }),
    interruption({ id: 'context-high-1', type: 'context_overflow' }),
    interruption({ id: 'token-critical', type: 'token_limit', severity: 'critical' }),
    interruption({ id: 'llm-high' }),
    interruption({ id: 'dead-critical', type: 'dead_loop', severity: 'critical' }),
    interruption({ id: 'context-high-2', type: 'context_overflow' }),
    interruption({ id: 'context-low', type: 'context_overflow', severity: 'low' }),
    interruption({ id: 'user-low', type: 'user_cancel', severity: 'low' }),
    interruption({ id: 'llm-resolved-critical', severity: 'critical', resolved: true }),
    interruption({ id: 'crash-resolved', type: 'agent_crash', severity: 'critical', resolved: true }),
  ];
  const report = freezeEvidence(diagnostic({ outcome: 'abnormal', interruptions: events,
    totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 },
  }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const cards = elements(h.render(), node => node.type === 'button' && node.props['aria-label']?.startsWith('查看事件证据 '));
  assert.deepEqual(cards.map(node => node.props['aria-label']), ['查看事件证据 dead_loop', '查看事件证据 token_limit', '查看事件证据 context_overflow', '查看事件证据 llm_error']);
  assert.deepEqual(cards.map(node => text(elements(node, child => child.type === 'strong')[0])), ['循环风险 · 2 条', 'Token 达到上限 · 1 条', '上下文超限 · 3 条', '模型调用错误 · 2 条']);
  assert.deepEqual(cards.map(node => text(elements(node, child => child.props.className?.includes('ad-badge'))[0])), ['严重', '严重', '高危', '高危']);
  assert.doesNotMatch(cards.map(text).join(''), /critical|high|medium|low|crash-resolved|llm-resolved/);
  for (const card of cards) {
    const type = card.props['aria-label'].slice('查看事件证据 '.length);
    card.props.onClick();
    let tree = h.render();
    assert.equal(tab(tree, '中断').props['aria-selected'], true);
    assert.equal(control(tree, '筛选中断类型').props.value, type);
    const expected = events.filter(event => event.type === type);
    const list = region(tree, '已采集中断元数据');
    const ids = elements(list, node => node.type === 'button').map(node => node.props['aria-label']);
    assert.deepEqual(ids, expected.map(event => `查看中断证据 ${event.id}`), 'type navigation preserves both resolved and unresolved source evidence of that type');
    assert.equal(elements(tree, node => node.props.subtitle === '本地报告已有证据 · 只读').length, 0);
    assert.match(text(tree), new RegExp(`近 24h 未处理 73 · 匹配 ${expected.length} / 已取得明细 12`));
    button(tree, `查看中断证据 ${expected[0].id}`).props.onClick();
    const modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
    assert.equal(text(elements(modal, node => node.type === 'dd')[0]), expected[0].id);
    assert.equal(elements(modal, node => node.type === 'dt').length, 9);
    button(modal, '关闭').props.onClick();
    selectTab(h, '总体统计');
    unchanged();
  }
  button(h.render(), '查看全部中断').props.onClick();
  assert.equal(control(h.render(), '筛选中断类型').props.value, '');
  assert.equal(tableRows(region(h.render(), '已采集中断元数据')).length, events.length);
  change(h, '筛选中断类型', 'tool_error');
  assert.equal(tableRows(region(h.render(), '已采集中断元数据')).length, 1, 'fifth-ranked type remains accessible from the full evidence tab');
  selectTab(h, '总体统计');
  button(h.render(), '查看全部中断').props.onClick();
  assert.equal(control(h.render(), '筛选中断类型').props.value, '');
  assert.equal(tableRows(region(h.render(), '已采集中断元数据')).length, events.length);
  unchanged();
});

test('summary, findings, source reasons, service messages and raw errors never disclose synthetic sensitive sentinels in any view', async () => {
  const sentinel = field => `SENSITIVE_${field}_SENTINEL_<script>synthetic-only</script>`;
  const report = freezeEvidence(diagnostic({
    summary: sentinel('SUMMARY'),
    findings: [{ severity: 'error', title: sentinel('TITLE'), detail: sentinel('DETAIL'), suggestion: sentinel('SUGGESTION') }],
    lastScanAt: sentinel('LAST_SCAN'),
    coverage: Object.keys(shared.agentSourceLabels).map((key, index) => ({ key, status: ['available', 'unavailable', 'invalid', 'truncated'][index % 4], reason: sentinel(`REASON_${key}`) })),
    processes: [processEvidence()], sessions: [sessionEvidence()],
    interruptions: [interruption({ sessionId: 'actual-session' })],
  }));
  const waiting = deferred();
  const h = harness(async refresh => refresh ? waiting.promise : report, { fetchCollectorStatus: async () => ({ agent_sight: {
    state: 'running', message: sentinel('SERVICE_MESSAGE'),
    collection: { state: 'disabled', enabled: false, scope: 'none', trace_running: false, api_running: true, message: sentinel('COLLECTION_MESSAGE') },
  } }) });
  h.render(); h.mount(); await settle();
  function noLeak() {
    const tree = h.render();
    assert.doesNotMatch(renderToStaticMarkup(tree) + text(tree) + h.notifications.join(''), /SENSITIVE_|synthetic-only|rawerror/);
    assertNoDemo(renderToStaticMarkup(tree));
  }
  noLeak();
  const unchanged = assertLocalOnly(h, report);
  for (const label of ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入']) {
    const tree = selectTab(h, label);
    collectionDetails(tree);
    noLeak();
    if (label === '会话') {
      button(tree, '展开会话 actual-session').props.onClick();
      noLeak();
    }
    if (label === '中断') {
      button(tree, '查看中断证据 actual-event').props.onClick();
      const modal = elements(h.render(), node => node.props.subtitle === '本地报告已有证据 · 只读')[0];
      assert.equal(text(elements(modal, node => node.props.className === 'ad-modal-note')[0]), '仅展示本次报告已有证据，未确认故障根因。');
      noLeak();
      button(modal, '关闭').props.onClick();
    }
    unchanged();
  }
  selectTab(h, '总体统计');
  assert.match(text(collectionDetails(h.render())), /采集停用，当前显示历史记录/);
  const pending = button(h.render(), '刷新诊断').props.onClick();
  assert.equal(button(h.render(), '正在更新诊断').props.disabled, true);
  noLeak();
  waiting.reject(new Error(sentinel('RAW_ERROR')));
  await pending;
  noLeak();
  assert.equal(text(elements(elements(h.render(), node => node.props.role === 'alert')[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
  assert.deepEqual(h.calls, [false, true]);
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(processNames(h.render()), ['actual-cli']);
  assert.match(text(collectionDetails(h.render())), /更新时间2026\/11\/11 20:00:00/);
});

test('Hook golden path renders exported labels, all metadata, read-only evidence buttons and independent action-free summary without invented measurements', async () => {
  const kinds = Object.keys(shared.agentHookKindLabels);
  const report = freezeEvidence(diagnostic({ outcome: 'abnormal', hooks: {
    status: 'available', reason: 'Hook metadata collected', skippedLines: 0,
    agents: [hookAgentSummary({ sessions: 2, events: 30, prompts: 3, toolStarts: 4, toolEnds: 5,
      toolFailures: 6, interrupts: 7, permissionDenied: 8, turnFailures: 9, openTools: 10 })],
    events: kinds.map((kind, index) => hookEvent({ id: `hook-${kind}`, kind,
      occurredAt: `2026-11-11T11:${String(index).padStart(2, '0')}:00Z`, sessionId: 'actual-session',
      callId: 'hook-call-only', tool: 'reported-tool', errorType: 'reported-error',
      interrupt: [true, false, null][index % 3], subagent: 'reported-subagent', model: 'reported-model' })),
  }, sessions: [sessionEvidence()], interruptions: [interruption({ sessionId: 'actual-session' })] }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  assert.match(text(elements(h.render(), node => node.props['aria-label'] === '诊断结论')[0]), /Hook 轮次失败需关注/);
  const card = button(h.render(), '查看 Hook 轮次失败事件');
  assert.match(text(card), /Hook 轮次失败 · 已记录/);
  selectTab(h, '会话与明细');
  const tree = change(h, 'Hook 事件每页条数', '20');
  const coverage = elements(tree, node => node.props['aria-label'] === 'Hook 来源覆盖')[0];
  assert.match(text(coverage), /Hook 数据可用.*覆盖原因：Hook metadata collected · 跳过行数：0/);
  const summary = region(tree, 'Hook Agent 汇总');
  assert.deepEqual(elements(summary, node => node.type === 'th').map(text), ['Agent', '会话', '事件', '提交提示', '工具开始', '工具完成', '工具失败', '中断', '授权拒绝', '轮次失败', '未配对工具开始', '最近事件']);
  assert.deepEqual(elements(tableRows(summary)[0], node => node.type === 'td').map(text), ['Qoder', '2', '30', '3', '4', '5', '6', '7', '8', '9', '10', '2026/11/11 19:00:00']);
  assert.match(text(tree), /最多 5,000 个事件 · 16 个 Agent/);
  assert.match(text(tree), /未配对工具开始只表示未记录到配对结束，不等同于卡死/);
  assert.match(text(tree), /工具失败和授权拒绝不直接视为故障.*turn_failure/);
  const metadata = region(tree, 'Hook 事件元数据');
  assert.equal(metadata.props.tabIndex, 0);
  assert.equal(summary.props.tabIndex, 0);
  assert.deepEqual(elements(metadata, node => node.type === 'th').map(text), ['事件 / Agent', '发生时间', 'Hook Session ID / Call ID', '工具 / 错误类型', '模型 / Subagent', 'interrupt', '证据']);
  const rows = tableRows(metadata);
  assert.equal(rows.length, kinds.length);
  assert.deepEqual(rows.map(row => text(elements(row, node => node.type === 'strong')[0])), kinds.toReversed().map(kind => shared.agentHookKindLabels[kind]));
  const sessionStart = rows.find(row => text(row).includes('hook-session_start'));
  assert.deepEqual(elements(sessionStart, node => node.type === 'td').map(text), [
    '会话开始session_start · Qoder事件 ID：hook-session_start', '2026/11/11 19:00:00',
    'Session ID：actual-sessionCall ID：hook-call-only', '工具：reported-tool错误类型：reported-error',
    '模型：reported-modelSubagent：reported-subagent', 'true', '查看证据',
  ]);
  assert.deepEqual([...new Set(rows.map(row => text(elements(row, node => node.type === 'td').at(-2))))].sort(), ['false', 'null · 未报告', 'true']);
  assert.equal(elements(metadata, node => node.type === 'a').length, 0, 'Hook IDs never link to AgentSight');
  assert.deepEqual(elements(metadata, node => node.type === 'button').map(node => node.props['aria-label']), kinds.toReversed().map(kind => `查看 Hook 证据 hook-${kind}`));
  assert.equal(elements(summary, node => node.type === 'button').length, 0);
  const scope = text(collectionDetails(tree));
  assert.match(scope, /Hook 与 AgentSight 独立.*不与 AgentSight Session ID 或 PID 做关联/);
  assert.match(scope, /不推算 Hook Token、耗时或健康分数/);
  assert.equal(elements(tree, node => node.props.role === 'dialog').length, 0);
  selectTab(h, '会话');
  button(h.render(), '展开会话 actual-session').props.onClick();
  assert.doesNotMatch(text(region(h.render(), '已采集会话列表')), /hook-call-only|reported-subagent|hook-session_start/, 'no cross-source ID join');
  unchanged();
  assertNoDemo(renderToStaticMarkup(tree));
});

test('Hook missing, uninstalled, empty, invalid and truncated states keep coverage reasons and distinguish absence from zero', async () => {
  const cases = [
    [undefined, /未取得 Hook 数据/, /未安装 Hook 插件或来源不可用/, /覆盖原因：未提供 · 跳过行数：—/],
    [null, /未取得 Hook 数据/, /不能据此判断 Agent 未运行/, /跳过行数：—/],
    [{ status: 'unavailable', reason: 'Hook plugin not installed', skippedLines: null, agents: [], events: [] }, /未取得 Hook 数据/, /明细不可用/, /Hook plugin not installed/],
    [{ status: 'available', reason: 'No events in window', skippedLines: 0, agents: [], events: [] }, /Hook 数据可用/, /近 24h 未记录 Hook 事件；来源可用，不代表 Agent 未运行或整体正常/, /跳过行数：0/],
    [{ status: 'invalid', reason: 'Invalid hook records', skippedLines: 4, agents: [hookAgentSummary()], events: [hookEvent()] }, /Hook 数据无法使用/, /读取或校验失败.*不代表没有事件/, /Invalid hook records · 跳过行数：4/],
    [{ status: 'truncated', reason: 'Bounded read with skipped lines', skippedLines: 2, agents: [], events: [] }, /Hook 数据不完整/, /保留部分无 Hook 事件明细；不能推断完整窗口没有事件/, /跳过行数：2/],
  ];
  for (const [hooks, status, semantics, reason] of cases) {
    const h = await loaded(diagnostic({ status: 'partial', outcome: 'unknown', hooks }));
    const tree = selectTab(h, '会话与明细');
    const output = text(elements(tree, node => node.props.role === 'tabpanel')[0]);
    assert.match(output, status);
    assert.match(output, semantics);
    assert.match(output, reason);
    assert.match(text(collectionDetails(tree)), status);
    assert.equal(tableRows(region(tree, 'Hook 会话列表')).length, 0, 'no synthetic session evidence');
    assert.equal(hookIds(tree).length, 0, 'no synthetic or invalid event evidence');
    assert.equal(elements(tree, node => node.props.role === 'region' && node.props['aria-label'] === 'Hook Agent 汇总').length, 0);
    assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'), 'missing summaries are unknown, including available-but-empty evidence');
    if (hooks?.status !== 'available' && hooks?.status !== 'truncated') assert.match(output, /汇总不可用，不能将缺失当作零/);
    assert.doesNotMatch(output, /业务健康正常|本次证据未发现异常/);
    assertNoDemo(renderToStaticMarkup(tree));
  }
  const h = await loaded(diagnostic({ hooks: { status: 'truncated', reason: 'Partial valid metadata', skippedLines: 1,
    agents: [hookAgentSummary({ events: 1 })], events: [hookEvent()] } }));
  const tree = selectTab(h, '会话与明细');
  assert.equal(tableRows(region(tree, 'Hook Agent 汇总')).length, 1);
  assert.equal(tableRows(region(tree, 'Hook 事件元数据')).length, 1);
  assert.match(text(tree), /以下仅为保留部分，不代表完整 24h 活动/);
});

test('Hook real zero cumulative history stays zero while null metadata and interrupt false remain explicit', async () => {
  const h = await loaded(diagnostic({ hooks: { status: 'available', reason: '', skippedLines: 0,
    ...hookCumulativeEvidence(), events: [hookEvent({ interrupt: false }), hookEvent({ id: 'unknown-interrupt' })] } }));
  const tree = selectTab(h, '会话与明细');
  assert.deepEqual(hookKpiValues(tree), Array(6).fill('0'));
  assert.match(text(selectTab(h, '中断')), /近 24h 未处理 — · 匹配 0 \/ 已取得明细 0/, 'Hook zero evidence must not synthesize AgentSight totals');
  assert.deepEqual(hookKpiValues(h.render()), Array(6).fill('0'));
  assert.deepEqual(elements(tableRows(region(tree, 'Hook Agent 汇总'))[0], node => node.type === 'td').map(text), ['Qoder', ...Array(10).fill('0'), '2026/11/11 19:00:00']);
  const rows = tableRows(region(tree, 'Hook 事件元数据'));
  assert.deepEqual(rows.map(row => text(elements(row, node => node.type === 'td').at(-2))).sort(), ['false', 'null · 未报告']);
  for (const row of rows) {
    assert.match(text(row), /Session ID：— · 未报告Call ID：— · 未报告/);
    assert.match(text(row), /工具：— · 未报告错误类型：— · 未报告/);
    assert.match(text(row), /模型：— · 未报告Subagent：— · 未报告/);
  }
  assert.doesNotMatch(text(region(tree, 'Hook 事件元数据')), /0 ms|0 Token|健康分数|PID/);
});

test('Hook agent and kind filters combine, clear and persist locally without recomputing summary, global KPI or requests', async () => {
  const kinds = Object.keys(shared.agentHookKindLabels);
  const report = freezeEvidence(diagnostic({ hooks: { status: 'available', reason: 'All supported kinds', skippedLines: 0,
    agents: [hookAgentSummary({ events: kinds.length }), hookAgentSummary({ agent: 'other-agent', events: 1 })],
    events: [...kinds.map(kind => hookEvent({ id: `kind-${kind}`, kind })), hookEvent({ id: 'other-start', agent: 'other-agent' })],
  } }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  let tree = selectTab(h, '会话与明细');
  const summaryBefore = text(region(tree, 'Hook Agent 汇总'));
  assert.deepEqual(elements(control(tree, '筛选 Hook 类型'), node => node.type === 'option').map(node => [node.props.value, text(node)]), [['', '全部类型'], ...Object.entries(shared.agentHookKindLabels).map(([kind, label]) => [kind, `${label} (${kind})`])]);
  assert.deepEqual(elements(control(tree, '筛选 Hook Agent'), node => node.type === 'option').map(node => [node.props.value, text(node)]), [['', '全部 Agent'], ['other-agent', 'other-agent'], ['qoder', 'Qoder']]);
  assert.equal(button(tree, '清除 Hook 筛选').props.disabled, true);
  for (const kind of kinds) {
    tree = change(h, '筛选 Hook 类型', kind);
    assert.equal(tableRows(region(tree, 'Hook 事件元数据')).length, kind === 'session_start' ? 2 : 1);
    assert.equal(text(region(tree, 'Hook Agent 汇总')), summaryBefore);
    unchanged();
  }
  change(h, '筛选 Hook 类型', 'session_start');
  tree = change(h, '筛选 Hook Agent', 'other-agent');
  assert.equal(tableRows(region(tree, 'Hook 事件元数据')).length, 1);
  assert.match(text(region(tree, 'Hook 事件元数据')), /other-start/);
  tree = change(h, '筛选 Hook 类型', 'turn_failure');
  assert.match(text(tree), /最新 200 条中没有匹配的 Hook 事件；不代表 24h 汇总中没有此类事件/);
  selectTab(h, '会话');
  tree = selectTab(h, '会话与明细');
  assert.equal(control(tree, '筛选 Hook Agent').props.value, 'other-agent');
  assert.equal(control(tree, '筛选 Hook 类型').props.value, 'turn_failure');
  button(tree, '清除 Hook 筛选').props.onClick();
  tree = h.render();
  assert.equal(control(tree, '筛选 Hook Agent').props.value, '');
  assert.equal(control(tree, '筛选 Hook 类型').props.value, '');
  assert.equal(allTablePages(h, 'Hook 事件', 'Hook 事件元数据').length, kinds.length + 1);
  assert.equal(text(region(tree, 'Hook Agent 汇总')), summaryBefore);
  selectTab(h, '总体统计');
  button(h.render(), '查看Hook事件').props.onClick();
  assert.equal(tab(h.render(), '会话与明细').props['aria-selected'], true);
  unchanged();
});

test('Hook rendering caps 16 summaries and the latest 200 rows without treating bounded summaries as cumulative charts', async () => {
  const events = Array.from({ length: 250 }, (_, index) => hookEvent({ id: `bounded-${index}`, kind: index < 50 ? 'turn_failure' : 'tool_end',
    occurredAt: new Date(Date.parse('2026-11-11T10:00:00Z') + index * 1000).toISOString() }));
  const report = freezeEvidence(diagnostic({ outcome: 'abnormal', hooks: { status: 'truncated', reason: '5,000 event bound', skippedLines: 0,
    agents: [hookAgentSummary({ events: 5000, turnFailures: 50 }), ...Array.from({ length: 16 }, (_, index) => hookAgentSummary({ agent: `bounded-agent-${index}` }))],
    events,
  } }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const overview = h.render();
  assert.equal(elements(overview, node => node.props['aria-label'] === '查看异常进程证据').length, 0);
  assert.equal(elements(overview, node => node.props['aria-label']?.startsWith('查看事件证据 ')).length, 0);
  assert.match(text(overview), /当前明细无待关注项/);
  assert.equal(elements(overview, node => node.props['aria-label'] === '查看 Hook 轮次失败事件').length, 0);
  selectTab(h, '会话与明细');
  let tree = change(h, '筛选 Hook 类型', 'turn_failure');
  assert.equal(tab(tree, '会话与明细').props['aria-selected'], true);
  assert.equal(control(tree, '筛选 Hook Agent').props.value, '');
  assert.equal(control(tree, '筛选 Hook 类型').props.value, 'turn_failure');
  assert.match(text(tree), /匹配 0 \/ 已取得 200/);
  assert.match(text(tree), /最新 200 条中没有匹配.*不代表 24h 汇总中没有此类事件/);
  assert.equal(tableRows(region(tree, 'Hook Agent 汇总')).length, 5);
  const summaryBefore = allTablePages(h, 'Hook Agent 汇总', 'Hook Agent 汇总').map(text).join('');
  assert.equal(allTablePages(h, 'Hook Agent 汇总', 'Hook Agent 汇总').length, 16);
  assert.doesNotMatch(summaryBefore, /bounded-agent-15/);
  assert.match(summaryBefore, /5,000/);
  button(tree, '清除 Hook 筛选').props.onClick();
  tree = h.render();
  assert.equal(tableRows(region(tree, 'Hook 事件元数据')).length, 10);
  const rows = allTablePages(h, 'Hook 事件', 'Hook 事件元数据');
  assert.equal(rows.length, 200);
  assert.deepEqual(rows.map(row => text(elements(row, node => node.type === 'small' && text(node).startsWith('事件 ID：'))[0]).slice('事件 ID：'.length)), events.slice(50).toReversed().map(event => event.id));
  assert.equal(allTablePages(h, 'Hook Agent 汇总', 'Hook Agent 汇总').map(text).join(''), summaryBefore);
  unchanged();
});

test('Hook tool failures, permission denials, interrupts and unmatched starts are not automatic faults; turn_failure alone is an attention entry', async () => {
  const hooks = { status: 'available', reason: '', skippedLines: 0,
    agents: [hookAgentSummary({ events: 3, toolFailures: 1, permissionDenied: 1, interrupts: 1, openTools: 1 })],
    events: ['tool_failure', 'permission_denied', 'turn_stop'].map(kind => hookEvent({ id: kind, kind, interrupt: true })),
  };
  const h = await loaded(diagnostic({ hooks }));
  assert.equal(elements(h.render(), node => node.props['aria-label'] === '查看 Hook 轮次失败事件').length, 0);
  const tree = selectTab(h, '会话与明细');
  const metadata = region(tree, 'Hook 事件元数据');
  assert.doesNotMatch(text(metadata), /故障|卡死|严重|高危|未处理|已处理/);
  assert.equal(elements(metadata, node => node.props.className?.includes('ad-badge')).length, 0);
  const eventOnly = await loaded(diagnostic({ outcome: 'abnormal', hooks: { ...hooks, agents: [], events: [hookEvent({ kind: 'turn_failure' })] } }));
  const card = button(eventOnly.render(), '查看 Hook 轮次失败事件');
  assert.match(text(card), /Hook 轮次失败 · 已记录/);
  card.props.onClick();
  assert.equal(tableRows(region(eventOnly.render(), 'Hook 事件元数据')).length, 1);
});

test('seven tabs support arrows, wraparound, Home and End with matching focus and panel accessibility, including Hook', async () => {
  const report = freezeEvidence(diagnostic());
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const names = ['总体统计', '会话与明细', '工具与协作', '会话', '中断', '延迟', '数据接入'];
  function press(name, key, expected) {
    let focused = null;
    let prevented = false;
    const current = tab(h.render(), name);
    current.props.onKeyDown({ key, preventDefault() { prevented = true; }, currentTarget: {
      parentElement: { querySelectorAll(selector) {
        assert.equal(selector, '[role="tab"]');
        return names.map(label => ({ focus() { focused = label; } }));
      } },
    } });
    const tree = h.render();
    assert.equal(prevented, expected !== null);
    assert.equal(focused, expected);
    const selected = expected ?? name;
    assert.equal(tab(tree, selected).props['aria-selected'], true);
    for (const label of names) assert.equal(tab(tree, label).props.tabIndex, label === selected ? 0 : -1);
    const panel = elements(tree, node => node.props.role === 'tabpanel')[0];
    assert.equal(panel.props.id, tab(tree, selected).props['aria-controls']);
    assert.equal(panel.props['aria-labelledby'], tab(tree, selected).props.id);
    unchanged();
  }
  press('总体统计', 'End', '数据接入');
  press('数据接入', 'ArrowRight', '总体统计');
  press('总体统计', 'ArrowLeft', '数据接入');
  press('数据接入', 'Home', '总体统计');
  for (let index = 0; index < names.length - 1; index++) press(names[index], 'ArrowRight', names[index + 1]);
  for (let index = names.length - 1; index > 0; index--) press(names[index], 'ArrowLeft', names[index - 1]);
  press('总体统计', 'Tab', null);
});

test('Hook metadata stays escaped and metadata-only, including unknown agent labels and sensitive extra payload fields', async () => {
  const payload = '<script>hook-metadata</script>';
  const report = freezeEvidence(diagnostic({ hooks: { status: 'available', reason: payload, skippedLines: 0,
    agents: [hookAgentSummary({ agent: '__proto__' })],
    events: [hookEvent({ agent: '__proto__', id: payload, sessionId: payload, callId: payload, tool: payload,
      errorType: payload, model: payload, subagent: payload, prompt: 'PRIVATE_PROMPT_SENTINEL',
      toolInput: 'PRIVATE_INPUT_SENTINEL', toolOutput: 'PRIVATE_OUTPUT_SENTINEL', tokens: 999999, durationMs: 777777, score: 666666 })],
  } }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const tree = selectTab(h, '会话与明细');
  assert.match(text(region(tree, 'Hook Agent 汇总')), /__proto__/);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /&lt;script&gt;hook-metadata&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|PRIVATE_|999999|777777|666666/);
  assert.deepEqual(elements(region(tree, 'Hook Agent 汇总'), node => node.type === 'button' || node.type === 'a'), []);
  assert.deepEqual(elements(region(tree, 'Hook 事件元数据'), node => node.type === 'button').map(node => node.props['aria-label']), [`查看 Hook 证据 ${payload}`]);
  assert.equal(elements(tree, node => node.type === 'a').length, 0);
  assertNoDemo(html);
  unchanged();
});

test('Hook refresh retains old evidence on failure and keeps local filters across new independent metadata reports', async () => {
  const old = diagnostic({ hooks: { status: 'available', reason: 'Old hook coverage', skippedLines: 0,
    agents: [hookAgentSummary({ events: 1 })], events: [hookEvent({ id: 'retained-hook', kind: 'tool_start' })] } });
  const next = diagnostic({ hooks: { status: 'truncated', reason: 'New hook coverage', skippedLines: 3,
    agents: [hookAgentSummary({ agent: 'other-agent', events: 1 })], events: [hookEvent({ agent: 'other-agent', id: 'new-hook', kind: 'tool_start' })] } });
  let refreshes = 0;
  const h = harness(async refresh => {
    if (!refresh) return old;
    if (++refreshes === 1) throw new Error('PRIVATE_HOOK_REFRESH_ERROR');
    return next;
  });
  h.render(); h.mount(); await settle();
  selectTab(h, '会话与明细');
  change(h, '筛选 Hook Agent', 'qoder');
  change(h, '筛选 Hook 类型', 'tool_start');
  await button(h.render(), '刷新诊断').props.onClick();
  assert.match(text(region(h.render(), 'Hook 事件元数据')), /retained-hook/);
  assert.match(text(h.render()), /旧结果.*Old hook coverage/s);
  await button(h.render(), '刷新诊断').props.onClick();
  let tree = h.render();
  assert.equal(control(tree, '筛选 Hook Agent').props.value, 'qoder');
  assert.equal(control(tree, '筛选 Hook 类型').props.value, 'tool_start');
  assert.match(text(tree), /New hook coverage.*跳过行数：3/s);
  assert.match(text(tree), /没有匹配的 Hook 事件/);
  button(tree, '清除 Hook 筛选').props.onClick();
  tree = h.render();
  assert.match(text(region(tree, 'Hook 事件元数据')), /new-hook/);
  assert.doesNotMatch(renderToStaticMarkup(tree), /retained-hook|PRIVATE_HOOK_REFRESH_ERROR|Old hook coverage/);
  assert.deepEqual(h.calls, [false, true, true]);
  assert.deepEqual(h.notifications, ['诊断已更新。']);
});

test('all failure shapes use the same fixed prompt on mount and refresh while old last-page evidence and KPI remain intact', async () => {
  const failures = [new Error('SENSITIVE_ERROR_SENTINEL'), 'SENSITIVE_STRING_SENTINEL', { message: 'SENSITIVE_MESSAGE_SENTINEL', reason: 'SENSITIVE_REASON_SENTINEL' }, null, new Error('')];
  for (const failure of failures) {
    for (const hadReport of [false, true]) {
      const report = freezeEvidence(diagnostic({ processes: fortyFiveProcesses(), totals: { sessions: 45, inputTokens: 1000, outputTokens: 0, unresolved: 73, critical: 50, high: 23 },
        hooks: hookCumulativeEvidence({ sessions: 7, events: 5000, prompts: 10, toolStarts: 20, turnFailures: 3, openTools: 4 }),
      }));
      const h = harness(async refresh => {
        if (hadReport && !refresh) return report;
        throw failure;
      });
      h.render(); h.mount(); await settle();
      const original = structuredClone(report);
      if (hadReport) {
        button(h.render(), '下一页').props.onClick();
        button(h.render(), '下一页').props.onClick();
        assertProcessPage(h.render(), 3, 3, report.processes.slice(40));
        await button(h.render(), '刷新诊断').props.onClick();
      }
      const tree = h.render();
      const alert = elements(tree, node => node.props.role === 'alert');
      assert.equal(alert.length, 1);
      assert.equal(text(elements(alert[0], node => node.type === 'strong')[0]), '暂时无法更新诊断，请稍后重试。');
      assert.doesNotMatch(renderToStaticMarkup(tree) + h.notifications.join(''), /SENSITIVE_|\[object Object\]|rawerror/);
      if (hadReport) {
        assertProcessPage(tree, 3, 3, report.processes.slice(40));
        assert.deepEqual(hookKpiValues(tree), ['7', '5,000', '10', '20', '3', '4']);
        assert.match(text(tree), /近 24h 未处理 73 · 已取得中断明细 0 条/);
        assert.match(text(alert[0]), /保留上次报告，不代表本次状态/);
        assert.equal(button(tree, '刷新诊断').props.disabled, false);
      } else {
        assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'));
        assert.equal(button(tree, '重试诊断').props.disabled, false);
      }
      assert.deepEqual(h.calls, hadReport ? [false, true] : [false]);
      assert.deepEqual(h.notifications, []);
      assert.deepEqual(report, original);
      assertCompactShell(tree);
      assertNoDemo(renderToStaticMarkup(tree));
      h.unmount();
    }
  }
});

function assertActivityPage(tree, name, page, pages, start, end, total) {
  const nav = pagination(tree, name);
  assert.equal(text(elements(nav, node => node.type === 'span')[0]), `${start}–${end} / ${total} 条 · 第 ${page} / ${pages} 页`);
  for (const action of ['首页', '上一页']) assert.equal(pageButton(tree, name, action).props.disabled, page === 1);
  for (const action of ['末页', '下一页']) assert.equal(pageButton(tree, name, action).props.disabled, page === pages);
  const numbers = elements(nav, node => node.type === 'button' && /^\d+$/.test(text(node)));
  assert.equal(numbers.length, Math.min(5, pages));
  assert.equal(numbers.filter(node => node.props['aria-current'] === 'page').length, 1);
  assert.equal(text(numbers.find(node => node.props['aria-current'] === 'page')), String(page));
  for (const node of numbers) {
    assert.equal(node.props['aria-label'], `${name}第 ${text(node)} 页`);
    assert(Number(text(node)) >= 1 && Number(text(node)) <= pages);
  }
  return nav;
}
function timedHooks(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => hookEvent({
    id: `event-${String(index).padStart(3, '0')}`, sessionId: 'hook-session', kind: 'tool_start', tool: 'Read', callId: `call-${index}`,
    occurredAt: new Date(Date.parse('2026-11-11T10:00:00Z') + index * 1000).toISOString(), ...overrides,
  }));
}
function hookActivityFromEvents(events) {
  const kinds = Object.keys(shared.agentHookKindLabels).map(kind => ({ kind, count: events.filter(event => event.kind === kind).length }));
  const start = Date.parse('2026-11-10T23:00:00Z');
  const bins = Array.from({ length: 12 }, (_, index) => ({
    start: new Date(start + index * 3600000).toISOString(), end: new Date(start + (index + 1) * 3600000).toISOString(),
    count: index === 11 ? events.length : 0,
    failures: index === 11 ? events.filter(event => event.kind === 'turn_failure' || event.kind === 'tool_failure' && event.interrupt !== true).length : 0,
    interrupts: index === 11 ? events.filter(event => event.interrupt === true).length : 0,
  }));
  const sessionCounts = new Map();
  for (const event of events) if (event.sessionId !== null) {
    const identity = JSON.stringify([event.agent, event.sessionId]);
    const row = sessionCounts.get(identity) ?? { agent: event.agent, events: 0, prompts: 0, toolStarts: 0, turnFailures: 0,
      firstEventAt: event.occurredAt, lastEventAt: event.occurredAt };
    row.events++;
    if (event.kind === 'prompt_submit') row.prompts++;
    if (event.kind === 'tool_start') row.toolStarts++;
    if (event.kind === 'turn_failure') row.turnFailures++;
    if (Date.parse(event.occurredAt) < Date.parse(row.firstEventAt)) row.firstEventAt = event.occurredAt;
    if (Date.parse(event.occurredAt) > Date.parse(row.lastEventAt)) row.lastEventAt = event.occurredAt;
    sessionCounts.set(identity, row);
  }
  const sessions = [...sessionCounts.values()].sort((a, b) => b.events - a.events).slice(0, 8)
    .map((row, index) => ({ key: index.toString(16).padStart(64, '0'), ...row }));
  const toolCounts = new Map();
  for (const event of events) if (event.tool !== null && ['tool_start', 'tool_end', 'tool_failure'].includes(event.kind)) {
    const row = toolCounts.get(event.tool) ?? { tool: event.tool, starts: 0, ends: 0, failures: 0, interrupts: 0, unmatched: 0 };
    if (event.kind === 'tool_start') row.starts++;
    if (event.kind === 'tool_end') row.ends++;
    if (event.kind === 'tool_failure' && event.interrupt === true) row.interrupts++;
    if (event.kind === 'tool_failure' && event.interrupt !== true) row.failures++;
    toolCounts.set(event.tool, row);
  }
  const tools = [...toolCounts.values()].map(row => ({ ...row,
    unmatched: Math.max(0, row.starts - row.ends - row.failures - row.interrupts) }))
    .sort((a, b) => b.starts + b.ends + b.failures + b.interrupts - (a.starts + a.ends + a.failures + a.interrupts) || a.tool.localeCompare(b.tool));
  const subagentCounts = new Map();
  for (const event of events) if (event.subagent !== null && (event.kind === 'subagent_start' || event.kind === 'subagent_stop')) {
    const row = subagentCounts.get(event.subagent) ?? { subagent: event.subagent, starts: 0, stops: 0 };
    if (event.kind === 'subagent_start') row.starts++; else row.stops++;
    subagentCounts.set(event.subagent, row);
  }
  return { events: events.length, range: events.length ? { start: bins[0].start, end: bins.at(-1).end } : { start: null, end: null },
    reason: 'Independent cumulative aggregate fixture', kinds, bins: events.length ? bins : [], sessions, tools,
    subagents: [...subagentCounts.values()] };
}
function hookReport(events, agents = [hookAgentSummary({ events: 5000, sessions: 99, prompts: 700, toolStarts: 800, turnFailures: 50, openTools: 12 })], activity = null) {
  const hooks = { status: 'available', reason: 'Actual bounded metadata', skippedLines: 0, agents, events };
  if (activity) hooks.history = hookHistory({ activity });
  return freezeEvidence(diagnostic({
    totals: { sessions: 99, inputTokens: 1000, outputTokens: 200, unresolved: 73, critical: 50, high: 23 }, hooks,
  }));
}

test('pageItems clamps real slices, invalid sizes and bounds without mutating frozen evidence or fabricating empty rows', () => {
  const { pageItems } = require('../src/agent-hook-activity.ts');
  const items = freezeEvidence(Array.from({ length: 13 }, (_, index) => ({ id: index })));
  assert.deepEqual(pageItems(items, 1, 5), { rows: items.slice(0, 5), page: 1, pages: 3, start: 1, end: 5, total: 13, size: 5 });
  assert.deepEqual(pageItems(items, 2, 5).rows, items.slice(5, 10));
  assert.deepEqual(pageItems(items, 999, 5), { rows: items.slice(10), page: 3, pages: 3, start: 11, end: 13, total: 13, size: 5 });
  for (const page of [0, -3, NaN, -Infinity]) assert.equal(pageItems(items, page, 5).page, 1);
  assert.equal(pageItems(items, Infinity, 5).page, 3);
  assert.equal(pageItems(items, 2.9, 5.9).page, 2);
  for (const size of [0, -1, NaN, Infinity]) assert.equal(pageItems(items, 2, size).size, 1);
  assert.deepEqual(pageItems([], 99, 10), { rows: [], page: 1, pages: 1, start: 0, end: 0, total: 0, size: 10 });
  assert.deepEqual(items.map(item => item.id), Array.from({ length: 13 }, (_, index) => index));
});

test('Hook events paginate distinct 10-row pages with accurate ranges, numbered navigation, sizes 5/10/20, resets, empty and stale bounds', async () => {
  const report = hookReport(timedHooks(53));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  let tree = selectTab(h, '会话与明细');
  const kpis = hookKpiValues(tree);
  const expected = report.hooks.events.toReversed().map(event => event.id);
  assert.equal(control(tree, 'Hook 事件每页条数').props.value, 10);
  assert.deepEqual(elements(control(tree, 'Hook 事件每页条数'), node => node.type === 'option').map(node => Number(node.props.value)), [5, 10, 20]);
  const seen = [];
  for (let page = 1; page <= 6; page++) {
    tree = h.render();
    assertActivityPage(tree, 'Hook 事件', page, 6, (page - 1) * 10 + 1, Math.min(page * 10, 53), 53);
    assert.deepEqual(hookIds(tree), expected.slice((page - 1) * 10, page * 10));
    seen.push(...hookIds(tree));
    if (page < 6) pageButton(tree, 'Hook 事件', '下一页').props.onClick();
  }
  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, 53);
  const staleNext = pageButton(h.render(), 'Hook 事件', '下一页');
  staleNext.props.onClick();
  assertActivityPage(h.render(), 'Hook 事件', 6, 6, 51, 53, 53);
  tree = change(h, 'Hook 事件每页条数', '20');
  assertActivityPage(tree, 'Hook 事件', 1, 3, 1, 20, 53);
  staleNext.props.onClick();
  assertActivityPage(h.render(), 'Hook 事件', 3, 3, 41, 53, 53);
  assert.deepEqual(hookIds(h.render()), expected.slice(40));
  pageButton(h.render(), 'Hook 事件', '上一页').props.onClick();
  assert.deepEqual(hookIds(h.render()), expected.slice(20, 40));
  pageButton(h.render(), 'Hook 事件', '首页').props.onClick();
  pageButton(h.render(), 'Hook 事件', '上一页').props.onClick();
  assertActivityPage(h.render(), 'Hook 事件', 1, 3, 1, 20, 53);
  tree = change(h, 'Hook 事件每页条数', '5');
  assertActivityPage(tree, 'Hook 事件', 1, 11, 1, 5, 53);
  pageButton(tree, 'Hook 事件', '第 4 页').props.onClick();
  assertActivityPage(h.render(), 'Hook 事件', 4, 11, 16, 20, 53);
  assert.deepEqual(hookIds(h.render()), expected.slice(15, 20));
  for (const [label, value] of [['筛选 Hook Agent', 'qoder'], ['筛选 Hook 类型', 'tool_start'], ['筛选 Hook 分类', 'tool'], ['搜索 Hook 元数据', ' Read ']]) {
    pageButton(h.render(), 'Hook 事件', '末页').props.onClick();
    tree = change(h, label, value);
    assertActivityPage(tree, 'Hook 事件', 1, 11, 1, 5, 53);
  }
  const staleLast = pageButton(h.render(), 'Hook 事件', '末页');
  tree = change(h, '搜索 Hook 元数据', 'not-recorded');
  assertActivityPage(tree, 'Hook 事件', 1, 1, 0, 0, 0);
  assert.deepEqual(hookIds(tree), []);
  assert.match(text(tree), /不代表 24h 汇总中没有此类事件/);
  staleLast.props.onClick();
  assertActivityPage(h.render(), 'Hook 事件', 1, 1, 0, 0, 0);
  button(h.render(), '清除 Hook 筛选').props.onClick();
  assertActivityPage(h.render(), 'Hook 事件', 1, 11, 1, 5, 53);
  tree = change(h, 'Hook 事件每页条数', '10');
  assertActivityPage(tree, 'Hook 事件', 1, 6, 1, 10, 53);
  assert.deepEqual(hookKpiValues(tree), kpis);
  unchanged();
});

test('Hook classification displays 5 of 20 types, all pages preserve actual counts, and detail navigation selects the exact class', async () => {
  const kinds = Object.keys(shared.agentHookKindLabels);
  const events = kinds.flatMap((kind, index) => timedHooks(index + 1, { kind }).map((event, n) => ({ ...event, id: `${kind}-${n}` })));
  const retained = events.slice().sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id)).slice(0, 200);
  const report = hookReport(events, undefined, hookActivityFromEvents(events));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  let tree = h.render();
  assert.equal(kinds.length, 20);
  assertActivityPage(tree, '分类统计', 1, 4, 1, 5, 20);
  assert.equal(tableRows(region(tree, 'Hook 分类统计')).length, 5);
  const all = allTablePages(h, '分类统计', 'Hook 分类统计');
  assert.deepEqual(all.map(row => elements(row, node => node.type === 'td').map(text).slice(0, 2)), kinds.map(kind => [shared.agentHookKindLabels[kind], String(events.filter(event => event.kind === kind).length)]));
  pageButton(h.render(), '分类统计', '末页').props.onClick();
  assertActivityPage(h.render(), '分类统计', 4, 4, 16, 20, 20);
  tree = change(h, '分类统计每页条数', '10');
  assertActivityPage(tree, '分类统计', 1, 2, 1, 10, 20);
  tree = change(h, '分类统计每页条数', '20');
  assertActivityPage(tree, '分类统计', 1, 1, 1, 20, 20);
  button(region(tree, 'Hook 分类统计'), `查看${shared.agentHookKindLabels.compact}`).props.onClick();
  assert.equal(tab(h.render(), '会话与明细').props['aria-selected'], true);
  assert.equal(control(h.render(), '筛选 Hook 类型').props.value, 'compact');
  const rows = allTablePages(h, 'Hook 事件', 'Hook 事件元数据');
  assert.deepEqual(rows.map(row => text(elements(row, node => node.type === 'strong')[0])), Array(retained.filter(event => event.kind === 'compact').length).fill(shared.agentHookKindLabels.compact));
  unchanged();
});

test('Hook Agent summaries paginate 5 rows with a 16-Agent cap without inventing missing cumulative totals', async () => {
  const agents = Array.from({ length: 18 }, (_, index) => hookAgentSummary({ agent: `agent-${index}`, sessions: index, events: 100 + index, prompts: index, toolStarts: index, turnFailures: index, openTools: index }));
  const report = hookReport([], agents);
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  selectTab(h, '会话与明细');
  const expectedKpis = Array(6).fill('—');
  const seen = [];
  for (let page = 1; page <= 4; page++) {
    const tree = h.render();
    assertActivityPage(tree, 'Hook Agent 汇总', page, 4, (page - 1) * 5 + 1, Math.min(page * 5, 16), 16);
    const summary = region(tree, 'Hook Agent 汇总');
    assert.equal(summary.props.tabIndex, 0);
    assert.equal(elements(summary, node => node.type === 'button' || node.type === 'a').length, 0);
    seen.push(...tableRows(summary).map(row => text(elements(row, node => node.type === 'td')[0])));
    assert.deepEqual(hookKpiValues(tree), expectedKpis);
    assert.deepEqual(hookIds(tree), []);
    if (page < 4) pageButton(tree, 'Hook Agent 汇总', '下一页').props.onClick();
  }
  assert.deepEqual(seen, agents.slice(0, 16).map(agent => agent.agent));
  pageButton(h.render(), 'Hook Agent 汇总', '下一页').props.onClick();
  assertActivityPage(h.render(), 'Hook Agent 汇总', 4, 4, 16, 16, 16);
  change(h, '筛选 Hook Agent', 'agent-0');
  assertActivityPage(h.render(), 'Hook Agent 汇总', 1, 4, 1, 5, 16);
  assert.deepEqual(hookKpiValues(h.render()), expectedKpis);
  unchanged();
});

test('Hook sessions paginate 5 independent agent-plus-ID identities and trajectory pages expose 8 chronological events without cross-source joins', async () => {
  const collisionId = 'same-session';
  const qoder = timedHooks(17, { sessionId: collisionId });
  const other = timedHooks(3, { agent: 'other-agent', sessionId: collisionId }).map(event => ({ ...event, id: `other-${event.id}` }));
  const rest = timedHooks(10).map((event, index) => ({ ...event, id: `unique-${index}`, sessionId: `unique-session-${index}` }));
  const report = freezeEvidence({ ...hookReport([...qoder, ...other, ...rest]),
    sessions: [sessionEvidence({ id: collisionId, model: 'PRIVATE_AGENTSIGHT_MODEL' })],
    interruptions: [interruption({ sessionId: collisionId, id: 'PRIVATE_AGENTSIGHT_INTERRUPT' })],
  });
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  let tree = selectTab(h, '会话与明细');
  assertActivityPage(tree, 'Hook 会话', 1, 3, 1, 5, 12);
  const rows = allTablePages(h, 'Hook 会话', 'Hook 会话列表');
  assert.equal(rows.length, 12);
  const identities = rows.map(row => elements(row, node => node.type === 'button')[0].props['aria-label'].slice('查看 Hook 会话轨迹 '.length));
  assert.equal(new Set(identities).size, 12);
  const qoderKey = JSON.stringify(['qoder', collisionId]);
  const otherKey = JSON.stringify(['other-agent', collisionId]);
  for (const [key, expectedCount, label] of [[qoderKey, 17, 'Qoder'], [otherKey, 3, 'other-agent']]) {
    const row = rows.find(row => elements(row, node => node.props['aria-label'] === `查看 Hook 会话轨迹 ${key}`).length);
    assert(row);
    assert.equal(text(elements(row, node => node.type === 'td')[0]), `${label}${collisionId}`);
    assert.equal(text(elements(row, node => node.type === 'td')[1]), String(expectedCount));
  }
  pageButton(h.render(), 'Hook 会话', '末页').props.onClick();
  assertActivityPage(h.render(), 'Hook 会话', 3, 3, 11, 12, 12);
  tree = change(h, '搜索 Hook 元数据', 'same-session');
  assertActivityPage(tree, 'Hook 会话', 1, 1, 1, 2, 2);
  button(tree, `查看 Hook 会话轨迹 ${qoderKey}`).props.onClick();
  const seen = [];
  for (let page = 1; page <= 3; page++) {
    tree = h.render();
    assertActivityPage(tree, '会话轨迹', page, 3, (page - 1) * 8 + 1, Math.min(page * 8, 17), 17);
    const timeline = elements(tree, node => node.type === 'ol' && node.props.className === 'ad-hook-timeline')[0];
    const entries = elements(timeline, node => node.type === 'li');
    assert.equal(entries.length, page === 3 ? 1 : 8);
    seen.push(...entries.map(entry => elements(entry, node => node.type === 'button')[0].props['aria-label'].slice('查看轨迹证据 '.length)));
    assert.doesNotMatch(text(timeline), /other-event|PRIVATE_AGENTSIGHT/);
    if (page < 3) pageButton(tree, '会话轨迹', '下一页').props.onClick();
  }
  assert.deepEqual(seen, qoder.map(event => event.id));
  assert.equal(new Set(seen).size, 17);
  assert.deepEqual(allTablePages(h, 'Hook 事件', 'Hook 事件元数据').map(row => elements(row, node => node.type === 'button')[0].props['aria-label']), qoder.toReversed().map(event => `查看 Hook 证据 ${event.id}`));
  const currentSessions = allTablePages(h, 'Hook 会话', 'Hook 会话列表');
  button(currentSessions, `查看 Hook 会话轨迹 ${otherKey}`).props.onClick();
  assertActivityPage(h.render(), '会话轨迹', 1, 1, 1, 3, 3);
  assert.deepEqual(hookIds(h.render()), other.toReversed().map(event => event.id));
  button(h.render(), '清除 Hook 筛选').props.onClick();
  assert.equal(elements(h.render(), node => node.type === 'ol' && node.props.className === 'ad-hook-timeline').length, 0);
  assertActivityPage(h.render(), 'Hook 会话', 1, 3, 1, 5, 12);
  unchanged();
});

test('Hook tools paginate 5 rows, preserve actual callback and interrupt counts, reset sizes and drill only an exact tool name', async () => {
  const names = ['Read', 'ReadFile', ...Array.from({ length: 11 }, (_, index) => `Tool-${String(index).padStart(2, '0')}`)];
  const events = names.flatMap((tool, index) => timedHooks(2, { tool, sessionId: `tool-session-${index}`, callId: `tool-call-${index}` }).map((event, n) => ({ ...event, id: `${tool}-${n}`, kind: n ? 'tool_end' : 'tool_start' })));
  events.push(...[
    hookEvent({ id: 'Read-failure', tool: 'Read', kind: 'tool_failure', interrupt: false }),
    hookEvent({ id: 'Read-interrupt', tool: 'Read', kind: 'tool_failure', interrupt: true }),
    hookEvent({ id: 'Read-unknown', tool: 'Read', kind: 'tool_failure', interrupt: null }),
    hookEvent({ id: 'Read-unmatched', tool: 'Read', kind: 'tool_start', callId: null }),
  ]);
  const report = hookReport(events, undefined, hookActivityFromEvents(events));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  let tree = selectTab(h, '工具与协作');
  assertActivityPage(tree, '工具统计', 1, 3, 1, 5, 13);
  assert.equal(tableRows(region(tree, 'Hook 工具统计')).length, 5);
  const rows = allTablePages(h, '工具统计', 'Hook 工具统计');
  assert.deepEqual(rows.map(row => text(elements(row, node => node.type === 'td')[0])), names);
  const read = rows[0];
  assert.deepEqual(elements(read, node => node.type === 'td').map(text), ['Read', '2', '1', '2', '1', '0', '查看明细']);
  pageButton(h.render(), '工具统计', '末页').props.onClick();
  tree = change(h, '工具统计每页条数', '10');
  assertActivityPage(tree, '工具统计', 1, 2, 1, 10, 13);
  pageButton(tree, '工具统计', '末页').props.onClick();
  tree = change(h, '工具统计每页条数', '20');
  assertActivityPage(tree, '工具统计', 1, 1, 1, 13, 13);
  button(tableRows(region(tree, 'Hook 工具统计'))[0], '查看明细').props.onClick();
  tree = h.render();
  assert.equal(tab(tree, '会话与明细').props['aria-selected'], true);
  assert.deepEqual(hookIds(tree).sort(), events.filter(event => event.tool === 'Read').map(event => event.id).sort());
  assert.doesNotMatch(text(region(tree, 'Hook 事件元数据')), /ReadFile/);
  assert.match(text(tree), /工具：Read/);
  assert.equal(control(tree, '筛选 Hook 类型').props.value, '');
  unchanged();
});

test('Hook event evidence Modal exposes only the metadata allowlist, escapes payloads, preserves null/false and navigates only exact Hook identities', async () => {
  const unsafe = '<script>metadata & only</script>';
  const event = hookEvent({ id: unsafe, agent: '__proto__', sessionId: 'matching-session', kind: 'tool_failure', callId: 'hook-call', tool: unsafe,
    errorType: unsafe, model: unsafe, subagent: unsafe, interrupt: false,
    prompt: 'PRIVATE_PROMPT', toolInput: 'PRIVATE_INPUT', toolOutput: 'PRIVATE_OUTPUT', pid: 'PRIVATE_PID',
    tokens: 999999, durationMs: 777777, score: 666666, resolved: true, summary: 'PRIVATE_SUMMARY' });
  const unrelated = hookEvent({ id: 'other-agent-evidence', agent: 'qoder', sessionId: 'matching-session' });
  const report = freezeEvidence({ ...hookReport([event, unrelated], [hookAgentSummary({ agent: '__proto__' })]),
    sessions: [sessionEvidence({ id: 'matching-session', model: 'PRIVATE_AGENTSIGHT_MODEL' })],
    interruptions: [interruption({ id: 'PRIVATE_AGENTSIGHT_INTERRUPT', sessionId: 'matching-session' })],
  });
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  selectTab(h, '会话与明细');
  button(h.render(), `查看 Hook 证据 ${unsafe}`).props.onClick();
  let tree = h.render();
  const modal = elements(tree, node => node.props.subtitle === 'Hook 事件元数据 · 只读')[0];
  assert(modal);
  assert.equal(modal.props.title, shared.agentHookKindLabels.tool_failure);
  assert.deepEqual(elements(modal, node => node.type === 'dt').map(text), ['事件 ID', 'Agent', '事件类型', '发生时间', 'Hook Session ID', 'Call ID', '工具', '错误类型', '模型', 'Subagent', 'interrupt']);
  assert.deepEqual(elements(modal, node => node.type === 'dd').map(text), [unsafe, '__proto__', 'tool_failure', '2026/11/11 19:00:00', 'matching-session', 'hook-call', unsafe, unsafe, unsafe, unsafe, 'false']);
  assert.deepEqual(elements(modal, node => node.type === 'button').map(text), ['查看 Hook 会话轨迹', '关闭']);
  assert.equal(elements(modal, node => node.type === 'a').length, 0);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /&lt;script&gt;metadata &amp; only&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|PRIVATE_|999999|777777|666666|查看关联会话|Resolve|Hide/);
  button(modal, '查看 Hook 会话轨迹').props.onClick();
  tree = h.render();
  assert.equal(tab(tree, '会话与明细').props['aria-selected'], true);
  assert.deepEqual(hookIds(tree), [unsafe]);
  assert.equal(elements(tree, node => node.props.subtitle === 'Hook 事件元数据 · 只读').length, 0);
  assert.doesNotMatch(text(tree), /PRIVATE_AGENTSIGHT|other-agent-evidence/);
  button(tree, `查看轨迹证据 ${unsafe}`).props.onClick();
  const reopened = elements(h.render(), node => node.props.subtitle === 'Hook 事件元数据 · 只读')[0];
  button(reopened, '关闭').props.onClick();
  assert.equal(elements(h.render(), node => node.props.subtitle === 'Hook 事件元数据 · 只读').length, 0);
  unchanged();
  const missing = await loaded(hookReport([hookEvent({ id: 'missing-fields' })]));
  selectTab(missing, '会话与明细');
  button(missing.render(), '查看 Hook 证据 missing-fields').props.onClick();
  const empty = elements(missing.render(), node => node.props.subtitle === 'Hook 事件元数据 · 只读')[0];
  assert.deepEqual(elements(empty, node => node.type === 'dd').map(text).slice(4), [...Array(6).fill('— · 未报告'), 'null · 未报告']);
  assert.deepEqual(elements(empty, node => node.type === 'button').map(text), ['关闭']);
  assert.deepEqual(missing.calls, [false]);
  assert.equal(missing.collectorCalls.length, 2);
});

function chart(tree, label) {
  const matches = elements(tree, node => node.type === 'section' && node.props['aria-label'] === label);
  assert.equal(matches.length, 1, `Missing or duplicate chart: ${label}`);
  return matches[0];
}
function chartImage(tree, label) {
  const matches = elements(chart(tree, label), node => node.type === 'svg');
  assert.equal(matches.length, 1);
  const interactive = elements(matches[0], node => node.props.role === 'button').length > 0;
  assert.equal(matches[0].props.role, interactive ? 'group' : 'img', 'interactive SVG must not hide keyboard targets behind an image role');
  assert(matches[0].props['aria-label'].startsWith(`${label}：`));
  return matches[0];
}

test('Hook charts use independent cumulative aggregates while chart drills remain bounded to the latest 200 details', async () => {
  const kinds = Object.keys(shared.agentHookKindLabels);
  const events = timedHooks(250).map((event, index) => ({
    ...event, kind: index < 50 ? 'turn_failure' : kinds[(index - 50) % kinds.length],
    sessionId: index < 50 ? 'excluded-session' : `chart-session-${index % 4}`,
    tool: index < 50 ? 'excluded-tool' : index % 2 ? 'ReadFile' : 'Read',
    subagent: index < 50 ? 'excluded-subagent' : 'actual-subagent',
  }));
  // Shuffle backend order: latest means timestamp order, not last array entries.
  const base = hookReport([...events.filter((_, index) => index % 2), ...events.filter((_, index) => !(index % 2))]);
  const aggregate = hookActivityFromEvents(events);
  const report = freezeEvidence({ ...base, hooks: { ...base.hooks,
    history: hookHistory({ totals: { ...hookHistory().totals, sessions: 99, events: 50000, prompts: 700, toolStarts: 800, turnFailures: 50, openTools: 12 }, activity: aggregate }),
  } });
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  let tree = h.render();
  const kpis = ['99', '50,000', '700', '800', '50', '12'];
  assert.deepEqual(hookKpiValues(tree), kpis);
  assert.match(text(button(tree, '查看 Hook 轮次失败事件')), /50 条（累计）/);
  const latest = events.slice(50);
  const classify = event => event.kind.startsWith('tool_') ? 'tool' : event.kind.startsWith('permission_') ? 'permission'
    : ['subagent_start', 'subagent_stop', 'task_created', 'task_completed', 'teammate_idle', 'elicitation', 'elicitation_result'].includes(event.kind) ? 'collaboration'
      : event.kind === 'compact' || event.kind === 'compact_completed' ? 'context' : 'session';
  const categories = [['session', '会话'], ['tool', '工具'], ['permission', '授权'], ['collaboration', '协作'], ['context', '上下文']];
  const counts = categories.map(([key]) => events.filter(event => classify(event) === key).length);
  const donut = chart(tree, '事件构成');
  assert.equal(text(elements(donut, node => node.props.className === 'ad-donut-total')[0]), '250');
  assert.equal(chartImage(tree, '事件构成').props['aria-label'], `事件构成：${categories.map(([, label], index) => `${label} ${counts[index]}`).join('，')}`);
  const slices = elements(donut, node => node.type === 'circle' && node.props.pathLength === '100');
  assert.equal(slices.length, 5);
  assert.deepEqual(slices.map(node => Number(node.props.strokeDasharray.split(' ')[0])), counts.map(count => count / 250 * 100));
  const trend = chartImage(tree, '活动趋势');
  assert.match(trend.props['aria-label'], /活动趋势：.*250$/);
  assert.doesNotMatch(text(chart(tree, '会话活动排行')), /excluded-session|chart-session/);
  assert.doesNotMatch(text(chart(tree, '工具活动排行')), /excluded-tool/);
  for (const [key, label] of categories) {
    button(chart(h.render(), '事件构成'), `查看${label}类 Hook 事件`).props.onClick();
    tree = h.render();
    assert.equal(control(tree, '筛选 Hook 分类').props.value, key);
    const actual = allTablePages(h, 'Hook 事件', 'Hook 事件元数据').map(row => elements(row, node => node.type === 'button')[0].props['aria-label'].slice('查看 Hook 证据 '.length));
    assert.deepEqual(actual, latest.filter(event => classify(event) === key).toReversed().map(event => event.id));
    assert.deepEqual(hookKpiValues(tree), kpis);
    unchanged();
    selectTab(h, '总体统计');
  }
  const bins = elements(chart(h.render(), '活动趋势'), node => node.type === 'g' && node.props.role === 'button');
  assert.equal(bins.length, 12);
  assert(bins.every(node => node.props.tabIndex === 0 && typeof node.props.onKeyDown === 'function'));
  let prevented = false;
  bins[11].props.onKeyDown({ key: 'Enter', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assertActivityPage(h.render(), 'Hook 事件', 1, 20, 1, 10, 200);
  const all = allTablePages(h, 'Hook 事件', 'Hook 事件元数据');
  assert.deepEqual(all.map(row => elements(row, node => node.type === 'button')[0].props['aria-label']), latest.toReversed().map(event => `查看 Hook 证据 ${event.id}`));
  selectTab(h, '总体统计');
  prevented = false;
  bins[0].props.onKeyDown({ key: ' ', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assertActivityPage(h.render(), 'Hook 事件', 1, 1, 0, 0, 0);
  assert.deepEqual(hookIds(h.render()), []);
  unchanged();
  selectTab(h, '总体统计');
  const targets = elements(chart(h.render(), '工具活动排行'), node => node.type === 'button');
  for (const target of targets) {
    const tool = target.props['aria-label'].slice('查看 '.length, -' Hook 明细'.length);
    target.props.onClick();
    const ids = allTablePages(h, 'Hook 事件', 'Hook 事件元数据').map(row => elements(row, node => node.type === 'button')[0].props['aria-label'].slice('查看 Hook 证据 '.length));
    assert.deepEqual(ids, latest.filter(event => event.tool === tool).toReversed().map(event => event.id));
    selectTab(h, '总体统计');
    unchanged();
  }
  tree = selectTab(h, '工具与协作');
  const collaboration = chart(tree, '子 Agent 协作');
  const collaborationCounts = ['subagent_start', 'subagent_stop'].map(kind => events.filter(event => event.kind === kind).length);
  assert.equal(text(elements(collaboration, node => node.type === 'strong')[0]), String(collaborationCounts[0] + collaborationCounts[1]));
  assert.equal(elements(collaboration, node => node.type === 'button').length, 0);
  const collaborationKinds = ['task_created', 'task_completed', 'teammate_idle', 'elicitation', 'elicitation_result'];
  const collaborationActivity = collaborationKinds.map(kind => `${shared.agentHookKindLabels[kind]} ${events.filter(event => event.kind === kind).length}`).join('，');
  assert.equal(chartImage(tree, '任务与交互').props['aria-label'], `任务与交互：${collaborationActivity}`);
  const permissionCounts = ['permission_request', 'permission_denied'].map(kind => events.filter(event => event.kind === kind).length);
  assert.equal(chartImage(tree, '授权记录').props['aria-label'], `授权记录：${shared.agentHookKindLabels.permission_request} ${permissionCounts[0]}，${shared.agentHookKindLabels.permission_denied} ${permissionCounts[1]}`);
  const compactCounts = ['compact', 'compact_completed'].map(kind => events.filter(event => event.kind === kind).length);
  assert.equal(chartImage(tree, '上下文压缩').props['aria-label'], `上下文压缩：${shared.agentHookKindLabels.compact} ${compactCounts[0]}，${shared.agentHookKindLabels.compact_completed} ${compactCounts[1]}`);
  const permissionTargets = elements(chart(tree, '授权记录'), node => node.props.role === 'button');
  permissionTargets[1].props.onClick();
  assert.equal(control(h.render(), '筛选 Hook 类型').props.value, 'permission_denied');
  assert.deepEqual(hookIds(h.render()), latest.filter(event => event.kind === 'permission_denied').toReversed().slice(0, 10).map(event => event.id));
  unchanged();
});

test('Hook charts and classifications distinguish missing cumulative evidence from a real empty aggregate', async () => {
  for (const status of ['available', 'truncated', 'invalid', 'unavailable']) {
    const report = hookReport([], status === 'available' || status === 'truncated' ? [hookAgentSummary()] : []);
    const h = await loaded(freezeEvidence({ ...report, hooks: { ...report.hooks, status } }));
    const tree = h.render();
    assert.match(text(tree), /近 24h 未处理 73 · 已取得中断明细 0 条/);
    assert.deepEqual(hookKpiValues(tree), Array(6).fill('—'), 'detail zero is not a cumulative measurement');
    assert.deepEqual(tableRows(region(tree, 'Hook 分类统计')).map(row => text(elements(row, node => node.type === 'td')[1])), Array(5).fill('—'));
    assert.equal(elements(tree, node => node.props.className?.split(' ').includes('ad-activity-chart')).length, 0);
    assert.match(text(tree), /累计统计图不可用，不能将最新明细当作全量历史/);
    assert.equal(tableRows(region(selectTab(h, '会话与明细'), 'Hook 会话列表')).length, 0);
    assert.deepEqual(hookIds(h.render()), []);
    assert.deepEqual(h.calls, [false]);
    assert.equal(h.collectorCalls.length, 2);
  }
  const emptyReport = hookReport([], [hookAgentSummary()], hookActivity(0));
  const empty = await loaded(emptyReport);
  const tree = empty.render();
  assert.deepEqual(tableRows(region(tree, 'Hook 分类统计')).map(row => text(elements(row, node => node.type === 'td')[1])), Array(5).fill('0'));
  assert.equal(text(elements(chart(tree, '事件构成'), node => node.props.className === 'ad-donut-total')[0]), '0');
  assert(elements(chart(tree, '事件构成'), node => node.type === 'circle' && node.props.pathLength).every(node => node.props.strokeDasharray === '0 100'));
  const charts = elements(tree, node => node.type === 'section' && node.props.className?.split(' ').includes('ad-activity-chart'));
  assert.doesNotMatch(charts.map(renderToStaticMarkup).join(''), /NaN|Infinity|0 ms|0 Token\/s|健康分数/);
});

function agentSightReport(count = 45, revision = 0) {
  return freezeEvidence(diagnostic({
    totals: { sessions: 999, inputTokens: 1000, outputTokens: 0, unresolved: 777, critical: 500, high: 277 },
    hooks: hookCumulativeEvidence({ sessions: 7, events: 5000, prompts: 70, toolStarts: 80, turnFailures: 5, openTools: 12 }),
    sessions: Array.from({ length: count }, (_, index) => sessionEvidence({ id: `session-r${revision}-${String(index).padStart(2, '0')}`, lastSeenAt: new Date(Date.parse('2026-11-11T10:00:00Z') + index * 1000).toISOString() })),
    interruptions: Array.from({ length: count }, (_, index) => interruption({ id: `incident-r${revision}-${index}`, type: index < 42 ? 'llm_error' : 'tool_error' })),
    latency: Array.from({ length: count }, (_, index) => ({ agent: `latency-r${revision}-${index}`, calls: index, streamingCalls: 0, ttftP95Ms: null, e2eP95Ms: index, tpsP50: 0, tpotP95Ms: null })),
  }));
}
const agentSightTables = [
  { tab: '会话', name: 'AgentSight 会话', region: '已采集会话列表', identities: report => report.sessions.toReversed().map(session => session.id), rowId: row => text(elements(row, node => node.type === 'td')[1]) },
  { tab: '中断', name: 'AgentSight 中断', region: '已采集中断元数据', identities: report => report.interruptions.map(event => event.id), rowId: row => elements(row, node => node.type === 'button')[0].props['aria-label'].slice('查看中断证据 '.length) },
  { tab: '延迟', name: '调用延迟', region: '完整 LLM 调用延迟', identities: report => report.latency.map(item => item.agent), rowId: row => text(elements(row, node => node.type === 'td')[0]) },
];
for (const spec of agentSightTables) {
  test(`${spec.name} paginates 20/20/5 distinct actual rows with accurate ranges, bounds, local actions and empty state`, async () => {
    const report = agentSightReport();
    const h = await loaded(report);
    const unchanged = assertLocalOnly(h, report);
    selectTab(h, spec.tab);
    const expected = spec.identities(report);
    const seen = [];
    for (let page = 1; page <= 3; page++) {
      const tree = h.render();
      assertActivityPage(tree, spec.name, page, 3, (page - 1) * 20 + 1, Math.min(page * 20, 45), 45);
      const list = region(tree, spec.region);
      if (spec.tab === '中断') assert.match(text(tree), /近 24h 未处理 777 · 匹配 45 \/ 已取得明细 45/);
      assert.equal(list.props.tabIndex, 0);
      const identities = tableRows(list).map(spec.rowId);
      assert.deepEqual(identities, expected.slice((page - 1) * 20, page * 20));
      seen.push(...identities);
      if (page < 3) pageButton(tree, spec.name, '下一页').props.onClick();
      unchanged();
    }
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, 45);
    pageButton(h.render(), spec.name, '下一页').props.onClick();
    assertActivityPage(h.render(), spec.name, 3, 3, 41, 45, 45);
    pageButton(h.render(), spec.name, '第 2 页').props.onClick();
    assert.deepEqual(tableRows(region(h.render(), spec.region)).map(spec.rowId), expected.slice(20, 40));
    pageButton(h.render(), spec.name, '首页').props.onClick();
    pageButton(h.render(), spec.name, '上一页').props.onClick();
    assertActivityPage(h.render(), spec.name, 1, 3, 1, 20, 45);
    if (spec.tab === '会话') {
      pageButton(h.render(), spec.name, '末页').props.onClick();
      assertActivityPage(change(h, '搜索会话 Agent / ID / Model', 'actual-agent'), spec.name, 1, 3, 1, 20, 45);
      assertActivityPage(change(h, '搜索会话 Agent / ID / Model', 'not-recorded'), spec.name, 1, 1, 0, 0, 0);
      assert.equal(tableRows(region(h.render(), spec.region)).length, 0);
      assert.match(text(h.render()), /没有匹配的会话/);
    } else if (spec.tab === '中断') {
      pageButton(h.render(), spec.name, '末页').props.onClick();
      assertActivityPage(change(h, '筛选中断类型', 'llm_error'), spec.name, 1, 3, 1, 20, 42);
      assertActivityPage(change(h, '筛选中断类型', 'not-recorded'), spec.name, 1, 1, 0, 0, 0);
      assert.equal(elements(h.render(), node => node.props['aria-label'] === spec.region).length, 0);
      assert.match(text(h.render()), /没有匹配的中断事件/);
    } else {
      const table = tableRows(region(h.render(), spec.region)).map(text);
      change(h, '对比指标', 'ttftP95Ms');
      assert.deepEqual(tableRows(region(h.render(), spec.region)).map(text), table);
    }
    unchanged();
    const empty = await loaded(agentSightReport(0));
    const tree = selectTab(empty, spec.tab);
    assertActivityPage(tree, spec.name, 1, 1, 0, 0, 0);
    assert.equal(tableRows(tree).length, 0);
    assert.deepEqual(hookKpiValues(tree), ['7', '5,000', '70', '80', '5', '12']);
    assert.match(text(selectTab(empty, '中断')), /近 24h 未处理 777 · 匹配 0 \/ 已取得明细 0/, 'empty detail pages do not erase the AgentSight full-window total');
    assert.deepEqual(empty.calls, [false]);
    assert.equal(empty.collectorCalls.length, 2);
  });
}

test('AgentSight refresh failure retains all three last pages; successful same-length and shortened reports reset each page and stale callbacks clamp', async () => {
  const reports = [agentSightReport(45, 0), agentSightReport(45, 1), agentSightReport(7, 2)];
  let stage = 0;
  const h = harness(async refresh => {
    if (!refresh) return reports[0];
    if (++stage === 1) throw new Error('PRIVATE_REFRESH_ERROR');
    return reports[stage - 1];
  });
  h.render(); h.mount(); await settle();
  const stale = new Map();
  for (const spec of agentSightTables) {
    selectTab(h, spec.tab);
    pageButton(h.render(), spec.name, '末页').props.onClick();
    assertActivityPage(h.render(), spec.name, 3, 3, 41, 45, 45);
    stale.set(spec.name, pageButton(h.render(), spec.name, '下一页'));
  }
  await button(h.render(), '刷新诊断').props.onClick();
  for (const spec of agentSightTables) {
    const tree = selectTab(h, spec.tab);
    assertActivityPage(tree, spec.name, 3, 3, 41, 45, 45);
    assert.deepEqual(tableRows(region(tree, spec.region)).map(spec.rowId), spec.identities(reports[0]).slice(40));
    assert.deepEqual(hookKpiValues(tree), ['7', '5,000', '70', '80', '5', '12']);
    if (spec.tab === '中断') assert.match(text(tree), /近 24h 未处理 777 · 匹配 45 \/ 已取得明细 45/);
  }
  assert.deepEqual(h.notifications, []);
  for (let revision = 1; revision <= 2; revision++) {
    await button(h.render(), '刷新诊断').props.onClick();
    for (const spec of agentSightTables) {
      let tree = selectTab(h, spec.tab);
      const total = revision === 1 ? 45 : 7;
      assertActivityPage(tree, spec.name, 1, revision === 1 ? 3 : 1, 1, Math.min(20, total), total);
      assert.deepEqual(tableRows(region(tree, spec.region)).map(spec.rowId), spec.identities(reports[revision]).slice(0, 20));
      if (revision === 1) pageButton(tree, spec.name, '末页').props.onClick();
      else {
        stale.get(spec.name).props.onClick();
        tree = h.render();
        assertActivityPage(tree, spec.name, 1, 1, 1, 7, 7);
        assert.deepEqual(tableRows(region(tree, spec.region)).map(spec.rowId), spec.identities(reports[2]));
      }
      assert.doesNotMatch(renderToStaticMarkup(h.render()), /PRIVATE_REFRESH_ERROR/);
    }
  }
  assert.deepEqual(h.calls, [false, true, true, true]);
  assert.equal(h.collectorCalls.length, 7, 'only mount and explicit refresh request collector state');
  assert.deepEqual(h.notifications, ['诊断已更新。', '诊断已更新。']);
});

test('Hook refresh failure retains session/event/trajectory/summary/class/tool pages; success resets them and shortened evidence clamps stale callbacks', async () => {
  const sessionKey = JSON.stringify(['qoder', 'retained-hook-session']);
  function revision(number, short = false) {
    const sessionEvents = timedHooks(short ? 3 : 17, { sessionId: 'retained-hook-session' }).map((event, index) => ({ ...event, id: `r${number}-${event.id}`, tool: short ? 'Tool-00' : `Tool-${String(index % 13).padStart(2, '0')}` }));
    const extraSessions = short ? [] : timedHooks(11, { kind: 'prompt_submit', tool: null }).map((event, index) => ({ ...event, id: `r${number}-extra-${index}`, sessionId: `other-session-${index}` }));
    const agents = Array.from({ length: short ? 1 : 16 }, (_, index) => hookAgentSummary({ agent: index ? `agent-${index}` : 'qoder', events: number * 100 + index }));
    const events = [...sessionEvents, ...extraSessions];
    return hookReport(events, agents, hookActivityFromEvents(events));
  }
  const reports = [revision(0), revision(1), revision(2, true)];
  let refreshes = 0;
  const h = harness(async refresh => {
    if (!refresh) return reports[0];
    if (++refreshes === 1) throw new Error('PRIVATE_HOOK_REFRESH');
    return reports[refreshes - 1];
  });
  h.render(); h.mount(); await settle();
  selectTab(h, '会话与明细');
  button(allTablePages(h, 'Hook 会话', 'Hook 会话列表'), `查看 Hook 会话轨迹 ${sessionKey}`).props.onClick();
  const specs = [
    { tab: '总体统计', name: '分类统计', pages: 4, total: 20, size: 5 },
    { tab: '工具与协作', name: '工具统计', pages: 3, total: 13, size: 5 },
    { tab: '会话与明细', name: 'Hook 会话', pages: 3, total: 12, size: 5 },
    { tab: '会话与明细', name: 'Hook Agent 汇总', pages: 4, total: 16, size: 5 },
    { tab: '会话与明细', name: 'Hook 事件', pages: 2, total: 17, size: 10 },
    { tab: '会话与明细', name: '会话轨迹', pages: 3, total: 17, size: 8 },
  ];
  const stale = new Map();
  function setLastPages() {
    for (const spec of specs) {
      selectTab(h, spec.tab);
      pageButton(h.render(), spec.name, '末页').props.onClick();
      assertActivityPage(h.render(), spec.name, spec.pages, spec.pages, (spec.pages - 1) * spec.size + 1, spec.total, spec.total);
      stale.set(spec.name, pageButton(h.render(), spec.name, '下一页'));
    }
  }
  setLastPages();
  await button(h.render(), '刷新诊断').props.onClick();
  for (const spec of specs) {
    const tree = selectTab(h, spec.tab);
    assertActivityPage(tree, spec.name, spec.pages, spec.pages, (spec.pages - 1) * spec.size + 1, spec.total, spec.total);
  }
  assert(hookIds(selectTab(h, '会话与明细')).every(id => id.startsWith('r0-')));
  assert.deepEqual(h.notifications, []);
  await button(h.render(), '刷新诊断').props.onClick();
  for (const spec of specs) {
    const tree = selectTab(h, spec.tab);
    assertActivityPage(tree, spec.name, 1, spec.pages, 1, Math.min(spec.size, spec.total), spec.total);
  }
  assert(hookIds(selectTab(h, '会话与明细')).every(id => id.startsWith('r1-')));
  setLastPages();
  await button(h.render(), '刷新诊断').props.onClick();
  const shorterTotals = { '分类统计': 20, '工具统计': 1, 'Hook 会话': 1, 'Hook Agent 汇总': 1, 'Hook 事件': 3, '会话轨迹': 3 };
  for (const spec of specs) {
    let tree = selectTab(h, spec.tab);
    const total = shorterTotals[spec.name];
    const pages = Math.ceil(total / spec.size);
    assertActivityPage(tree, spec.name, 1, pages, 1, Math.min(spec.size, total), total);
    stale.get(spec.name).props.onClick();
    tree = h.render();
    assertActivityPage(tree, spec.name, pages, pages, (pages - 1) * spec.size + 1, total, total);
    assert.doesNotMatch(renderToStaticMarkup(tree), /PRIVATE_HOOK_REFRESH|r0-event|r1-event/);
  }
  assert.deepEqual(h.calls, [false, true, true, true]);
  assert.equal(h.collectorCalls.length, 7);
  assert.deepEqual(h.notifications, ['诊断已更新。', '诊断已更新。']);
});

test('latency comparison charts paginate eight real rows, retain full-data scaling, and share only local chart pages between views', async () => {
  const latency = Array.from({ length: 45 }, (_, index) => ({ agent: `measured-${index}`, calls: 1, streamingCalls: 1, ttftP95Ms: index + 1, e2eP95Ms: index + 1, tpsP50: 45 - index, tpotP95Ms: null }));
  const report = freezeEvidence(diagnostic({ latency }));
  const h = await loaded(report);
  const unchanged = assertLocalOnly(h, report);
  const seen = [];
  for (let page = 1; page <= 6; page++) {
    const tree = h.render();
    assertActivityPage(tree, '延迟对比', page, 6, (page - 1) * 8 + 1, Math.min(page * 8, 45), 45);
    const rows = elements(tree, node => node.props.className === 'ad-bar-row');
    assert.equal(rows.length, page === 6 ? 5 : 8);
    seen.push(...rows.map(row => text(elements(row, node => node.type === 'strong')[0])));
    const track = elements(rows[0], node => node.props.className === 'ad-bar-track')[0];
    assert.equal(track.props.children.props.style.width, `${((page - 1) * 8 + 1) / 45 * 100}%`);
    if (page < 6) pageButton(tree, '延迟对比', '下一页').props.onClick();
  }
  assert.deepEqual(seen, latency.map(item => item.agent));
  selectTab(h, '延迟');
  assertActivityPage(h.render(), '延迟对比', 6, 6, 41, 45, 45);
  assertActivityPage(h.render(), '调用延迟', 1, 3, 1, 20, 45);
  change(h, '对比指标', 'tpsP50');
  assertActivityPage(h.render(), '延迟对比', 6, 6, 41, 45, 45);
  unchanged();
  const empty = await loaded(diagnostic());
  assertActivityPage(empty.render(), '延迟对比', 1, 1, 0, 0, 0);
  assert.equal(elements(empty.render(), node => node.props.className === 'ad-bar-row').length, 0);
});
