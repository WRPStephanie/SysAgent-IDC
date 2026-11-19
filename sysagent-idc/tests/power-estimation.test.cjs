'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
for (const extension of ['.ts', '.tsx']) require.extensions[extension] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  module._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
};
const { parseCollectedState } = require('../collected-state.ts');
const data = require('../src/health-data.ts');
const { rawSnapshot } = require('./fixtures.cjs');
const evidence = (content, status = 'ok') => ({ content, status });
const expectedPower = (method, cpuWatts, gpuWatts, missing = []) => ({
  method, cpuWatts, gpuWatts, missing, processes: [], unattributedCpuWatts: cpuWatts,
});
const processSample = (pid, cpu, comm = 'fixture-process', starttime = 1000 + pid) => ({ pid, starttime, comm, cpu_pct_node: cpu });
function processInput(samples = [processSample(900101, 10, 'QODER'), processSample(900202, 5)]) {
  const input = rawSnapshot();
  input.sections.cpu.total.usage_pct = 50;
  input.sections.process.top_cpu = samples;
  input.sections.gpu = gpuSection([]);
  rapl(input, 20);
  return input;
}
function assertUnknownProcesses(input) {
  const energy = parse(input).resources.energy;
  assert.deepEqual(energy.power.processes, []);
  assert.equal(energy.power.unattributedCpuWatts, energy.power.cpuWatts);
  return energy;
}
const gpu = (overrides = {}) => ({ index: 0, name: 'Fixture GPU', uuid: 'GPU-fixture', bus_id: '0000:01:00.0', util_pct: 50, mem_used_mb: 100, mem_total_mb: 8192, power_draw_w: null, power_limit_w: 200, temp_c: 50, ...overrides });
const gpuSection = (devices, overrides = {}) => ({ status: 'ok', available: true, gpu_count: devices.length, devices, ...overrides });
function raw() {
  return { schema_version: '1.1', tool: 'idc_inspect', collection: { finished_at: '2026-11-18T00:00:00Z' }, sections: {
    cpu: { status: 'ok', total: { usage_pct: 50 }, cpu_count: 4 },
    gpu: gpuSection([gpu()]),
  } };
}
function parse(input = raw(), previous, inspect = false) {
  const original = structuredClone(input);
  const prior = previous && structuredClone(previous);
  const result = parseCollectedState(input, previous, inspect, false);
  assert.deepEqual(input, original);
  assert.deepEqual(previous, prior);
  return result;
}
function calibration(values, run) {
  const names = ['SYSAGENT_CPU_FULL_LOAD_WATTS', 'SYSAGENT_GPU_FULL_LOAD_WATTS'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
    }
    return run();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
}
function rapl(input, watts = 10) {
  input.sections.energy = { status: 'ok', available: true, total_watts: watts, nr_zones: 1,
    zones: [{ name: 'package-0', label: 'CPU package 0', watts }],
  };
}

test('uncalibrated CPU and per-card GPU references use collected busy utilization, not top rows or memory', () => calibration({}, () => {
  const state = parse();
  const energy = state.resources.energy;
  assert.deepEqual(energy.quantity, { value: 110, unit: 'W' });
  assert.deepEqual(energy.power, expectedPower('estimated', 10, 100));
  assert.equal(energy.status, 'available');
  assert.equal(energy.usage, null);
  assert.deepEqual(energy.rows.map(row => [row.powerSource, row.referenceWatts]), [['gpu-model', 200], ['cpu-model', 20]]);
  assert.equal(state.resources.gpu.gpuDevices[0].powerWatts, null);
  assert(energy.rows.every(row => !row.cleanable && !row.agentId && !row.pid && !row.sessions));
  assert.equal(data.resourceUsages(state).energy, null);
  assert(!data.availableAlertTargets(state).includes('energy'));
}));

test('GPU fallback reference is per card and multi-GPU power is a sum, not highest utilization', () => calibration({}, () => {
  const input = raw();
  input.sections.gpu = gpuSection([gpu({ power_limit_w: null, util_pct: 20 }), gpu({ index: 1, util_pct: 40, power_limit_w: 300 })]);
  const state = parse(input);
  assert.equal(state.resources.gpu.usage, 40);
  assert.equal(state.resources.energy.power.gpuWatts, 150);
  assert.equal(state.resources.energy.quantity.value, 160);
  assert.deepEqual(state.resources.energy.rows.map(row => row.referenceWatts), [300, 150, 20]);
}));

test('sensors are preferred, measured zero is preserved, and mixed source labels are explicit', () => calibration({}, () => {
  const input = raw();
  input.sections.gpu = gpuSection([gpu({ power_draw_w: 35 })]);
  assert.deepEqual(parse(input).resources.energy.power, expectedPower('mixed', 10, 35));
  rapl(input);
  let energy = parse(input).resources.energy;
  assert.deepEqual(energy.power, expectedPower('measured', 10, 35));
  assert.equal(energy.quantity.value, 45);
  assert.equal(energy.rows.length, 2);
  assert(energy.rows.some(row => row.powerSource === 'rapl'));
  rapl(input, 0);
  input.sections.gpu.devices[0].power_draw_w = 0;
  energy = parse(input).resources.energy;
  assert.deepEqual(energy.power, expectedPower('measured', 0, 0));
  assert.equal(energy.quantity.value, 0);
}));

test('missing and zero utilization are distinct; VRAM and memory activity cannot substitute for GPU cores', () => calibration({}, () => {
  const input = raw();
  input.sections.cpu.total.usage_pct = 0;
  input.sections.gpu = gpuSection([gpu({ util_pct: 0 })]);
  assert.equal(parse(input).resources.energy.quantity.value, 0);
  input.sections.gpu = gpuSection([gpu({ util_pct: null, mem_util_pct: 100, mem_total_mb: 100, mem_used_mb: 100 })]);
  let energy = parse(input).resources.energy;
  assert.deepEqual(energy.power, expectedPower('estimated', 0, null, ['gpu']));
  assert.equal(energy.status, 'partial');
  assert.equal(data.formatResourceQuantity(energy), 'CPU 0 W · GPU 未知');
  input.sections = {};
  energy = parse(input).resources.energy;
  assert.deepEqual(energy.power, expectedPower('unavailable', null, null, ['cpu', 'gpu']));
  assert.equal(energy.quantity, undefined);
  assert.equal(energy.status, 'unavailable');
}));

test('incomplete cards and inventories retain only known subtotals and coverage; missing CPU never becomes zero', () => calibration({}, () => {
  const input = raw();
  input.sections.gpu = gpuSection([gpu({ power_draw_w: 40 }), gpu({ index: 1, util_pct: null })]);
  let energy = parse(input).resources.energy;
  assert.deepEqual(energy.power, expectedPower('mixed', 10, 40, ['gpu']));
  assert.equal(energy.quantity.value, 50);
  assert.equal(data.formatResourceQuantity(energy), 'CPU 10 W · GPU 40 W（部分）');
  input.sections.gpu = gpuSection([gpu({ power_draw_w: 40 })], { gpu_count: 2 });
  assert.deepEqual(parse(input).resources.energy.power.missing, ['gpu']);
  delete input.sections.cpu;
  energy = parse(input).resources.energy;
  assert.equal(energy.power.cpuWatts, null);
  assert.equal(energy.quantity.value, 40);
  assert.deepEqual(energy.power.missing, ['cpu', 'gpu']);
  input.sections = raw().sections;
  input.sections.cpu.status = 'partial';
  assert.deepEqual(parse(input).resources.energy.power.missing, ['cpu']);
}));

test('CPU fallback requires valid count or explicit calibration, and invalid references are ignored', () => calibration({}, () => {
  for (const count of [undefined, 0, -1, Infinity, 1.5, 20001]) {
    const input = raw();
    input.sections.cpu.cpu_count = count;
    assert.equal(parse(input).resources.energy.power.cpuWatts, null);
  }
  const input = raw();
  delete input.sections.cpu.cpu_count;
  calibration({ SYSAGENT_CPU_FULL_LOAD_WATTS: '80.5', SYSAGENT_GPU_FULL_LOAD_WATTS: '100' }, () => {
    const energy = parse(input).resources.energy;
    assert.equal(energy.power.cpuWatts, 40.25);
    assert.equal(energy.power.gpuWatts, 50);
  });
  for (const value of ['0', '-1', 'NaN', 'Infinity', '100001', '1e3', '100W']) calibration({ SYSAGENT_CPU_FULL_LOAD_WATTS: value, SYSAGENT_GPU_FULL_LOAD_WATTS: value }, () => {
    assert.equal(parse().resources.energy.quantity.value, 110);
  });
}));

test('partial RAPL coverage is never supplemented by a whole-CPU model', () => calibration({}, () => {
  const input = raw();
  rapl(input);
  input.sections.energy.nr_zones = 2;
  const energy = parse(input).resources.energy;
  assert.equal(energy.power.cpuWatts, 10);
  assert.deepEqual(energy.power.missing, ['cpu']);
  assert(!energy.rows.some(row => row.powerSource === 'cpu-model'));
}));

test('legacy wrapper/CSV is not accepted as schema1.1 GPU evidence', () => calibration({}, () => {
  for (const legacy of [evidence('Fixture GPU, 0000:01:00.0, N/A, 8192, 100, 35, 50'), evidence(gpuSection([gpu({ power_draw_w: 35 })]))]) {
    const input = raw();
    input.sections.gpu = legacy;
    input.resources = { gpu: legacy };
    const state = parse(input);
    assert.equal(state.resources.energy.power.gpuWatts, null);
    assert.deepEqual(state.resources.energy.power.missing, ['gpu']);
    assert.equal(state.resources.gpu.gpuDevices.length, 0);
  }
}));

test('native AI metrics replace rather than join SMI and complete GPU absence hides GPU rather than inventing zero', () => calibration({}, () => {
  const input = raw();
  input.diagnostics = { ai: evidence({ schema_version: '1.0', tool: 'ai', mode: 'native', read_only: false, status: 'ok', gpu_count: 1,
    gpu_arch: ['fixture'], gpu_devices: ['fixture'], details: [{ check: 'ECC', severity: 'OK', message: 'fixture' }], coverage: { complete: true },
    gpu_metrics: [{ index: 0, name: '', uuid: '', busId: '', utilization: 20, powerWatts: 7, powerLimitWatts: 200 }],
  }) };
  let state = parse(input, undefined, true);
  assert.equal(state.resources.energy.power.gpuWatts, 7);
  input.sections.gpu = gpuSection([]);
  Object.assign(input.diagnostics.ai.content, { gpu_count: 0, gpu_arch: [], gpu_devices: [], gpu_metrics: [], details: [] });
  state = parse(input, undefined, true);
  assert.equal(state.gpuDiagnostic.outcome, 'no_gpu');
  assert.equal(state.hasGpu, false);
  assert.deepEqual(state.resources.energy.power, expectedPower('estimated', 10, null));
  const refreshed = parse(input, state, false);
  assert.equal(refreshed.hasGpu, false, 'current successful empty SMI inventory still proves absence');
  assert.equal(refreshed.resources.energy.power.gpuWatts, null);
  assert.deepEqual(refreshed.resources.energy.power.missing, []);
  input.sections.gpu = gpuSection([], { status: 'unavailable', available: false });
  const unknown = parse(input, state, false);
  assert.equal(unknown.hasGpu, true, 'a previous AI absence cannot stand in for current hardware evidence');
  assert.equal(unknown.resources.energy.power.gpuWatts, null);
  assert.deepEqual(unknown.resources.energy.power.missing, ['gpu']);
}));

test('power provenance and calibration survive strict public query projection and schemas', () => calibration({}, () => {
  const { queryDataset, openApiContract } = require('../electron/query-data.cjs');
  const state = parse();
  const view = { state, status: {}, tasks: [] };
  const result = queryDataset(view, 'resources', new URLSearchParams('filter.id=energy&fields=id,power'));
  assert.deepEqual(result.items[0].power, state.resources.energy.power);
  const rows = queryDataset(view, 'resource-rows', new URLSearchParams('filter.resource=energy&fields=powerSource,referenceWatts'));
  assert.deepEqual(rows.items.map(row => row.powerSource), ['gpu-model', 'cpu-model']);
  const serialized = JSON.stringify(openApiContract());
  assert(serialized.includes('powerSource') && serialized.includes('cpuWatts'));
}));

test('collected power cards, read-only components and report use watts and concise truthful source labels', () => calibration({}, () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { HealthGuardPage } = require('../src/HealthGuardPage.tsx');
  const { ResourceRankings } = require('../src/ResourceRankings.tsx');
  const state = parse();
  const device = require('../src/data.ts').devices[0];
  const html = renderToStaticMarkup(React.createElement(HealthGuardPage, { state, device, loading: false, loadError: '', externalBusy: false,
    onRefresh() {}, onNavigate() {}, onNotify() {}, onBusyChange() {} }));
  const card = html.match(/data-resource="energy"[\s\S]*?<\/section>/)[0];
  assert(card.includes('110 W') && card.includes('估算功率'));
  assert(!card.includes('实测') && !card.includes('<circle') && !card.includes('预算占比'));
  const rankings = renderToStaticMarkup(React.createElement(ResourceRankings, { resource: state.resources.energy, collected: true, selectedIds: [], agentOnly: true }));
  assert(rankings.includes('功率构成') && rankings.includes('100 W') && rankings.includes('CPU · 估算'));
  const components = rankings.match(/<table aria-label="功率构成"[\s\S]*?<\/table>/)?.[0];
  assert(components, 'component table remains separate from process estimates');
  assert(!components.includes('清理') && !components.includes('checkbox') && !components.includes('只看 Agent'));
  assert(rankings.includes('checkbox') && rankings.includes('只看 Agent'));
  assert(rankings.includes('aria-label="搜索进程名称或 PID"'));
  const report = data.buildHealthReport(state, { name: 'fixture' });
  assert(report.includes('110 W') && report.includes('估算'));
  assert(!JSON.stringify(state.resources.energy).includes('Wh'));
}));

test('process watts use unrounded raw node CPU / total busy, keep CPU identities and never renormalize top_n', () => calibration({}, () => {
  const input = processInput([processSample(900101, 12.34567, 'QODER'), processSample(900202, 0.00003)]);
  input.sections.cpu.total.usage_pct = 50.12345;
  rapl(input, 20.003);
  const state = parse(input);
  const energy = state.resources.energy;
  const expected = input.sections.process.top_cpu.map(sample => 20.003 * sample.cpu_pct_node / 50.12345);
  assert.deepEqual(energy.power.processes.map(row => row.usage), expected);
  assert.deepEqual(energy.power.processes.map(row => row.quantity), expected.map(value => ({ value, unit: 'W' })));
  for (const row of energy.power.processes) {
    const cpu = state.resources.cpu.rows.find(item => item.id === row.id);
    assert(cpu);
    for (const key of ['pid', 'starttime', 'agentKind', 'name']) assert.equal(row[key], cpu[key]);
    assert(!row.cleanable && !row.defaultSelected && !row.agentId && !row.sessions);
    assert.match(row.detail, /估算/);
  }
  assert.notEqual(energy.power.processes[0].usage, 20.003 * state.resources.cpu.rows[0].usage / state.resources.cpu.usage);
  assert.equal(energy.power.unattributedCpuWatts, 20.003 - expected.reduce((sum, watts) => sum + watts, 0));
  assert(energy.power.unattributedCpuWatts > 0);
  assert.deepEqual(energy.rows.map(row => row.powerSource), ['rapl']);
  assert.equal(energy.quantity.value, 20.003, 'process estimates must not be added to component power');
  input.sections.process.top_cpu.pop();
  input.limits.top_n = 1;
  const shorter = parse(input).resources.energy;
  assert.equal(shorter.power.processes[0].usage, expected[0], 'dropping a top_n row cannot increase another process share');
  assert.equal(shorter.power.unattributedCpuWatts, 20.003 - expected[0]);
  delete input.sections.energy;
  const model = parse(input).resources.energy;
  assert.equal(model.power.processes[0].usage, model.power.cpuWatts * 12.34567 / 50.12345);
}));

test('CPU attribution sums component zones but excludes GPU watts and preserves measured provenance', () => calibration({}, () => {
  const input = processInput();
  input.sections.energy.zones.push({ name: 'package-1', label: 'CPU package 1', watts: 30 });
  input.sections.energy.nr_zones = 2;
  input.sections.energy.total_watts = 50;
  input.sections.gpu = gpuSection([gpu({ power_draw_w: 200 })]);
  const energy = parse(input).resources.energy;
  assert.equal(energy.power.cpuWatts, 50);
  assert.equal(energy.power.gpuWatts, 200);
  assert.equal(energy.power.method, 'measured', 'component provenance is not rewritten by process estimates');
  assert.deepEqual(energy.power.processes.map(row => row.usage), [10, 5]);
  assert.equal(energy.power.unattributedCpuWatts, 35);
  assert.equal(energy.quantity.value, 250);
  assert.equal(energy.rows.length, 3);
  assert(energy.rows.every(row => !row.pid && !row.cleanable));
}));

test('unusable or unknown CPU/process evidence and invalid busy never invent process zeroes', () => calibration({}, () => {
  const mutations = [
    input => { delete input.sections.cpu; },
    input => { delete input.sections.process; },
    input => { delete input.sections.process.top_cpu; },
    input => { input.sections.process.top_cpu = {}; },
    input => { input.sections.process.top_cpu = []; },
    input => { delete input.sections.energy; delete input.sections.cpu.cpu_count; },
    ...['unavailable', 'error', 'timeout', 'skipped'].flatMap(status => ['cpu', 'process'].map(key => input => { input.sections[key].status = status; })),
    ...[undefined, null, '50', NaN, Infinity, -1, 100.01].map(value => input => { input.sections.cpu.total.usage_pct = value; }),
  ];
  for (const mutate of mutations) {
    const input = processInput();
    mutate(input);
    assertUnknownProcesses(input);
  }
  for (const value of [undefined, null, '10', NaN, Infinity, -1, 100.01]) {
    assertUnknownProcesses(processInput([processSample(900101, value)]));
  }
  for (const sample of [null, { cpu_pct_node: 10 }, processSample(1, 10), processSample(900101, 10, 'Qoder', -1)]) {
    assertUnknownProcesses(processInput([sample]));
  }
  const partial = processInput();
  partial.sections.cpu.status = 'partial';
  partial.sections.process.status = 'partial';
  partial.sections.process.truncated = true;
  const energy = parse(partial).resources.energy;
  assert.deepEqual(energy.power.processes.map(row => row.usage), [4, 2], 'usable partial evidence remains an estimate, not full coverage');
  assert.equal(energy.power.unattributedCpuWatts, 14);
}));

for (const [cpuMs, processMs] of [[1000, 500], [2000, 1000], [1000, 989]]) {
  test(`CPU/process sample windows ${cpuMs}/${processMs}ms cannot authorize a process watt estimate`, () => calibration({}, () => {
    const input = processInput();
    input.sections.cpu.sample_window_ms = cpuMs;
    input.sections.process.sample_window_ms = processMs;
    assertUnknownProcesses(input);
  }));
}

test('process watts require positive matching CPU/process windows; missing or malformed windows remain unknown', () => calibration({}, () => {
  for (const value of [undefined, null, '1000', 0, -1, NaN, Infinity]) {
    for (const key of ['cpu', 'process']) {
      const input = processInput();
      input.sections[key].sample_window_ms = value;
      assertUnknownProcesses(input);
    }
    const both = processInput();
    both.sections.cpu.sample_window_ms = value;
    both.sections.process.sample_window_ms = value;
    assertUnknownProcesses(both);
  }
  for (const [cpuMs, processMs] of [[500, 500], [1000, 1000], [2000, 2000], [1000, 999], [1000, 1001]]) {
    const input = processInput();
    input.sections.cpu.sample_window_ms = cpuMs;
    input.sections.process.sample_window_ms = processMs;
    assert.deepEqual(parse(input).resources.energy.power.processes.map(row => row.usage), [4, 2]);
  }
}));

test('observed sample sums are identity-deduplicated before consistency checks, including rows outside retained Top20', () => calibration({}, () => {
  const sample = processSample(900101, 15, 'Qoder');
  const input = processInput([sample, { ...sample }]);
  input.sections.cpu.total.usage_pct = 20;
  let energy = parse(input).resources.energy;
  assert.equal(energy.power.processes.length, 1);
  assert.equal(energy.power.processes[0].usage, 15);
  assert.equal(energy.power.unattributedCpuWatts, 5);
  input.sections.process.top_cpu.push(processSample(900101, 6, 'Qoder', sample.starttime + 1));
  assertUnknownProcesses(input); // A recycled PID with a different starttime is a different observed identity.
  input.sections.process.top_cpu = Array.from({ length: 25 }, (_, index) => processSample(910000 + index, 1));
  input.sections.cpu.total.usage_pct = 24;
  assertUnknownProcesses(input); // Sum of retained Top20 alone would incorrectly look consistent.
  input.sections.cpu.total.usage_pct = 25;
  energy = parse(input).resources.energy;
  assert.equal(energy.power.processes.length, 20);
  assert(energy.power.processes.every(row => row.usage === 0.8));
  assert(Math.abs(energy.power.unattributedCpuWatts - 4) < 1e-12);
}));

test('zero busy with positive RAPL is unassignable; genuine zero power can produce observed zero estimates', () => calibration({}, () => {
  const input = processInput([processSample(900101, 0, 'Qoder')]);
  input.sections.cpu.total.usage_pct = 0;
  const idle = assertUnknownProcesses(input);
  assert.equal(idle.power.cpuWatts, 20);
  assert.equal(idle.power.unattributedCpuWatts, 20);
  rapl(input, 0);
  const zero = parse(input).resources.energy;
  assert.equal(zero.power.processes.length, 1);
  assert.equal(zero.power.processes[0].usage, 0);
  assert.deepEqual(zero.power.processes[0].quantity, { value: 0, unit: 'W' });
  assert.equal(zero.power.unattributedCpuWatts, 0);
  delete input.sections.process;
  assertUnknownProcesses(input);
  input.sections.process = { status: 'ok', top_cpu: [processSample(900101, 1)] };
  assertUnknownProcesses(input); // Zero watts does not rescue contradictory busy samples.
}));

test('SMI empty inventory and reliable AI PCI absence hide all GPU power strings without treating missing GPU evidence as absence', () => calibration({}, () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { ResourceRankings } = require('../src/ResourceRankings.tsx');
  const { HealthGuardPage } = require('../src/HealthGuardPage.tsx');
  for (const source of ['smi', 'ai']) {
    const input = processInput();
    if (source === 'ai') {
      input.sections.gpu = gpuSection([], { status: 'unavailable', available: false });
      input.diagnostics = { ai: evidence({ schema_version: '1.0', tool: 'ai', mode: 'native', read_only: false,
        status: 'ok', gpu_count: 0, gpu_arch: [], gpu_devices: [], gpu_metrics: [], details: [], coverage: { complete: true } }) };
    }
    const state = parse(input, undefined, source === 'ai');
    const energy = state.resources.energy;
    assert.equal(state.hasGpu, false);
    assert.equal(energy.power.gpuWatts, null);
    assert.deepEqual(energy.power.missing, []);
    assert.equal(energy.status, 'available');
    assert.equal(energy.quantity.value, 20);
    assert.equal(data.formatResourceQuantity(energy), 'CPU 20 W');
    assert.doesNotMatch(energy.note, /GPU/i);
    assert(energy.rows.every(row => !/gpu/i.test(`${row.id} ${row.name} ${row.detail}`)));
    const rankings = renderToStaticMarkup(React.createElement(ResourceRankings, { resource: energy, collected: true,
      selectedIds: [], agentOnly: false, onSelect() {}, onAgentOnlyChange() {}, blocked: false, busy: false }));
    assert.doesNotMatch(rankings, /GPU/i);
    const html = renderToStaticMarkup(React.createElement(HealthGuardPage, { state, device: { name: 'fixture' }, loading: false,
      loadError: '', externalBusy: false, onRefresh() {}, onNavigate() {}, onNotify() {}, onBusyChange() {} }));
    assert.doesNotMatch(html.match(/data-resource="energy"[\s\S]*?<\/section>/)[0], /GPU/i);
    assert(!html.includes('data-resource="gpu"'));
    const report = data.buildHealthReport(state, { name: 'fixture' });
    assert.doesNotMatch(report.split(`${energy.label}：`)[1].split(`${state.resources.memory.label}：`)[0], /GPU/i);
  }
  const missing = processInput();
  delete missing.sections.gpu;
  assert.equal(parse(missing).hasGpu, true);
  assert.deepEqual(parse(missing).resources.energy.power.missing, ['gpu']);
  assert.match(data.formatResourceQuantity(parse(missing).resources.energy), /GPU 未知/);
  missing.sections.gpu = gpuSection([gpu({ power_draw_w: 0 })]);
  assert.match(data.formatResourceQuantity(parse(missing).resources.energy), /GPU 0 W/);
}));

test('energy ranking uses only process estimates, applies name/PID and Agent filters before Top10, and treats queries literally', () => {
  const state = parse(processInput());
  const generic = Array.from({ length: 25 }, (_, index) => ({ id: `g-${index}`, pid: 940000 + index,
    name: `Generic-${index}`, usage: 100 - index }));
  const agents = Array.from({ length: 12 }, (_, index) => ({ id: `a-${index}`, pid: 950000 + index,
    name: index % 2 ? 'CLAUDE' : 'Qoder', usage: 20 - index, agentKind: index % 2 ? 'Claude Code' : 'Qoder' }));
  const malicious = { id: 'literal', pid: 960001, name: '<img src=x onerror="fixture()">[.*]__proto__', usage: 0.001 };
  const rows = [...agents, ...generic, malicious].reverse();
  for (const id of ['cpu', 'memory', 'disk', 'energy']) {
    const resource = { ...state.resources[id], rows: id === 'energy' ? [{ id: 'component', name: 'Qoder CPU', usage: 9999 }] : rows,
      ...(id === 'energy' ? { power: { ...state.resources.energy.power, processes: rows } } : {}) };
    const before = structuredClone(resource);
    assert.deepEqual(data.collectedRankingRows(resource, false).map(row => row.id), generic.slice(0, 10).map(row => row.id));
    assert.deepEqual(data.collectedRankingRows(resource, true).map(row => row.id), agents.slice(0, 10).map(row => row.id));
    assert.deepEqual(data.collectedRankingRows(resource, false, ' qOdEr ').map(row => row.id), agents.filter(row => row.name === 'Qoder').map(row => row.id));
    assert.deepEqual(data.collectedRankingRows(resource, true, 'ClAuDe').map(row => row.id), agents.filter(row => row.name === 'CLAUDE').map(row => row.id));
    assert.deepEqual(data.collectedRankingRows(resource, false, '40024').map(row => row.id), ['g-24']);
    assert.deepEqual(data.collectedRankingRows(resource, true, '40024'), []);
    for (const query of ['[.*]', '__proto__', 'onerror']) assert.deepEqual(data.collectedRankingRows(resource, false, query).map(row => row.id), ['literal']);
    assert.deepEqual(data.collectedRankingRows(resource, false, 'not-a-process'), []);
    assert.deepEqual(resource, before);
  }
  assert.deepEqual(data.collectedRankingRows({ ...state.resources.energy, power: undefined }, false), []);
});

test('energy component table stays read-only while estimated Agent processes are selectable and injection-safe', () => calibration({}, () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { ResourceRankings } = require('../src/ResourceRankings.tsx');
  const state = parse(processInput());
  const energy = state.resources.energy;
  energy.power.processes[0].cleanable = true;
  energy.power.processes[0].name = '<script>fixture()</script>';
  const props = { resource: energy, collected: true, selectedIds: [energy.power.processes[0].id], agentOnly: true,
    onSelect() {}, onAgentOnlyChange() {}, blocked: false, busy: false };
  const html = renderToStaticMarkup(React.createElement(ResourceRankings, props));
  const components = html.match(/<table aria-label="功率构成"[\s\S]*?<\/table>/)?.[0];
  assert(components);
  assert.doesNotMatch(components, /checkbox|选择进程|可结束/);
  assert.match(html, /aria-label="搜索进程名称或 PID"/);
  assert.match(html, /只看 Agent/);
  assert.match(html, /CPU.*功率估算/);
  assert.match(html, /&lt;script&gt;fixture\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|预算占比|Session 管理/);
  const selected = html.match(/<input[^>]*aria-label="选择进程[^>]*>/g) || [];
  assert.equal(selected.length, 1, 'Agent filtering must exclude the generic process');
  assert.match(selected[0], /checked=""/);
  assert.doesNotMatch(selected[0], /disabled=""/);
  const blocked = renderToStaticMarkup(React.createElement(ResourceRankings, { ...props, blocked: true }));
  assert.match(blocked.match(/<input[^>]*aria-label="选择进程[^>]*>/)[0], /disabled=""/);
  const all = renderToStaticMarkup(React.createElement(ResourceRankings, { ...props, agentOnly: false }));
  assert.equal((all.match(/aria-label="选择进程/g) || []).length, 2);
  assert.match(all.match(/<input[^>]*aria-label="选择进程 fixture-process[^>]*>/)[0], /disabled=""/);
}));

function uiHarness(filename, exportName, mocks = {}) {
  const React = require('react');
  const slots = [];
  let cursor = 0;
  const hooks = { ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(slots, index)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect() { cursor++; },
  };
  const absolute = path.resolve(__dirname, filename);
  const compiled = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute,
  }).outputText;
  const localRequire = createRequire(absolute);
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: absolute })(
    id => id === 'react' ? hooks : Object.hasOwn(mocks, id) ? mocks[id] : localRequire(id), module, module.exports);
  return { render(props) { cursor = 0; return module.exports[exportName](props); } };
}
function elements(element, predicate) {
  const React = require('react');
  if (Array.isArray(element)) return element.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(element)) return [];
  return [...(predicate(element) ? [element] : []), ...elements(element.props.children, predicate)];
}
function elementText(element) {
  if (Array.isArray(element)) return element.map(elementText).join('');
  return require('react').isValidElement(element) ? elementText(element.props.children) : element == null ? '' : String(element);
}
function findButton(tree, text) {
  const button = elements(tree, node => node.type === 'button' && elementText(node).includes(text))[0];
  assert(button, `missing button: ${text}`);
  return button;
}

test('energy search and selection operate on filtered estimates, never component IDs', () => calibration({}, () => {
  const state = parse(processInput());
  const resource = state.resources.energy;
  resource.power.processes.forEach(row => { row.cleanable = true; });
  const selections = [];
  const h = uiHarness('../src/ResourceRankings.tsx', 'ResourceRankings');
  const props = { resource, collected: true, color: '#e7a435', selectedIds: [], agentOnly: false, query: '',
    onQueryChange: query => { props.query = query; },
    onSelect: ids => selections.push(ids), onAgentOnlyChange() {}, blocked: false, busy: false };
  let tree = h.render(props);
  const search = elements(tree, node => node.type === 'input' && node.props['aria-label'] === '搜索进程名称或 PID')[0];
  assert(search);
  search.props.onChange({ target: { value: '00202' }, currentTarget: { value: '00202' } });
  tree = h.render(props);
  const boxes = elements(tree, node => node.type === 'input' && String(node.props['aria-label']).startsWith('选择进程'));
  assert.equal(boxes.length, 1);
  assert.match(boxes[0].props['aria-label'], /900202/);
  boxes[0].props.onChange();
  assert.deepEqual(selections.at(-1), [resource.power.processes[1].id]);
  elements(tree, node => node.type === 'input' && node.props['aria-label'] === '全选可结束进程')[0].props.onChange();
  assert.deepEqual(selections.at(-1), [resource.power.processes[1].id]);
  assert(selections.every(ids => ids.every(id => !resource.rows.some(row => row.id === id))));
}));

test('HealthGuardPage offers the same explicit process confirmation for energy and CPU; injected names are escaped and execute sends only token', async () => {
  const { renderToStaticMarkup } = require('react-dom/server');
  const { ResourceRankings } = require('../src/ResourceRankings.tsx');
  const state = calibration({}, () => parse(processInput()));
  for (const row of [...state.resources.cpu.rows, ...state.resources.energy.power.processes]) row.cleanable = true;
  for (const id of ['energy', 'cpu']) {
    const calls = [];
    const authoritativeName = '<script>never-run()</script> $(fixture)';
    const mockApi = {
      async prepareProcessCleanup(resource, ids, revision) {
        calls.push(['prepare', structuredClone({ resource, ids, revision })]);
        const row = state.resources.energy.power.processes[0];
        return { token: 'a'.repeat(64), revision: state.revision, expires_at: '2026-11-18T00:01:00Z',
          processes: [{ id: row.id, pid: row.pid, starttime: row.starttime, name: authoritativeName }] };
      },
      async executeProcessCleanup(token) {
        assert.equal(typeof token, 'string');
        calls.push(['execute', { token }]);
        return { revision: state.revision, results: [], refresh_required: true };
      },
    };
    const h = uiHarness('../src/HealthGuardPage.tsx', 'HealthGuardPage', {
      './health-api': mockApi,
      './components': { MascotLogo: () => null, Modal: ({ children }) => children },
    });
    const props = { state, device: { name: 'fixture' }, loading: false, loadError: '', externalBusy: false,
      onRefresh: async () => state, onNavigate() {}, onNotify() {}, onBusyChange() {} };
    let tree = h.render(props);
    const card = elements(tree, node => node.props['data-resource'] === id)[0];
    assert(card);
    findButton(card, '详情').props.onClick();
    tree = h.render(props);
    const ranking = elements(tree, node => node.type === ResourceRankings)[0];
    assert(ranking);
    ranking.props.onSelect([state.resources.energy.power.processes[0].id]);
    tree = h.render(props);
    const prepare = elements(tree, node => node.type === 'button' && node.props.onClick && /所选进程/.test(elementText(node)))[0];
    assert(prepare, `${id} must expose process cleanup preparation`);
    assert.equal(prepare.props.disabled, false);
    await prepare.props.onClick();
    tree = h.render(props);
    const confirmation = elements(tree, node => node.props['aria-label'] === '确认结束进程')[0];
    assert(confirmation, `${id} must require explicit confirmation`);
    assert.match(elementText(confirmation), /SIGTERM|整个进程/);
    assert.match(elementText(confirmation), /60 秒/);
    const markup = renderToStaticMarkup(confirmation);
    assert.match(markup, /&lt;script&gt;never-run\(\)&lt;\/script&gt;/);
    assert.doesNotMatch(markup, /<script>/);
    assert.deepEqual(calls, [['prepare', { resource: id, ids: [state.resources.energy.power.processes[0].id], revision: state.revision }]]);
    await findButton(confirmation, '确认结束进程').props.onClick();
    assert.deepEqual(calls[1], ['execute', { token: 'a'.repeat(64) }]);
  }
});
