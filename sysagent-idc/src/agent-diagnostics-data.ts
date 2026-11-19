export type AgentSourceKey = 'processes' | 'sessions' | 'interruptions' | 'interruptionCounts' | 'latency';
export type AgentSourceStatus = 'available' | 'unavailable' | 'invalid' | 'truncated';
export type AgentProcessStatus = 'healthy' | 'unhealthy' | 'hung' | 'unknown' | 'no_port' | 'offline';
export type AgentSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface AgentProcessEvidence {
  pid: number;
  name: string;
  role: string;
  status: AgentProcessStatus;
  ports: number[];
  lastCheckAt: string | null;
  latencyMs: number | null;
  parentPid: number | null;
  hasCrash: boolean;
}

export interface AgentSessionEvidence {
  id: string;
  agent: string | null;
  model: string | null;
  conversations: number;
  inputTokens: number;
  outputTokens: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface AgentInterruptionEvidence {
  id: string;
  sessionId: string | null;
  callId: string | null;
  pid: number | null;
  agent: string | null;
  type: string;
  severity: AgentSeverity;
  occurredAt: string | null;
  resolved: boolean;
}

export interface AgentLatencyEvidence {
  agent: string | null;
  calls: number;
  streamingCalls: number;
  ttftP95Ms: number | null;
  e2eP95Ms: number | null;
  tpsP50: number | null;
  tpotP95Ms: number | null;
}

export type AgentHookKind = 'session_start' | 'session_end' | 'prompt_submit' | 'tool_start' | 'tool_end' | 'tool_failure' |
  'permission_request' | 'permission_denied' | 'turn_stop' | 'turn_failure' | 'notification' | 'subagent_start' | 'subagent_stop' |
  'task_created' | 'task_completed' | 'teammate_idle' | 'elicitation' | 'elicitation_result' | 'compact' | 'compact_completed';

// Metadata-only events written by agent hook plugins (sysagent-agent-hooks); never prompts or tool I/O.
export interface AgentHookEvent {
  id: string;
  agent: string;
  kind: AgentHookKind;
  occurredAt: string;
  sessionId: string | null;
  tool: string | null;
  callId: string | null;
  errorType: string | null;
  interrupt: boolean | null;
  subagent: string | null;
  model: string | null;
}

export interface AgentHookAgentSummary {
  agent: string;
  sessions: number;
  events: number;
  prompts: number;
  toolStarts: number;
  toolEnds: number;
  toolFailures: number;
  interrupts: number;
  permissionDenied: number;
  turnFailures: number;
  openTools: number;
  lastEventAt: string;
}

export interface AgentHookHistoryActivity {
  events: number;
  range: { start: string | null; end: string | null };
  reason: string;
  kinds: { kind: AgentHookKind; count: number }[];
  bins: { start: string; end: string; count: number; failures: number; interrupts: number }[];
  sessions: { key: string; agent: string; events: number; prompts: number; toolStarts: number; turnFailures: number; firstEventAt: string; lastEventAt: string }[];
  tools: { tool: string; starts: number; ends: number; failures: number; interrupts: number; unmatched: number }[];
  subagents: { subagent: string; starts: number; stops: number }[];
}

export interface AgentHookHistory {
  scope: 'cumulative';
  status: AgentSourceStatus;
  reason: string;
  sampledAt: string;
  range: { start: string | null; end: string | null };
  totals: { [K in keyof Omit<AgentHookAgentSummary, 'agent' | 'lastEventAt'>]: number | null };
  activity: AgentHookHistoryActivity | null;
}

export interface AgentHookReport {
  status: AgentSourceStatus;
  reason: string;
  skippedLines: number | null;
  agents: AgentHookAgentSummary[];
  events: AgentHookEvent[];
  history?: AgentHookHistory;
}

export interface AgentStoredHistory {
  scope: 'all_stored';
  sampledAt: string;
  status: 'ok' | 'partial' | 'unavailable';
  coverage: { key: 'usage' | 'sessions' | 'interruptionCounts'; status: AgentSourceStatus; reason: string }[];
  totals: { sessions: number | null; calls: number | null; inputTokens: number | null; outputTokens: number | null; unresolved: number | null; critical: number | null; high: number | null };
}

export interface AgentDiagnostic {
  source: 'agentsight';
  analyzer: 'sysom-openapi';
  sampledAt: string;
  window: { start: string; end: string };
  status: 'ok' | 'partial' | 'unavailable';
  outcome: 'observed' | 'abnormal' | 'unknown';
  summary: string;
  lastScanAt: string | null;
  filteredProcesses: number | null;
  coverage: { key: AgentSourceKey; status: AgentSourceStatus; reason: string }[];
  totals: { sessions: number | null; inputTokens: number | null; outputTokens: number | null; unresolved: number | null; critical: number | null; high: number | null };
  findings: { severity: 'info' | 'warning' | 'error'; title: string; detail: string; suggestion: string }[];
  processes: AgentProcessEvidence[];
  sessions: AgentSessionEvidence[];
  interruptions: AgentInterruptionEvidence[];
  latency: AgentLatencyEvidence[];
  hooks: AgentHookReport;
  history?: AgentStoredHistory;
}

export const agentHookKindLabels: Record<AgentHookKind, string> = {
  session_start: '会话开始', session_end: '会话结束', prompt_submit: '提交提示', tool_start: '工具开始', tool_end: '工具完成',
  tool_failure: '工具失败', permission_request: '请求授权', permission_denied: '授权拒绝', turn_stop: '轮次结束',
  turn_failure: '轮次失败', notification: '通知', subagent_start: '子 Agent 开始', subagent_stop: '子 Agent 结束',
  task_created: '任务创建', task_completed: '任务完成', teammate_idle: '队友空闲', elicitation: '请求补充信息',
  elicitation_result: '补充信息结果', compact: '上下文压缩开始', compact_completed: '上下文压缩完成',
};

export const agentHookAgentLabels: Record<string, string> = { qoder: 'Qoder', 'qoder-ide': 'Qoder IDE' };

export const agentSourceLabels: Record<AgentSourceKey, string> = {
  processes: '进程探活', sessions: '会话与 Token', interruptions: '中断明细', interruptionCounts: '未处理中断汇总', latency: '调用延迟',
};

export const agentProcessLabels: Record<AgentProcessStatus, string> = {
  healthy: 'HTTP 有响应', unhealthy: '端口不可达', hung: '响应超时', unknown: '尚未检查', no_port: '无监听端口', offline: '进程已退出',
};

export const agentInterruptionLabels: Record<string, string> = {
  agent_crash: 'Agent 异常退出', llm_error: '模型调用错误', dead_loop: '循环风险', sse_truncated: '流式响应中断',
  context_overflow: '上下文超限', token_limit: 'Token 达到上限', tool_error: '工具调用错误', user_cancel: '用户取消',
};
