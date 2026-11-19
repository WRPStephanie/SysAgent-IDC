import { agentHookKindLabels } from './agent-diagnostics-data';
import type { AgentHookAgentSummary, AgentHookEvent, AgentHookKind, AgentHookReport } from './agent-diagnostics-data';

export function pageItems<T>(items: readonly T[], page: number, size: number) {
  const pageSize = Number.isFinite(size) ? Math.max(1, Math.floor(size)) : 1;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pages, Math.max(1, Number.isNaN(page) ? 1 : Math.floor(page)));
  const offset = (current - 1) * pageSize;
  const rows = items.slice(offset, offset + pageSize);
  return { rows, page: current, pages, start: total ? offset + 1 : 0, end: offset + rows.length, total, size: pageSize };
}

const totalKeys = ['sessions', 'events', 'prompts', 'toolStarts', 'toolEnds', 'toolFailures', 'interrupts',
  'permissionDenied', 'turnFailures', 'openTools'] as const;
type HookTotals = Pick<AgentHookAgentSummary, typeof totalKeys[number]>;
type CategoryKey = 'session' | 'tool' | 'permission' | 'collaboration' | 'context';

const categoryLabels: Record<CategoryKey, string> = {
  session: '会话', tool: '工具', permission: '授权', collaboration: '协作', context: '上下文',
};
const kindCategories: Record<AgentHookKind, CategoryKey> = {
  session_start: 'session', session_end: 'session', prompt_submit: 'session', turn_stop: 'session', turn_failure: 'session', notification: 'session',
  tool_start: 'tool', tool_end: 'tool', tool_failure: 'tool',
  permission_request: 'permission', permission_denied: 'permission',
  subagent_start: 'collaboration', subagent_stop: 'collaboration', task_created: 'collaboration', task_completed: 'collaboration',
  teammate_idle: 'collaboration', elicitation: 'collaboration', elicitation_result: 'collaboration',
  compact: 'context', compact_completed: 'context',
};

interface SessionActivity {
  key: string;
  agent: string;
  sessionId: string;
  events: number;
  prompts: number;
  toolStarts: number;
  turnFailures: number;
  lastEventAt: string | null;
  firstEventAt: string | null;
}
interface ToolActivity {
  tool: string;
  starts: number;
  ends: number;
  failures: number;
  interrupts: number;
  unmatched: number;
}
interface ActivityBin {
  index: number;
  label: string;
  start: string;
  end: string;
  count: number;
  failures: number;
  interrupts: number;
}
interface CumulativeSessionActivity {
  key: string;
  agent: string;
  events: number;
  prompts: number;
  toolStarts: number;
  turnFailures: number;
  firstEventAt: string;
  lastEventAt: string;
}

const timeLabel = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const timestamp = (value: string | null) => value === null ? NaN : Date.parse(value);
function compareTime(a: string | null, b: string | null) {
  const left = timestamp(a);
  const right = timestamp(b);
  if (!Number.isFinite(left)) return Number.isFinite(right) ? -1 : 0;
  if (!Number.isFinite(right)) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function metadata(event: AgentHookEvent): AgentHookEvent {
  return {
    id: event.id, agent: event.agent, kind: event.kind, occurredAt: event.occurredAt,
    sessionId: event.sessionId, tool: event.tool, callId: event.callId, errorType: event.errorType,
    interrupt: event.interrupt, subagent: event.subagent, model: event.model,
  };
}

function summary(agent: AgentHookAgentSummary): AgentHookAgentSummary {
  return {
    agent: agent.agent, sessions: agent.sessions, events: agent.events, prompts: agent.prompts,
    toolStarts: agent.toolStarts, toolEnds: agent.toolEnds, toolFailures: agent.toolFailures,
    interrupts: agent.interrupts, permissionDenied: agent.permissionDenied, turnFailures: agent.turnFailures,
    openTools: agent.openTools, lastEventAt: agent.lastEventAt,
  };
}

export function buildHookActivity(hooks: AgentHookReport | null | undefined, _window: { start: string; end: string }) {
  const usable = hooks?.status === 'available' || hooks?.status === 'truncated';
  const agents = usable ? hooks.agents.slice(0, 16).map(summary) : [];
  const events = usable ? hooks.events.map(metadata)
    .sort((a, b) => compareTime(b.occurredAt, a.occurredAt) || compareText(b.id, a.id)).slice(0, 200) : [];
  const sessionRows = new Map<string, SessionActivity>();
  for (const event of [...events].reverse()) {
    if (event.sessionId === null) continue;
    const key = JSON.stringify([event.agent, event.sessionId]);
    let row = sessionRows.get(key);
    if (!row) {
      row = { key, agent: event.agent, sessionId: event.sessionId, events: 0, prompts: 0,
        toolStarts: 0, turnFailures: 0, lastEventAt: null, firstEventAt: null };
      sessionRows.set(key, row);
    }
    row.events++;
    if (event.kind === 'prompt_submit') row.prompts++;
    if (event.kind === 'tool_start') row.toolStarts++;
    if (event.kind === 'turn_failure') row.turnFailures++;
    if (Number.isFinite(timestamp(event.occurredAt))) {
      if (row.firstEventAt === null || compareTime(event.occurredAt, row.firstEventAt) < 0) row.firstEventAt = event.occurredAt;
      if (row.lastEventAt === null || compareTime(event.occurredAt, row.lastEventAt) > 0) row.lastEventAt = event.occurredAt;
    }
  }
  const sessions = [...sessionRows.values()].sort((a, b) =>
    compareTime(b.lastEventAt, a.lastEventAt) || compareText(a.key, b.key));
  const history = hooks?.history;
  const aggregate = usable && history?.status === 'available' ? history.activity ?? null : null;
  const totals: HookTotals | null = aggregate && history ? Object.fromEntries(totalKeys.map(key => [key, history.totals[key] as number])) as HookTotals : null;
  const aggregateKinds = new Map(aggregate?.kinds.map(row => [row.kind, row.count]) ?? []);
  const kinds = (Object.entries(agentHookKindLabels) as [AgentHookKind, string][])
    .map(([kind, label]) => ({ kind, label, count: aggregateKinds.get(kind) ?? 0 }));
  const categories = (Object.entries(categoryLabels) as [CategoryKey, string][])
    .map(([key, label]) => ({ key, label, count: kinds.filter(row => kindCategories[row.kind] === key).reduce((sum, row) => sum + row.count, 0) }));
  const chartSessions: CumulativeSessionActivity[] = aggregate?.sessions.map(row => ({ ...row })) ?? [];
  const tools: ToolActivity[] = aggregate?.tools.map(row => ({ ...row })) ?? [];
  const bins: ActivityBin[] = aggregate?.bins.map((row, index) => ({ ...row, index, label: timeLabel.format(Date.parse(row.start)) })) ?? [];
  const subagents = aggregate?.subagents.map(row => ({ ...row })) ?? [];
  return { agents, events, totals, sessions, chartSessions, tools, kinds, categories, bins, subagents,
    aggregateAvailable: aggregate !== null, aggregateEvents: aggregate?.events ?? null,
    aggregateRange: aggregate?.range ?? { start: null, end: null }, aggregateReason: aggregate?.reason ?? history?.reason ?? '累计聚合不可用' };
}
