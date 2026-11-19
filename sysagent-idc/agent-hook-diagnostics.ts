import { agentHookKindLabels, type AgentHookEvent, type AgentHookKind, type AgentHookReport, type AgentHookAgentSummary, type AgentHookHistory, type AgentHookHistoryActivity } from './src/agent-diagnostics-data';

export const AGENT_HOOK_LIMITS = { events: 5000, recent: 200, agents: 16 } as const;
const fields = ['event_id', 'agent', 'kind', 'occurred_at', 'session_id', 'tool', 'call_id', 'error_type', 'interrupt', 'subagent', 'model'];
const token = /^[A-Za-z0-9._:@/+\-]{1,128}$/;
const label = /^[A-Za-z0-9._:@/+ \-]{1,128}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nullable = (value: unknown, pattern: RegExp) => value === null || typeof value === 'string' && pattern.test(value);
const sanitize = (reason: string) => reason.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/</g, '＜').replace(/>/g, '＞').replace(/&/g, '＆');
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const totalKeys = ['sessions', 'events', 'prompts', 'toolStarts', 'toolEnds', 'toolFailures', 'interrupts', 'permissionDenied', 'turnFailures', 'openTools'] as const;
const categoryKeys = ['prompts', 'toolStarts', 'toolEnds', 'toolFailures', 'interrupts', 'permissionDenied', 'turnFailures'] as const;
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const activityKeys = ['events', 'range', 'reason', 'kinds', 'bins', 'sessions', 'tools', 'subagents'];
const nonNullToken = (value: unknown): value is string => typeof value === 'string' && token.test(value);
const nonNullLabel = (value: unknown): value is string => typeof value === 'string' && label.test(value);
function parseHistoryActivity(value: unknown, historyRange: { start: string | null; end: string | null }, historyEvents: number): AgentHookHistoryActivity | null {
  if (!shape(value, activityKeys) || !safeCount(value.events) || value.events > historyEvents || typeof value.reason !== 'string' || value.reason.length > 512 ||
      !shape(value.range, ['start', 'end']) || !Array.isArray(value.kinds) || !Array.isArray(value.bins) || !Array.isArray(value.sessions) ||
      !Array.isArray(value.tools) || !Array.isArray(value.subagents) || value.kinds.length !== Object.keys(agentHookKindLabels).length ||
      value.bins.length > 12 || value.sessions.length > 8 || value.tools.length > 64 || value.subagents.length > 64) return null;
  if (value.events === 0) {
    if (value.range.start !== null || value.range.end !== null || value.bins.length !== 0) return null;
  } else if (!timestamp(value.range.start) || !timestamp(value.range.end) || Date.parse(value.range.start) > Date.parse(value.range.end) ||
      historyRange.start === null || historyRange.end === null || Date.parse(value.range.start) < Date.parse(historyRange.start) ||
      Date.parse(value.range.end) > Date.parse(historyRange.end)) return null;
  const seenKinds = new Set<AgentHookKind>();
  const kinds: AgentHookHistoryActivity['kinds'] = [];
  for (const row of value.kinds) {
    if (!shape(row, ['kind', 'count']) || typeof row.kind !== 'string' || !Object.hasOwn(agentHookKindLabels, row.kind) || seenKinds.has(row.kind as AgentHookKind) || !safeCount(row.count)) return null;
    seenKinds.add(row.kind as AgentHookKind);
    kinds.push({ kind: row.kind as AgentHookKind, count: row.count });
  }
  if (kinds.reduce((sum, row) => sum + row.count, 0) !== value.events) return null;
  const bins: AgentHookHistoryActivity['bins'] = [];
  for (const row of value.bins) {
    if (!shape(row, ['start', 'end', 'count', 'failures', 'interrupts']) || !timestamp(row.start) || !timestamp(row.end) ||
        Date.parse(row.start) > Date.parse(row.end) || !safeCount(row.count) || !safeCount(row.failures) || !safeCount(row.interrupts) ||
        row.failures > row.count || row.interrupts > row.count) return null;
    bins.push({ start: row.start, end: row.end, count: row.count, failures: row.failures, interrupts: row.interrupts });
  }
  if (bins.reduce((sum, row) => sum + row.count, 0) !== value.events || bins.some((row, index) => index > 0 && Date.parse(row.start) !== Date.parse(bins[index - 1].end))) return null;
  const sessions: AgentHookHistoryActivity['sessions'] = [];
  const seenSessions = new Set<string>();
  for (const row of value.sessions) {
    if (!shape(row, ['key', 'agent', 'events', 'prompts', 'toolStarts', 'turnFailures', 'firstEventAt', 'lastEventAt']) ||
        typeof row.key !== 'string' || !/^[a-f0-9]{64}$/.test(row.key) || seenSessions.has(row.key) || typeof row.agent !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(row.agent) ||
        !safeCount(row.events) || !safeCount(row.prompts) || !safeCount(row.toolStarts) || !safeCount(row.turnFailures) ||
        row.prompts > row.events || row.toolStarts > row.events || row.turnFailures > row.events || !timestamp(row.firstEventAt) || !timestamp(row.lastEventAt) ||
        Date.parse(row.firstEventAt) > Date.parse(row.lastEventAt)) return null;
    seenSessions.add(row.key);
    sessions.push({ key: row.key, agent: row.agent, events: row.events, prompts: row.prompts, toolStarts: row.toolStarts,
      turnFailures: row.turnFailures, firstEventAt: row.firstEventAt, lastEventAt: row.lastEventAt });
  }
  const tools: AgentHookHistoryActivity['tools'] = [];
  const seenTools = new Set<string>();
  for (const row of value.tools) {
    if (!shape(row, ['tool', 'starts', 'ends', 'failures', 'interrupts', 'unmatched']) || !nonNullToken(row.tool) || seenTools.has(row.tool) ||
        !safeCount(row.starts) || !safeCount(row.ends) || !safeCount(row.failures) || !safeCount(row.interrupts) || !safeCount(row.unmatched) || row.unmatched > row.starts) return null;
    seenTools.add(row.tool);
    tools.push({ tool: row.tool, starts: row.starts, ends: row.ends, failures: row.failures, interrupts: row.interrupts, unmatched: row.unmatched });
  }
  const subagents: AgentHookHistoryActivity['subagents'] = [];
  const seenSubagents = new Set<string>();
  for (const row of value.subagents) {
    if (!shape(row, ['subagent', 'starts', 'stops']) || !nonNullLabel(row.subagent) || seenSubagents.has(row.subagent) || !safeCount(row.starts) || !safeCount(row.stops)) return null;
    seenSubagents.add(row.subagent);
    subagents.push({ subagent: row.subagent, starts: row.starts, stops: row.stops });
  }
  return { events: value.events, range: { start: value.range.start as string | null, end: value.range.end as string | null }, reason: sanitize(value.reason),
    kinds, bins, sessions, tools, subagents };
}
function invalidHistory(sampledAt: string): AgentHookHistory {
  return { scope: 'cumulative', status: 'invalid', reason: 'Hook 历史结构、时间或总数无效，历史总数未知。',
    sampledAt: timestamp(sampledAt) ? sampledAt : '1970-01-01T00:00:00.000Z', range: { start: null, end: null },
    totals: { sessions: null, events: null, prompts: null, toolStarts: null, toolEnds: null, toolFailures: null, interrupts: null, permissionDenied: null, turnFailures: null, openTools: null }, activity: null };
}
function parseHistory(value: unknown, fallbackAt: string): AgentHookHistory {
  const invalid = () => invalidHistory(fallbackAt);
  if (!shape(value, ['scope', 'status', 'reason', 'sampledAt', 'range', 'totals', 'activity']) || value.scope !== 'cumulative' ||
      !['available', 'unavailable', 'invalid', 'truncated'].includes(value.status as string) || typeof value.reason !== 'string' || value.reason.length > 512 ||
      !timestamp(value.sampledAt) || !shape(value.range, ['start', 'end']) || !shape(value.totals, [...totalKeys])) return invalid();
  const totals = value.totals;
  let activity: AgentHookHistoryActivity | null = null;
  if (value.status !== 'available') {
    if (!totalKeys.every(key => totals[key] === null) || value.range.start !== null || value.range.end !== null || value.activity !== null) return invalid();
  } else {
    if (!totalKeys.every(key => safeCount(totals[key]))) return invalid();
    const counts = totals as AgentHookHistory['totals'];
    const events = counts.events as number;
    if ((counts.sessions as number) > events || (counts.openTools as number) > (counts.toolStarts as number) ||
        counts.sessions === 0 && counts.openTools !== 0) return invalid();
    let remaining = events;
    for (const key of categoryKeys) {
      remaining -= counts[key] as number;
      if (remaining < 0) return invalid();
    }
    if (events === 0) {
      if (!totalKeys.every(key => counts[key] === 0) || value.range.start !== null || value.range.end !== null) return invalid();
    } else if (!timestamp(value.range.start) || !timestamp(value.range.end) || Date.parse(value.range.start) > Date.parse(value.range.end) ||
        Date.parse(value.range.end) > Date.parse(value.sampledAt)) return invalid();
    activity = parseHistoryActivity(value.activity, { start: value.range.start as string | null, end: value.range.end as string | null }, events);
    if (activity === null) return invalid();
  }
  return { scope: 'cumulative', status: value.status as AgentHookHistory['status'], reason: sanitize(value.reason), sampledAt: value.sampledAt,
    range: { start: value.range.start as string | null, end: value.range.end as string | null },
    totals: Object.fromEntries(totalKeys.map(key => [key, totals[key]])) as AgentHookHistory['totals'], activity };
}

function historyCoversDetails(history: AgentHookHistory, events: AgentHookEvent[]): boolean {
  if (history.status !== 'available') return true;
  if (events.length > (history.totals.events as number)) return false;
  const sessions = new Set(events.flatMap(event => event.sessionId === null ? [] : [JSON.stringify([event.agent, event.sessionId])]));
  if (sessions.size > (history.totals.sessions as number)) return false;
  const categories: Record<string, number> = Object.fromEntries(categoryKeys.map(key => [key, 0]));
  const kinds: Partial<Record<AgentHookKind, typeof categoryKeys[number]>> = { prompt_submit: 'prompts', tool_start: 'toolStarts', tool_end: 'toolEnds', permission_denied: 'permissionDenied', turn_failure: 'turnFailures' };
  for (const event of events) {
    if (history.range.start === null || history.range.end === null || Date.parse(event.occurredAt) < Date.parse(history.range.start) || Date.parse(event.occurredAt) > Date.parse(history.range.end)) return false;
    const key = event.kind === 'tool_failure' ? event.interrupt === true ? 'interrupts' : 'toolFailures' : kinds[event.kind];
    if (key) categories[key]++;
  }
  // Window-only openTools is not comparable: pairs may straddle the detail window.
  return categoryKeys.every(key => categories[key] <= (history.totals[key] as number));
}

export function parseHookEvent(value: unknown): AgentHookEvent | null {
  if (!shape(value, fields) || typeof value.event_id !== 'string' || !/^[a-f0-9]{16}$/.test(value.event_id) ||
      typeof value.agent !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.agent) || typeof value.kind !== 'string' || !Object.hasOwn(agentHookKindLabels, value.kind) ||
      typeof value.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurred_at) ||
      !Number.isFinite(Date.parse(value.occurred_at)) || new Date(value.occurred_at).toISOString() !== value.occurred_at ||
      !['session_id', 'tool', 'call_id', 'error_type'].every(key => nullable(value[key], token)) ||
      !['subagent', 'model'].every(key => nullable(value[key], label)) || value.interrupt !== null && typeof value.interrupt !== 'boolean') return null;
  return { id: value.event_id, agent: value.agent, kind: value.kind as AgentHookKind, occurredAt: value.occurred_at,
    sessionId: value.session_id as string | null, tool: value.tool as string | null, callId: value.call_id as string | null,
    errorType: value.error_type as string | null, interrupt: value.interrupt as boolean | null,
    subagent: value.subagent as string | null, model: value.model as string | null };
}

export function parseHookReport(raw: unknown, window: { start: string; end: string }): AgentHookReport {
  let history: AgentHookHistory | undefined;
  const projectedHistory = () => history === undefined ? {} : { history };
  const empty = (status: AgentHookReport['status'], reason: string): AgentHookReport => ({ status, reason, skippedLines: null, agents: [], events: [], ...projectedHistory() });
  if (raw === undefined) return empty('unavailable', '未采集 Agent Hook 元数据。');
  const hasHistory = object(raw) && Object.hasOwn(raw, 'history');
  if (!shape(raw, hasHistory ? ['status', 'reason', 'data', 'history'] : ['status', 'reason', 'data']) || !['available', 'unavailable', 'invalid', 'truncated'].includes(raw.status as string) ||
      typeof raw.reason !== 'string' || raw.reason.length > 512) return empty('invalid', 'Hook 来源结构无效，已拒绝解释。');
  if (hasHistory) history = parseHistory(raw.history, window.end);
  const reason = sanitize(raw.reason);
  if (raw.status === 'unavailable' || raw.status === 'invalid') return raw.data === null ? empty(raw.status, reason) : empty('invalid', '不可用 Hook 来源携带了数据。');
  if (!Number.isFinite(Date.parse(window.start)) || !Number.isFinite(Date.parse(window.end)) || Date.parse(window.start) > Date.parse(window.end)) return empty('invalid', 'Hook 采样窗口无效。');
  if (!shape(raw.data, ['events', 'skipped_lines']) || !Array.isArray(raw.data.events) || raw.data.events.length > AGENT_HOOK_LIMITS.events ||
      !Number.isSafeInteger(raw.data.skipped_lines) || (raw.data.skipped_lines as number) < 0) return empty('invalid', 'Hook 列表或丢弃计数无效。');
  const events: AgentHookEvent[] = [];
  const ids = new Set<string>();
  const agents = new Map<string, AgentHookEvent[]>();
  for (const value of raw.data.events) {
    const event = parseHookEvent(value);
    if (!event || ids.has(event.id) || Date.parse(event.occurredAt) < Date.parse(window.start) || Date.parse(event.occurredAt) > Date.parse(window.end))
      return empty('invalid', 'Hook 事件字段、时间窗口或唯一标识无效，已拒绝解释整个来源。');
    ids.add(event.id);
    events.push(event);
    const rows = agents.get(event.agent) ?? [];
    rows.push(event);
    agents.set(event.agent, rows);
  }
  if (history && !historyCoversDetails(history, events)) history = invalidHistory(history.sampledAt);
  if (agents.size > AGENT_HOOK_LIMITS.agents) return empty('invalid', 'Hook Agent 种类超过 16，已拒绝解释。');
  const summaries: AgentHookAgentSummary[] = [];
  for (const [agent, rows] of agents) {
    rows.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const open = new Set<string>();
    for (const row of rows) {
      if (row.callId === null || row.sessionId === null) continue;
      const key = JSON.stringify([row.sessionId, row.callId]);
      if (row.kind === 'tool_start') open.add(key);
      else if (row.kind === 'tool_end' || row.kind === 'tool_failure') open.delete(key);
    }
    const count = (kind: AgentHookKind) => rows.filter(row => row.kind === kind).length;
    summaries.push({ agent, sessions: new Set(rows.flatMap(row => row.sessionId === null ? [] : [row.sessionId])).size, events: rows.length,
      prompts: count('prompt_submit'), toolStarts: count('tool_start'), toolEnds: count('tool_end'),
      toolFailures: rows.filter(row => row.kind === 'tool_failure' && row.interrupt !== true).length,
      interrupts: rows.filter(row => row.kind === 'tool_failure' && row.interrupt === true).length,
      permissionDenied: count('permission_denied'), turnFailures: count('turn_failure'), openTools: open.size, lastEventAt: rows[rows.length - 1].occurredAt });
  }
  summaries.sort((a, b) => a.agent.localeCompare(b.agent));
  return { status: raw.status as 'available' | 'truncated', reason, skippedLines: raw.data.skipped_lines as number,
    agents: summaries, events: events.slice().sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)).reverse().slice(0, AGENT_HOOK_LIMITS.recent), ...projectedHistory() };
}
