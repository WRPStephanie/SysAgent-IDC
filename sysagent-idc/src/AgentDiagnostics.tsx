import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Info, LoaderCircle, RefreshCw } from 'lucide-react';
import { Modal } from './components';
import { activityBars, activityRanking, activityPagination, agentStatisticsCards, agentStatisticsCharts } from './AgentActivityCharts';
import { buildHookActivity, pageItems } from './agent-hook-activity';
import { agentSummary, formatNumber } from './agent-summary';
import { fetchAgentDiagnostic, fetchCollectorStatus } from './idc-client';
import type { CollectorStatus } from './idc-client';
import { agentHookAgentLabels, agentHookKindLabels, agentInterruptionLabels, agentProcessLabels, agentSourceLabels } from './agent-diagnostics-data';
import type { AgentDiagnostic, AgentHookEvent, AgentInterruptionEvidence, AgentProcessStatus, AgentSeverity, AgentSourceKey } from './agent-diagnostics-data';
import { localTime } from '../agent-diagnostics';

type ProcessStatus = 'normal' | 'stuck' | 'crashed' | 'offline';
type Severity = 'critical' | 'high' | 'medium';
type InterruptionType = 'agent_crash' | 'llm_error' | 'dead_loop';

interface AgentProcess {
  name: string;
  role: string;
  pid: number;
  status: ProcessStatus;
  probeLatency: string;
  probeDetail: string;
  lastScan: string;
  children: { name: string; role: string; pid: number }[];
}

interface Interruption {
  id: string;
  type: InterruptionType;
  severity: Severity;
  time: string;
  resolved: boolean;
  callId: string;
  detail: Record<string, string | number | string[]>;
}

interface AgentSession {
  id: string;
  agent: string;
  model: string;
  traces: number;
  inputTokens: number;
  outputTokens: number;
  savedTokens: number | null;
  lastActive: string;
  interruptions: Interruption[];
}

const processes: AgentProcess[] = [
  {
    name: 'OpenClaw',
    role: 'Gateway',
    pid: 6731,
    status: 'normal',
    probeLatency: '1ms',
    probeDetail: '服务监听端口且 HTTP 探活成功',
    lastScan: '21 秒前',
    children: [{ name: 'Codex', role: '客户端', pid: 3413 }],
  },
  {
    name: 'OpenClaw',
    role: 'Worker',
    pid: 7118,
    status: 'stuck',
    probeLatency: '5,325ms',
    probeDetail: '端口可连但 HTTP 探活持续超时 (5325ms): Network Error: Net...',
    lastScan: '21 秒前',
    children: [],
  },
];

const sessions: AgentSession[] = [
  {
    id: '6716d2b5-9a48-4bb2...',
    agent: 'Cosh',
    model: 'qwen-plus',
    traces: 9,
    inputTokens: 140740,
    outputTokens: 7098,
    savedTokens: null,
    lastActive: '2026/07/10 16:07:42',
    interruptions: [
      {
        id: 'int-1',
        type: 'dead_loop',
        severity: 'critical',
        time: '2026/07/10 16:07:42',
        resolved: false,
        callId: '19dce1b85c4_345_0',
        detail: {
          repeated_tools: ['run_shell_command'],
          repeat_count: 3,
          rule: 'tool_sequence_repetition',
        },
      },
    ],
  },
  {
    id: '019f49d0-bc06-7250...',
    agent: 'Cosh',
    model: 'qwen3-c...',
    traces: 2,
    inputTokens: 18242,
    outputTokens: 163,
    savedTokens: null,
    lastActive: '2026/07/10 10:17:47',
    interruptions: [],
  },
  {
    id: '019f49cf-8882-7f22...',
    agent: 'Cosh',
    model: 'qwen3-c...',
    traces: 2,
    inputTokens: 18142,
    outputTokens: 118,
    savedTokens: null,
    lastActive: '2026/07/10 10:16:22',
    interruptions: [],
  },
  {
    id: 'eea7df54b6a9a04fb3e...',
    agent: 'OpenClaw',
    model: 'qwen3.5...',
    traces: 2,
    inputTokens: 365835,
    outputTokens: 1066,
    savedTokens: null,
    lastActive: '2026/04/17 13:57:37',
    interruptions: [
      {
        id: 'int-2',
        type: 'agent_crash',
        severity: 'critical',
        time: '2026/04/17 11:12:24',
        resolved: false,
        callId: '19d996b1013_308fd_5',
        detail: {
          agent_name: 'OpenClaw',
          call_id: '19d996b1013_308fd_5',
          exe_path: '/usr/bin/node',
          pid: 198649,
          reason: 'agentic_loop_incomplete',
        },
      },
    ],
  },
  {
    id: '59f697ed68fdae9df6...',
    agent: 'Cosh',
    model: 'qwen3-c...',
    traces: 1,
    inputTokens: 0,
    outputTokens: 0,
    savedTokens: null,
    lastActive: '2026/04/27 17:20:29',
    interruptions: [
      {
        id: 'int-3',
        type: 'llm_error',
        severity: 'high',
        time: '2026/04/27 17:20:29',
        resolved: false,
        callId: '19dce1b85c4_345_0',
        detail: {
          error: 'invalid access token or token expired',
          model: 'qwen3-coder-plus',
          status_code: 401,
        },
      },
    ],
  },
  {
    id: '22c9576c-a083-4436...',
    agent: 'Cosh',
    model: 'qwen3.7...',
    traces: 1,
    inputTokens: 68463,
    outputTokens: 524,
    savedTokens: 6,
    lastActive: '2026/07/01 12:17:14',
    interruptions: [
      {
        id: 'int-4',
        type: 'dead_loop',
        severity: 'critical',
        time: '2026/07/01 12:17:11',
        resolved: false,
        callId: '104dcd61fdf594e00e...',
        detail: {
          repeated_tools: ['run_shell_command'],
          repeat_count: 3,
          rule: 'tool_sequence_repetition',
        },
      },
    ],
  },
];

const severityColors: Record<Severity, string> = { critical: '#ef4444', high: '#f29122', medium: '#d4b225' };
const severityLabels: Record<Severity, string> = { critical: '严重', high: '高危', medium: '中' };
const interruptionLabels: Record<InterruptionType, string> = {
  agent_crash: 'Agent Crash',
  llm_error: 'LLM Error',
  dead_loop: '死循环检测',
};
const statusColors: Record<ProcessStatus, string> = {
  normal: '#0fb57f',
  stuck: '#f29122',
  crashed: '#ef4444',
  offline: '#9eabbd',
};
const statusLabels: Record<ProcessStatus, string> = {
  normal: '正常',
  stuck: '响应卡住',
  crashed: '进程崩溃',
  offline: '离线',
};

export interface AgentDiagnosticsProps {
  recovered: boolean;
  onRestart: () => void;
  onNotify: (message: string) => void;
}

export function AgentDiagnostics({ recovered, onRestart, onNotify }: AgentDiagnosticsProps) {
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [selectedInterruption, setSelectedInterruption] = useState<Interruption | null>(null);
  const [restartingPid, setRestartingPid] = useState<number | null>(null);
  const [restartedPids, setRestartedPids] = useState<number[]>([]);
  const [resolvedIds, setResolvedIds] = useState<string[]>([]);
  const recoveredPids = recovered
    ? [...restartedPids, ...processes.filter((process) => process.status === 'stuck').map((process) => process.pid)]
    : restartedPids;

  function restartProcess(pid: number) {
    if (restartingPid === null) {
      setRestartingPid(pid);
      window.setTimeout(() => {
        setRestartingPid(null);
        setRestartedPids((current) => [...current, pid]);
        onNotify(`Demo 模拟重启 PID ${pid} 完成，新进程已上线。未操作真实进程。`);
        onRestart();
      }, 1200);
    }
  }

  const unresolvedCount = sessions
    .flatMap((session) => session.interruptions)
    .filter((interruption) => !interruption.resolved && !resolvedIds.includes(interruption.id)).length;

  return (
    <div className="agent-diagnostics">
      <section className="ad-stats">
        <div>
          <strong>{agentSummary.sessions}</strong>
          <span>Sessions</span>
        </div>
        <div>
          <strong className="blue">{formatNumber(agentSummary.inputTokens)}</strong>
          <span>总输入 Token</span>
        </div>
        <div>
          <strong className="green">{formatNumber(agentSummary.outputTokens)}</strong>
          <span>总输出 Token</span>
        </div>
        <div>
          <strong className="red">{agentSummary.interruptions.total}</strong>
          <span>异常中断</span>
          <div className="ad-stat-badges">
            <span className="ad-badge critical">严重 {agentSummary.interruptions.critical}</span>
            <span className="ad-badge high">高危 {agentSummary.interruptions.high}</span>
          </div>
        </div>
      </section>
      <div className="ad-section-head">
        <h2>Agent 状态</h2>
        <span>{processes.filter((process) => recoveredPids.includes(process.pid) || process.status === 'normal').length}/{processes.length} 正常</span>
      </div>
      <div className="ad-process-grid">
        {processes.map((process) => {
          const pid = process.pid;
          const stuck = process.status === 'stuck' && !recoveredPids.includes(pid);
          const restarting = restartingPid === pid;
          const status = recoveredPids.includes(pid) ? 'normal' : process.status;
          return (
            <section key={pid} className={`ad-process ${stuck ? 'stuck' : status}`}>
              <div className="ad-process-head">
                <span className="ad-status-dot" style={{ background: statusColors[status] }} />
                <strong>{process.name}</strong>
                <span className="ad-role">{process.role}</span>
                <span className="ad-process-status" style={{ color: statusColors[status] }}>{recoveredPids.includes(pid) ? '已恢复' : statusLabels[status]}</span>
              </div>
              {stuck && (
                <div className="ad-probe-detail">
                  <Info size={14} />
                  <span>{process.probeDetail}</span>
                </div>
              )}
              <div className="ad-process-meta">
                <span>PID {recoveredPids.includes(pid) ? pid + 100 : pid}</span>
                {process.probeLatency && <span className={stuck ? 'ad-latency-warn' : 'ad-latency-ok'}>{recoveredPids.includes(pid) ? '1ms' : process.probeLatency}</span>}
                <span>{process.lastScan}</span>
              </div>
              {process.children.length > 0 && (
                <details className="ad-children">
                  <summary>关联进程 ({process.children.length})</summary>
                  {process.children.map((child) => (
                    <div key={child.pid}>
                      <span className="ad-child-dot" />
                      {child.name}
                      <em>{child.role}</em>
                      <span>PID {child.pid}</span>
                    </div>
                  ))}
                </details>
              )}
              {stuck && (
                <button className="ad-restart-button" disabled={restarting} onClick={() => restartProcess(pid)}>
                  {restarting ? <LoaderCircle size={14} className="spinning" /> : <RefreshCw size={14} />}
                  {restarting ? '正在重启…' : '重启进程'}
                </button>
              )}
            </section>
          );
        })}
      </div>
      <div className="ad-section-head">
        <h2>会话列表</h2>
        <span>按最近活跃排序 · Demo 数据</span>
      </div>
      <div className="ad-session-table">
        <table>
          <thead>
            <tr>
              <th />
              <th>SESSION ID</th>
              <th>AGENT</th>
              <th>MODEL</th>
              <th>对话数</th>
              <th>输入 TOKEN</th>
              <th>输出 TOKEN</th>
              <th>最近活跃</th>
              <th>操作</th>
              <th>中断</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => {
              const hasUnresolved = session.interruptions.filter((interruption) => !interruption.resolved && !resolvedIds.includes(interruption.id)).length > 0;
              return (
                <Fragment key={session.id}>
                  <tr className={expandedSession === session.id ? 'expanded' : ''}>
                    <td>
                      <button
                        className="ad-expand-toggle"
                        aria-label={`${expandedSession === session.id ? '收起' : '展开'}${session.id}`}
                        onClick={() => setExpandedSession((current) => current === session.id ? null : session.id)}
                      >
                        {expandedSession === session.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                    <td>
                      <span className="ad-session-id">
                        {session.id}
                        <button
                          className="ad-copy"
                          aria-label="复制 Session ID"
                          onClick={() => {
                            navigator.clipboard?.writeText(session.id);
                            onNotify('Session ID 已复制（Demo）');
                          }}
                        >
                          <Copy size={11} />
                        </button>
                      </span>
                    </td>
                    <td>{session.agent}</td>
                    <td><span className="ad-model-tag">{session.model}</span></td>
                    <td>{session.traces}</td>
                    <td className="ad-token blue">{formatNumber(session.inputTokens)}</td>
                    <td className="ad-token green">{formatNumber(session.outputTokens)}</td>
                    <td className="ad-time">{session.lastActive}</td>
                    <td>
                      <button className="ad-detail-button" onClick={() => onNotify(`Session ${session.id} 详情 · Demo 不展示真实对话内容`)}>详情</button>
                    </td>
                    <td>
                      {hasUnresolved ? (
                        <button
                          className="ad-interrupt-badge"
                          style={{ background: severityColors[session.interruptions[0].severity] }}
                          onClick={() => setSelectedInterruption(session.interruptions[0])}
                        >
                          {session.interruptions.filter((interruption) => !resolvedIds.includes(interruption.id)).length}{' '}{severityLabels[session.interruptions[0].severity]}
                        </button>
                      ) : <span className="ad-no-interrupt">—</span>}
                    </td>
                  </tr>
                  {expandedSession === session.id && session.interruptions.length > 0 && (
                    <tr className="ad-interruption-row">
                      <td colSpan={10}>
                        <div className="ad-interruption-panel">
                          <div className="ad-interruption-heading">
                            <strong>Interruptions</strong>
                            <span>{session.interruptions.filter((interruption) => !resolvedIds.includes(interruption.id)).length}{' '}{'条未处理'}</span>
                          </div>
                          {session.interruptions.map((interruption) => (
                            <div key={interruption.id} className={`ad-interruption-item ${interruption.severity}`}>
                              <div className="ad-interruption-header">
                                <span className="ad-int-dot" style={{ background: severityColors[interruption.severity] }} />
                                <strong>{interruptionLabels[interruption.type]}</strong>
                                <span className="ad-int-time">{interruption.time}</span>
                                <div className="ad-int-actions">
                                  {!resolvedIds.includes(interruption.id) && (
                                    <button
                                      className="ad-resolve-button"
                                      onClick={() => {
                                        setResolvedIds((current) => [...current, interruption.id]);
                                        onNotify('已标记为已处理 · Demo');
                                      }}
                                    >
                                      Resolve
                                    </button>
                                  )}
                                  <button className="ad-hide-button" onClick={() => onNotify('已隐藏 · Demo')}>Hide</button>
                                </div>
                              </div>
                              <p className="ad-int-call">call: {interruption.callId}</p>
                              <pre className="ad-int-detail">{JSON.stringify(interruption.detail, null, 2)}</pre>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="ad-section-head">
        <h2>中断事件</h2>
        <span>{unresolvedCount} 条未处理</span>
      </div>
      <div className="ad-interrupt-summary">
        <div className="ad-interrupt-filters">
          <span>最近 24 小时</span>
          <span>全部类型</span>
          <span>全部严重度</span>
          <label className="ad-unresolved-only">
            <input type="checkbox" defaultChecked={true} />
            仅未处理
          </label>
        </div>
        {unresolvedCount === 0
          ? <p className="ad-no-events">当前筛选条件下暂无中断事件</p>
          : <p className="ad-has-events">展开会话行查看中断详情，或点击中断徽章</p>}
      </div>
      {selectedInterruption && (
        <Modal
          title={`${interruptionLabels[selectedInterruption.type]} · ${severityLabels[selectedInterruption.severity]}`}
          subtitle={`${selectedInterruption.time} · call: ${selectedInterruption.callId}`}
          onClose={() => setSelectedInterruption(null)}
          wide={true}
        >
          <div className="ad-modal-content">
            <div className="ad-modal-severity" style={{ borderColor: severityColors[selectedInterruption.severity] }}>
              <span style={{ color: severityColors[selectedInterruption.severity] }}>{severityLabels[selectedInterruption.severity]}</span>
              <strong>{interruptionLabels[selectedInterruption.type]}</strong>
              <p>
                {selectedInterruption.type === 'agent_crash'
                  ? '进程异常退出，关联未完成的 LLM 调用，通过 dmesg 分析是否由 OOM 导致。'
                  : selectedInterruption.type === 'llm_error'
                    ? '鉴权失败、限流、网关超时等 Provider 侧故障，附带 HTTP 状态码与错误信息。'
                    : 'Agent 陷入工具调用循环，Token 持续消耗但无实质进展。'}
              </p>
            </div>
            <pre className="ad-modal-json">{JSON.stringify(selectedInterruption.detail, null, 2)}</pre>
            <div className="ad-modal-actions">
              {!resolvedIds.includes(selectedInterruption.id) && (
                <button
                  className="hg-button primary"
                  onClick={() => {
                    setResolvedIds((current) => [...current, selectedInterruption.id]);
                    setSelectedInterruption(null);
                    onNotify('已标记为已处理 · Demo');
                  }}
                >
                  Resolve
                </button>
              )}
              <button className="hg-button" onClick={() => setSelectedInterruption(null)}>关闭</button>
            </div>
            <div className="ad-modal-note">
              <Info size={13} />所有数据为 Demo 样本，不代表真实 Agent 运行状态或 Token 用量。
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

const liveSeverityLabels: Record<AgentSeverity, string> = { critical: '严重', high: '高危', medium: '中', low: '低' };
const liveProcessNotes: Record<AgentProcessStatus, string> = {
  healthy: '仅表示 HTTP 有响应，不代表业务健康。',
  unhealthy: '端口不可达，未推断具体业务故障。',
  hung: '仅表示 HTTP 响应超时，不等同于死循环。',
  unknown: '暂无探活结果，不能判定业务健康。',
  no_port: '正常 CLI 可无监听端口，不据此判定故障。',
  offline: '进程已退出，不能仅据此判定崩溃。',
};
const liveExecutionLabels = { ok: '采集完成', partial: '部分采集', unavailable: '采集不可用' };
const liveCoverageLabels = { available: '可用', unavailable: '未取得数据', invalid: '数据无法使用', truncated: '明细不完整' };
const severityOrder: Record<AgentSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const processPageSize = 20;
const liveSourceKeys = Object.keys(agentSourceLabels) as AgentSourceKey[];

function liveNumber(value: number | null, missing = '—'): string {
  return value !== null && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : missing;
}

function liveLatency(value: number | null, unit: string): string {
  return value !== null && Number.isFinite(value) ? `${liveNumber(value)} ${unit}` : '— · 未采集';
}

function liveInterruptionLabel(type: string): string {
  return Object.prototype.hasOwnProperty.call(agentInterruptionLabels, type) ? agentInterruptionLabels[type] : type;
}

function liveHookAgentLabel(agent: string): string {
  return Object.prototype.hasOwnProperty.call(agentHookAgentLabels, agent) ? agentHookAgentLabels[agent] : agent;
}

function lastActivity(time: string | null): number {
  const value = time === null ? NaN : Date.parse(time);
  return Number.isFinite(value) ? value : -Infinity;
}

export function LiveAgentDiagnostics({ onNotify }: { onNotify: (message: string) => void }) {
  const [report, setReport] = useState<AgentDiagnostic | null>(null);
  const [service, setService] = useState<CollectorStatus['agent_sight'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'overview' | 'sessions' | 'interruptions' | 'latency' | 'hooks' | 'tools' | 'sources'>('overview');
  const [hookAgent, setHookAgent] = useState('');
  const [hookKind, setHookKind] = useState('');
  const [hookCategory, setHookCategory] = useState('');
  const [hookSearch, setHookSearch] = useState('');
  const [hookTool, setHookTool] = useState('');
  const [hookBin, setHookBin] = useState<number | null>(null);
  const [hookSession, setHookSession] = useState('');
  const [hookEventPage, setHookEventPage] = useState(1);
  const [hookEventSize, setHookEventSize] = useState(10);
  const [hookSessionPage, setHookSessionPage] = useState(1);
  const [hookTimelinePage, setHookTimelinePage] = useState(1);
  const [hookKindPage, setHookKindPage] = useState(1);
  const [hookKindSize, setHookKindSize] = useState(5);
  const [hookToolPage, setHookToolPage] = useState(1);
  const [hookToolSize, setHookToolSize] = useState(5);
  const [hookSummaryPage, setHookSummaryPage] = useState(1);
  const [selectedHook, setSelectedHook] = useState<AgentHookEvent | null>(null);
  const [sessionPage, setSessionPage] = useState(1);
  const [interruptionPage, setInterruptionPage] = useState(1);
  const [latencyPage, setLatencyPage] = useState(1);
  const [latencyChartPage, setLatencyChartPage] = useState(1);
  const [latencyMetric, setLatencyMetric] = useState<'e2eP95Ms' | 'ttftP95Ms' | 'tpsP50'>('e2eP95Ms');
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [selectedInterruption, setSelectedInterruption] = useState<AgentInterruptionEvidence | null>(null);
  const [processSearch, setProcessSearch] = useState('');
  const [processRole, setProcessRole] = useState('');
  const [processStatus, setProcessStatus] = useState<AgentProcessStatus | 'attention' | ''>('');
  const [processPage, setProcessPage] = useState(1);
  const [interruptionType, setInterruptionType] = useState('');
  const mounted = useRef(false);
  const requestLock = useRef(false);
  const notify = useRef(onNotify);
  const processPanel = useRef<HTMLElement | null>(null);
  notify.current = onNotify;

  async function loadServiceStatus() {
    try {
      const status = await fetchCollectorStatus();
      if (mounted.current) setService(status.agent_sight ?? null);
    } catch { if (mounted.current) setService(null); }
  }

  async function loadReport(refresh: boolean) {
    if (!mounted.current || requestLock.current) return;
    void loadServiceStatus();
    requestLock.current = true;
    setBusy(true);
    setError('');
    try {
      const nextReport = await fetchAgentDiagnostic(refresh);
      if (!mounted.current) return;
      setReport(nextReport);
      setProcessPage(1);
      resetActivityPages();
      setSessionPage(1);
      setInterruptionPage(1);
      setLatencyPage(1);
      setLatencyChartPage(1);
      setSelectedHook(null);
      setSelectedInterruption(null);
      void loadServiceStatus();
      if (refresh) notify.current('诊断已更新。');
    } catch {
      if (!mounted.current) return;
      setError('暂时无法更新诊断，请稍后重试。');
    } finally {
      requestLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void loadReport(false);
    return () => { mounted.current = false; };
  }, []);

  const query = search.trim().toLocaleLowerCase();
  const visibleSessions = report?.sessions
    .filter((session) => [session.id, session.agent, session.model].some((value) => value?.toLocaleLowerCase().includes(query)))
    .sort((a, b) => (lastActivity(b.lastSeenAt) - lastActivity(a.lastSeenAt)) || a.id.localeCompare(b.id)) ?? [];

  function sourceNote(key: AgentSourceKey): string {
    const coverage = report?.coverage.find((item) => item.key === key);
    return `${agentSourceLabels[key]}：${coverage ? liveCoverageLabels[coverage.status] : '数据范围未知'}`;
  }

  const tabs = [{ key: 'overview', label: '总体统计' }, { key: 'hooks', label: '会话与明细' }, { key: 'tools', label: '工具与协作' }, { key: 'sessions', label: '会话' }, { key: 'interruptions', label: '中断' }, { key: 'latency', label: '延迟' }, { key: 'sources', label: '数据接入' }] as const;
  const hooks = report?.hooks;
  const hookStatus = hooks?.status ?? 'unavailable';
  const hookStatusLabels = { available: 'Hook 数据可用', unavailable: '未取得 Hook 数据', invalid: 'Hook 数据无法使用', truncated: 'Hook 数据不完整' };
  const hookCoverageNote = hookStatus === 'unavailable' ? '未安装 Hook 插件或来源不可用；不能据此判断 Agent 未运行。'
    : hookStatus === 'invalid' ? '读取或校验失败，无法形成可靠的 Hook 统计；不代表没有事件。'
      : hookStatus === 'truncated' ? '已达到读取边界或跳过无效记录；以下仅为保留部分，不代表完整 24h 活动。'
        : '来源可用；仅覆盖已记录的 Hook 元数据，不代表 Agent 整体运行状态。';
  const activity = buildHookActivity(hooks, report?.window ?? { start: '', end: '' });
  const hookAgents = activity.agents;
  const hookEvents = activity.events;
  const hookAgentOptions = [...new Set([...hookAgents.map((item) => item.agent), ...hookEvents.map((event) => event.agent), ...(hookAgent ? [hookAgent] : [])])].sort();
  const categoryOf = (event: AgentHookEvent) => event.kind.startsWith('tool_') ? 'tool' : event.kind.startsWith('permission_') ? 'permission'
    : ['subagent_start', 'subagent_stop', 'task_created', 'task_completed', 'teammate_idle', 'elicitation', 'elicitation_result'].includes(event.kind) ? 'collaboration'
      : event.kind === 'compact' || event.kind === 'compact_completed' ? 'context' : 'session';
  const selectedBin = hookBin === null ? null : activity.bins[hookBin];
  const hookQuery = hookSearch.trim().toLocaleLowerCase();
  const visibleHookEvents = hookEvents.filter(event => (!hookAgent || event.agent === hookAgent) && (!hookKind || event.kind === hookKind)
    && (!hookCategory || categoryOf(event) === hookCategory) && (!hookTool || event.tool === hookTool)
    && (!hookSession || JSON.stringify([event.agent, event.sessionId]) === hookSession)
    && (!selectedBin || (Date.parse(event.occurredAt) >= Date.parse(selectedBin.start) && (Date.parse(event.occurredAt) < Date.parse(selectedBin.end) || (hookBin === activity.bins.length - 1 && Date.parse(event.occurredAt) === Date.parse(selectedBin.end)))))
    && (!hookQuery || [event.id, event.sessionId, event.callId, event.tool, event.model, event.subagent, event.errorType, agentHookKindLabels[event.kind]].some(value => value?.toLocaleLowerCase().includes(hookQuery))));
  const filteredHookSessions = activity.sessions.filter(session => (!hookAgent || session.agent === hookAgent) && (!hookQuery || session.sessionId.toLocaleLowerCase().includes(hookQuery)));
  const hookSessionRows = pageItems(filteredHookSessions, hookSessionPage, 5);
  const hookEventRows = pageItems(visibleHookEvents, hookEventPage, hookEventSize);
  const hookTimelineRows = pageItems([...visibleHookEvents].reverse(), hookTimelinePage, 8);
  const hookKindRows = pageItems(activity.kinds, hookKindPage, hookKindSize);
  const hookToolRows = pageItems(activity.tools, hookToolPage, hookToolSize);
  const hookSummaryRows = pageItems(hookAgents, hookSummaryPage, 5);
  const hookTurnFailures = activity.totals?.turnFailures ?? 0;
  const hookHasFilters = !!(hookAgent || hookKind || hookCategory || hookSearch || hookTool || hookSession || hookBin !== null);
  function resetActivityPages() {
    setHookEventPage(1); setHookSessionPage(1); setHookTimelinePage(1); setHookKindPage(1); setHookToolPage(1); setHookSummaryPage(1);
  }
  function clearHookFilters() {
    setHookAgent(''); setHookKind(''); setHookCategory(''); setHookSearch(''); setHookTool(''); setHookBin(null); setHookSession(''); resetActivityPages();
  }
  function openHookEvents(criteria: { kind?: string; category?: string; tool?: string; bin?: number; session?: string } = {}) {
    clearHookFilters(); setHookKind(criteria.kind ?? ''); setHookCategory(criteria.category ?? ''); setHookTool(criteria.tool ?? ''); setHookBin(criteria.bin ?? null); setHookSession(criteria.session ?? ''); setTab('hooks');
  }
  const hookAttention = hookTurnFailures > 0 || hookEvents.some((event) => event.kind === 'turn_failure');
  const metricLabels = { e2eP95Ms: '总耗时 P95', ttftP95Ms: '首 Token P95', tpsP50: '生成速度 P50' };
  const metricUnit = latencyMetric === 'tpsP50' ? 'Token/s' : 'ms';
  const latencyMax = Math.max(0, ...(report?.latency.map((item) => item[latencyMetric] ?? 0) ?? []));
  const pendingEvents = report?.interruptions.filter((event) => !event.resolved) ?? [];
  const attentionProcesses = report?.processes.filter((process) => process.status === 'unhealthy' || process.status === 'hung' || (process.status === 'offline' && process.hasCrash)) ?? [];
  const processQuery = processSearch.trim().toLocaleLowerCase();
  const filteredProcesses = report?.processes.filter((process) =>
    (!processQuery || process.name.toLocaleLowerCase().includes(processQuery) || String(process.pid).includes(processQuery)) &&
    (!processRole || process.role === processRole) &&
    (!processStatus || (processStatus === 'attention' ? attentionProcesses.includes(process) : process.status === processStatus))) ?? [];
  const processRoles = [...new Set([...(report?.processes.map((process) => process.role) ?? []), ...(processRole ? [processRole] : [])])].sort();
  const processPages = Math.max(1, Math.ceil(filteredProcesses.length / processPageSize));
  const currentProcessPage = Math.min(processPage, processPages);
  const pageProcesses = filteredProcesses.slice((currentProcessPage - 1) * processPageSize, currentProcessPage * processPageSize);
  const eventGroups = new Map<string, { type: string; count: number; severity: AgentSeverity }>();
  for (const event of pendingEvents) {
    const group = eventGroups.get(event.type);
    if (group) {
      group.count++;
      if (severityOrder[event.severity] < severityOrder[group.severity]) group.severity = event.severity;
    } else eventGroups.set(event.type, { type: event.type, count: 1, severity: event.severity });
  }
  const groupedEvents = [...eventGroups.values()].sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.count - a.count || a.type.localeCompare(b.type));
  const interruptionTypes = [...new Set([...(report?.interruptions.map((event) => event.type) ?? []), ...(interruptionType ? [interruptionType] : [])])];
  const visibleInterruptions = report?.interruptions.filter((event) => !interruptionType || event.type === interruptionType) ?? [];
  const conclusion = !report ? '等待诊断' : report.outcome === 'abnormal' ? '发现需关注事件' : report.status === 'ok' && report.outcome === 'observed' ? '本次证据未发现异常' : '证据不足，暂无法判断';
  const collectionLabels = { running: '采集中', disabled: '采集停用', failed: '采集失败', unavailable: '采集不可用' };
  const sessionRows = pageItems(visibleSessions, sessionPage, 20);
  const interruptionRows = pageItems(visibleInterruptions, interruptionPage, 20);
  const latencyRows = pageItems(report?.latency ?? [], latencyPage, 20);
  const latencyChartRows = pageItems(report?.latency ?? [], latencyChartPage, 8);

  function interruptionTable(events: AgentInterruptionEvidence[]) {
    return (
      <div className="ad-session-table" role="region" aria-label="已采集中断元数据" tabIndex={0}>
        <table><thead><tr><th>事件 / Agent</th><th>严重度</th><th>处理状态</th><th>发生时间</th><th>证据</th></tr></thead>
          <tbody>{events.map((event) => <tr key={event.id}>
            <td><strong>{liveInterruptionLabel(event.type)}</strong><small>{event.agent ?? '未关联'} · {event.id}</small></td>
            <td><span className={`ad-badge ${event.severity}`}>{liveSeverityLabels[event.severity]}</span></td>
            <td>{event.resolved ? '已处理（来源记录）' : '未处理'}</td><td className="ad-time">{localTime(event.occurredAt)}</td>
            <td><button className="ad-detail-button" onClick={() => setSelectedInterruption(event)} aria-label={`查看中断证据 ${event.id}`}>查看证据</button></td>
          </tr>)}</tbody>
        </table>
      </div>
    );
  }

  function latencyChart() {
    return <section className="ad-live-report ad-latency-chart" aria-label="调用延迟对比">
      <div className="ad-section-head"><h3>调用延迟对比</h3><label><span className="ad-sr-only">对比指标</span><select aria-label="对比指标" value={latencyMetric} onChange={(event) => setLatencyMetric(event.target.value as typeof latencyMetric)}>{Object.entries(metricLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
      <p className="ad-live-note">{sourceNote('latency')}</p>
      {report?.latency.length ? <div className="ad-bar-list">{latencyChartRows.rows.map((item, index) => {
        const value = item[latencyMetric];
        const measured = value !== null && Number.isFinite(value);
        const width = measured && latencyMax > 0 ? Math.max(0, Math.min(100, value / latencyMax * 100)) : 0;
        return <div className="ad-bar-row" key={index}><strong>{item.agent ?? '未关联'}</strong><div className="ad-bar-track" aria-hidden="true"><span style={{ width: `${width}%` }} /></div><span>{liveLatency(value, metricUnit)}</span></div>;
      })}</div> : <p className="ad-live-empty">未采集到完整调用的延迟指标。</p>}
      {activityPagination('延迟对比', latencyChartRows, setLatencyChartPage)}
    </section>;
  }

  function hookKpis() {
    return agentStatisticsCards(report);
  }

  function hookCoverage() {
    return <section className="ad-live-report" aria-label="Hook 来源覆盖"><div className="ad-section-head"><h3>Agent 活动 · Hook</h3><span>{hookStatusLabels[hookStatus]}</span></div><details className="ad-activity-scope"><summary>覆盖与统计口径</summary><p>{hookCoverageNote}</p><p>覆盖原因：{hooks?.reason || '未提供'} · 跳过行数：{liveNumber(hooks?.skippedLines ?? null)}</p><p>图表与顶部数值使用独立全量累计聚合，不随明细限制、轮转、筛选或分页变化；升级前已轮转记录无法恢复。近 24h 明细输入最多 5,000 个事件 · 16 个 Agent，列表最多 200 条。未配对工具开始只表示未记录到配对结束，不等同于卡死。</p></details></section>;
  }

  function hookCharts() {
    return <>{hookStatus !== 'available' && hookStatus !== 'truncated' && hookCoverage()}{agentStatisticsCharts(report, openHookEvents)}</>;
  }

  function hookEventTable() {
    return visibleHookEvents.length ? <div className="ad-session-table" role="region" aria-label="Hook 事件元数据" tabIndex={0}><table><thead><tr><th>事件 / Agent</th><th>发生时间</th><th>Hook Session ID / Call ID</th><th>工具 / 错误类型</th><th>模型 / Subagent</th><th>interrupt</th><th>证据</th></tr></thead><tbody>{hookEventRows.rows.map(event => <tr key={event.id}><td><strong>{agentHookKindLabels[event.kind]}</strong><small>{event.kind} · {liveHookAgentLabel(event.agent)}</small><small>事件 ID：{event.id}</small></td><td className="ad-time">{localTime(event.occurredAt)}</td><td><small>Session ID：{event.sessionId ?? '— · 未报告'}</small><small>Call ID：{event.callId ?? '— · 未报告'}</small></td><td><small>工具：{event.tool ?? '— · 未报告'}</small><small>错误类型：{event.errorType ?? '— · 未报告'}</small></td><td><small>模型：{event.model ?? '— · 未报告'}</small><small>Subagent：{event.subagent ?? '— · 未报告'}</small></td><td>{event.interrupt === null ? 'null · 未报告' : String(event.interrupt)}</td><td><button className="ad-detail-button" aria-label={`查看 Hook 证据 ${event.id}`} onClick={() => setSelectedHook(event)}>查看证据</button></td></tr>)}</tbody></table></div> : <p className="ad-live-empty">{hookEvents.length ? '最新 200 条中没有匹配的 Hook 事件；不代表 24h 汇总中没有此类事件。' : hookStatus === 'available' ? '近 24h 未记录 Hook 事件；来源可用，不代表 Agent 未运行或整体正常。' : hookStatus === 'truncated' ? '保留部分无 Hook 事件明细；不能推断完整窗口没有事件。' : 'Hook 事件明细不可用；请查看覆盖原因。'}</p>;
  }

  return (
    <div className="agent-diagnostics ad-live" aria-busy={busy}>
      <div className="ad-section-head ad-live-heading">
        <div><h2>本机 Agent 诊断</h2><span>本机 · 近 24h · 只读</span></div>
        <button className="hg-button primary" disabled={busy} onClick={() => loadReport(true)}>
          {busy ? <LoaderCircle size={14} className="spinning" /> : <RefreshCw size={14} />}
          {busy ? '正在更新诊断…' : report ? '刷新诊断' : error ? '重试诊断' : '开始诊断'}
        </button>
      </div>
      <div className="ad-section-head"><h3>Agent 活动总体统计</h3><span>数值与明细独立 · {hookStatusLabels[hookStatus]}</span></div>
      {hookKpis()}
      <div className="ad-status-strip" role="status" aria-label="真实调用采集状态">
        <span className={`ad-service-state ${service?.collection?.state ?? 'unknown'}`}>{service?.collection ? collectionLabels[service.collection.state] : '采集状态未知'}</span>
        <span>数据服务 {service?.state === 'running' ? '可用' : service?.state === 'closed' ? '已关闭' : service?.state === 'unavailable' ? '不可用' : '未知'}</span>
        <span>{report ? liveExecutionLabels[report.status] : '等待报告'}</span>
        {report && <span>更新于 {localTime(report.sampledAt)}</span>}
        {error && report && <strong>旧结果 · 刷新失败</strong>}
        {busy && report && <strong>上次报告 · 更新中</strong>}
      </div>
      {busy && <p className="ad-live-note" role="status">{report ? '正在更新；以下为上次报告，尚未更新。' : '正在获取诊断结果…'}</p>}
      {error && <div className="ad-live-error" role="alert"><strong>{error}</strong><p>{report ? '旧结果：刷新失败，以下保留上次报告，不代表本次状态。' : '尚未取得本机报告。'}</p></div>}
      <section className={`ad-conclusion ${report?.outcome ?? 'unknown'}`} aria-label="诊断结论">
        <strong>{conclusion}</strong>
        {report && <span>{report.outcome === 'abnormal' ? `进程需检查 ${attentionProcesses.length} 个 · 未处理中断 ${liveNumber(report.totals.unresolved)} 条${hookAttention ? ' · Hook 轮次失败需关注' : ''}` : report.status === 'ok' && report.outcome === 'observed' ? '仅依据本次已采集记录，不代表业务整体正常。' : '现有记录不足以形成判断。'}</span>}
      </section>
      <div className="ad-live-tabs" role="tablist" aria-label="Agent 诊断视图">{tabs.map((item, index) => <button key={item.key} id={`ad-tab-${item.key}`} role="tab" aria-selected={tab === item.key} aria-controls={`ad-panel-${item.key}`} tabIndex={tab === item.key ? 0 : -1} onClick={() => setTab(item.key)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); setTab(tabs[next].key); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus(); }
      }}>{item.label}</button>)}</div>
      <div role="tabpanel" id={`ad-panel-${tab}`} aria-labelledby={`ad-tab-${tab}`}>
        {!report ? <p className="ad-live-empty">尚未取得本机诊断报告。</p> : <>
          {tab === 'overview' && <>
            {hookCharts()}
            <section className="ad-live-report"><div className="ad-section-head"><h3>事件分类统计</h3><span>{activity.aggregateAvailable ? `全量累计聚合 · ${activity.aggregateEvents} 条` : '累计聚合不可用'}</span></div><div className="ad-session-table" role="region" aria-label="Hook 分类统计" tabIndex={0}><table><thead><tr><th>事件类型</th><th>已取得条数</th><th>明细</th></tr></thead><tbody>{hookKindRows.rows.map(row => <tr key={row.kind}><td>{row.label}</td><td>{activity.aggregateAvailable ? row.count : '—'}</td><td><button className="ad-detail-button" onClick={() => openHookEvents({ kind: row.kind })}>查看{row.label}</button></td></tr>)}</tbody></table></div>{activityPagination('分类统计', hookKindRows, setHookKindPage, size => { setHookKindSize(size); setHookKindPage(1); })}</section>
            <section className="ad-live-report" aria-label="需关注的问题"><div className="ad-section-head"><h3>需关注的问题</h3><div className="ad-event-filter"><button className="ad-detail-button" onClick={() => { setInterruptionType(''); setInterruptionPage(1); setTab('interruptions'); }}>查看全部中断</button><button className="ad-detail-button" onClick={() => openHookEvents()}>查看Hook事件</button></div></div>
              <div className="ad-attention-list">
                {attentionProcesses.length > 0 && <button className="ad-event-card" onClick={() => { setProcessSearch(''); setProcessRole(''); setProcessStatus('attention'); setProcessPage(1); processPanel.current?.scrollIntoView({ block: 'start' }); }} aria-label="查看异常进程证据"><span className="ad-badge high">需检查</span><strong>进程探活异常 · {attentionProcesses.length} 个</strong><small>查看进程证据 ↓</small></button>}
                {groupedEvents.slice(0, 4).map((group) => <button key={group.type} className="ad-event-card" onClick={() => { setInterruptionType(group.type); setInterruptionPage(1); setTab('interruptions'); }} aria-label={`查看事件证据 ${group.type}`}><span className={`ad-badge ${group.severity}`}>{liveSeverityLabels[group.severity]}</span><strong>{liveInterruptionLabel(group.type)} · {group.count} 条</strong><small>查看同类中断证据 →</small></button>)}
                {hookAttention && <button className="ad-event-card" onClick={() => openHookEvents({ kind: 'turn_failure' })} aria-label="查看 Hook 轮次失败事件"><span className="ad-badge medium">关注</span><strong>Hook 轮次失败 · {hookTurnFailures > 0 ? `${liveNumber(hookTurnFailures)} 条（累计）` : '已记录'}</strong><small>查看独立 Hook 元数据 →</small></button>}
              </div>
              {!attentionProcesses.length && !groupedEvents.length && !hookAttention && <p className="ad-live-empty">当前明细无待关注项；数据缺失时仍无法判断。</p>}
              <p className="ad-live-note">近 24h 未处理 {liveNumber(report.totals.unresolved)} · 已取得中断明细 {report.interruptions.length} 条</p>
            </section>
            {latencyChart()}
            <section className="ad-live-report" ref={processPanel}><div className="ad-section-head"><h3>进程探活</h3><span>匹配 {filteredProcesses.length} / 已采集 {report.processes.length} 条</span></div>
              <div className="ad-process-filters">
                <label>搜索进程<input type="search" aria-label="搜索进程名或 PID" placeholder="进程名 / PID" value={processSearch} onChange={(event) => { setProcessSearch(event.target.value); setProcessPage(1); }} /></label>
                <label>角色<select aria-label="筛选进程角色" value={processRole} onChange={(event) => { setProcessRole(event.target.value); setProcessPage(1); }}><option value="">全部角色</option>{processRoles.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
                <label>状态<select aria-label="筛选探活状态" value={processStatus} onChange={(event) => { setProcessStatus(event.target.value as typeof processStatus); setProcessPage(1); }}><option value="">全部状态</option><option value="attention">需检查</option>{Object.entries(agentProcessLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
                <button className="ad-detail-button" disabled={!processSearch && !processRole && !processStatus} onClick={() => { setProcessSearch(''); setProcessRole(''); setProcessStatus(''); setProcessPage(1); }}>清除筛选</button>
              </div>
              <p className="ad-live-note">{sourceNote('processes')}</p>
              <div className="ad-session-table" role="region" aria-label="已采集进程探活" tabIndex={0}><table><thead><tr><th>进程 / PID</th><th>角色</th><th>探活状态</th><th>端口</th><th>探活延迟</th><th>最近检查</th></tr></thead><tbody>{pageProcesses.map((process) => <tr key={process.pid} className={`ad-live-process ${process.status}`}><td><strong>{process.name}</strong><small>PID {process.pid} · 父 PID {process.parentPid ?? '未关联'}</small></td><td>{process.role}</td><td><span className={`ad-process-status ${process.status}`} title={liveProcessNotes[process.status]}>{agentProcessLabels[process.status]}</span>{process.hasCrash && <small>有崩溃记录</small>}</td><td>{process.ports.length ? process.ports.join(', ') : '无'}</td><td>{liveLatency(process.latencyMs, 'ms')}</td><td className="ad-time">{localTime(process.lastCheckAt)}</td></tr>)}</tbody></table></div>
              {!filteredProcesses.length && <p className="ad-live-empty">{report.processes.length ? '没有匹配的进程。' : '没有已采集的进程记录；不代表业务正常。'}</p>}
              <nav className="ad-process-pagination" aria-label="进程探活分页"><span>第 {currentProcessPage} / {processPages} 页 · 每页 {processPageSize} 条</span><button className="ad-detail-button" disabled={currentProcessPage === 1} onClick={() => setProcessPage(currentProcessPage - 1)}>上一页</button><button className="ad-detail-button" disabled={currentProcessPage === processPages} onClick={() => setProcessPage(currentProcessPage + 1)}>下一页</button></nav>
            </section>
          </>}
          {tab === 'sessions' && <section className="ad-live-report"><div className="ad-section-head"><h3>会话列表</h3><span>按最后活跃时间降序 · 当前列表匹配 {visibleSessions.length} / {report.sessions.length}</span></div><label className="ad-live-search">搜索已采集会话<input type="search" aria-label="搜索会话 Agent / ID / Model" placeholder="Agent / ID / Model" value={search} onChange={(event) => { setSearch(event.target.value); setSessionPage(1); }} /></label><p className="ad-live-note">{sourceNote('sessions')} · 展开查看关联中断。</p>
            <div className="ad-session-table" role="region" aria-label="已采集会话列表" tabIndex={0}><table><thead><tr><th /><th>SESSION ID</th><th>AGENT</th><th>MODEL</th><th>对话数（计数）</th><th>输入 TOKEN</th><th>输出 TOKEN</th><th>最后活跃</th><th>已采集中断</th></tr></thead><tbody>{sessionRows.rows.map((session) => {
              const events = report.interruptions.filter((event) => event.sessionId === session.id);
              return <Fragment key={session.id}><tr className={expandedSession === session.id ? 'expanded' : ''}><td><button className="ad-expand-toggle" aria-expanded={expandedSession === session.id} aria-label={`${expandedSession === session.id ? '收起' : '展开'}会话 ${session.id}`} onClick={() => setExpandedSession((current) => current === session.id ? null : session.id)}>{expandedSession === session.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></td><td>{session.id}</td><td>{session.agent ?? '未关联'}</td><td>{session.model ?? '—'}</td><td>{liveNumber(session.conversations)}</td><td className="ad-token blue">{liveNumber(session.inputTokens)}</td><td className="ad-token green">{liveNumber(session.outputTokens)}</td><td className="ad-time">{localTime(session.lastSeenAt)}</td><td>{events.length} 条（列表）</td></tr>{expandedSession === session.id && <tr className="ad-interruption-row"><td colSpan={9}><div className="ad-interruption-panel"><strong>此会话关联中断 · 已采集元数据</strong><p className="ad-live-note">首次出现 {localTime(session.firstSeenAt)} · 最后活跃 {localTime(session.lastSeenAt)}</p>{events.length ? interruptionTable(events) : <p className="ad-live-note">当前已采集中断列表中无此会话关联事件，不代表全窗口无中断。</p>}</div></td></tr>}</Fragment>;
            })}{!visibleSessions.length && <tr><td colSpan={9}>{report.sessions.length ? '没有匹配的会话。' : '没有已采集的会话记录；请结合来源覆盖判断。'}</td></tr>}</tbody></table></div>
            {activityPagination('AgentSight 会话', sessionRows, setSessionPage)}
          </section>}
          {tab === 'interruptions' && <section className="ad-live-report"><div className="ad-section-head"><h3>中断事件</h3><span>近 24h 未处理 {liveNumber(report.totals.unresolved)} · 匹配 {visibleInterruptions.length} / 已取得明细 {report.interruptions.length}</span></div><label className="ad-event-filter">事件类型<select aria-label="筛选中断类型" value={interruptionType} onChange={(event) => { setInterruptionType(event.target.value); setInterruptionPage(1); }}><option value="">全部类型</option>{interruptionTypes.map((type) => <option key={type} value={type}>{liveInterruptionLabel(type)}</option>)}</select></label><p className="ad-live-note">{sourceNote('interruptions')} · 明细可能少于统计总数。</p>{visibleInterruptions.length ? interruptionTable(interruptionRows.rows) : <p className="ad-live-empty">{report.interruptions.length ? '没有匹配的中断事件。' : '没有已采集的中断明细，不代表全窗口无中断。'}</p>}{activityPagination('AgentSight 中断', interruptionRows, setInterruptionPage)}</section>}
          {tab === 'latency' && <>{latencyChart()}<section className="ad-live-report"><h3>LLM 调用延迟</h3><p className="ad-live-note">仅统计完整调用；首 Token 与单 Token 耗时仅针对流式调用。</p>{report.latency.length ? <div className="ad-session-table" role="region" aria-label="完整 LLM 调用延迟" tabIndex={0}><table><thead><tr><th>Agent</th><th>完整调用数</th><th>流式调用数</th><th>TTFT p95</th><th>E2E p95</th><th>TPS p50</th><th>TPOT p95</th></tr></thead><tbody>{latencyRows.rows.map((item, index) => <tr key={index}><td>{item.agent ?? '未关联'}</td><td>{liveNumber(item.calls)}</td><td>{liveNumber(item.streamingCalls)}</td><td>{liveLatency(item.ttftP95Ms, 'ms')}</td><td>{liveLatency(item.e2eP95Ms, 'ms')}</td><td>{liveLatency(item.tpsP50, 'Token/s')}</td><td>{liveLatency(item.tpotP95Ms, 'ms')}</td></tr>)}</tbody></table></div> : <p className="ad-live-empty">未采集到完整调用的延迟指标。</p>}{activityPagination('调用延迟', latencyRows, setLatencyPage)}</section></>}
          {tab === 'hooks' && <>
            {hookCoverage()}
            <section className="ad-live-report"><div className="ad-section-head"><h3>Hook 会话</h3><span>最新明细分组 · {filteredHookSessions.length} 个</span></div><div className="ad-session-table" role="region" aria-label="Hook 会话列表" tabIndex={0}><table><thead><tr><th>Agent / Hook Session ID</th><th>事件</th><th>提问</th><th>工具开始</th><th>轮次失败</th><th>最近记录</th><th>轨迹</th></tr></thead><tbody>{hookSessionRows.rows.map(session => <tr key={session.key}><td>{liveHookAgentLabel(session.agent)}<small>{session.sessionId}</small></td><td>{session.events}</td><td>{session.prompts}</td><td>{session.toolStarts}</td><td>{session.turnFailures}</td><td>{localTime(session.lastEventAt)}</td><td><button className="ad-detail-button" aria-label={`查看 Hook 会话轨迹 ${session.key}`} onClick={() => openHookEvents({ session: session.key })}>查看轨迹</button></td></tr>)}</tbody></table></div>{!filteredHookSessions.length && <p className="ad-live-empty">没有匹配的 Hook Session ID 记录。</p>}{activityPagination('Hook 会话', hookSessionRows, page => { setHookSessionPage(page); setHookTimelinePage(1); })}</section>
            {hookSession && <section className="ad-live-report"><div className="ad-section-head"><h3>会话事件轨迹</h3><span>仅已取得元数据 · 时间升序</span></div><ol className="ad-hook-timeline">{hookTimelineRows.rows.map(event => <li key={event.id}><time>{localTime(event.occurredAt)}</time><strong>{agentHookKindLabels[event.kind]}</strong><span>{event.tool ?? event.subagent ?? event.model ?? '—'}</span><button className="ad-detail-button" aria-label={`查看轨迹证据 ${event.id}`} onClick={() => setSelectedHook(event)}>查看证据</button></li>)}</ol>{activityPagination('会话轨迹', hookTimelineRows, setHookTimelinePage)}</section>}
            <section className="ad-live-report" aria-label="Hook 24h 有界汇总">
              <div className="ad-section-head"><h3>近 24h Hook 汇总</h3><span>最多 5,000 个事件 · 16 个 Agent</span></div>
              <details className="ad-activity-scope"><summary>汇总口径</summary><p>后端有界汇总，不从最新 200 条列表重算；筛选不改变汇总。未配对工具开始只表示未记录到配对结束，不等同于卡死。工具失败和授权拒绝不直接视为故障；轮次失败（turn_failure）是关注事件。</p></details>
              {hookAgents.length ? <div className="ad-session-table" role="region" aria-label="Hook Agent 汇总" tabIndex={0}>
                <table><thead><tr><th>Agent</th><th>会话</th><th>事件</th><th>提交提示</th><th>工具开始</th><th>工具完成</th><th>工具失败</th><th>中断</th><th>授权拒绝</th><th>轮次失败</th><th>未配对工具开始</th><th>最近事件</th></tr></thead>
                  <tbody>{hookSummaryRows.rows.map((item) => <tr key={item.agent}><td>{liveHookAgentLabel(item.agent)}</td><td>{liveNumber(item.sessions)}</td><td>{liveNumber(item.events)}</td><td>{liveNumber(item.prompts)}</td><td>{liveNumber(item.toolStarts)}</td><td>{liveNumber(item.toolEnds)}</td><td>{liveNumber(item.toolFailures)}</td><td>{liveNumber(item.interrupts)}</td><td>{liveNumber(item.permissionDenied)}</td><td>{liveNumber(item.turnFailures)}</td><td>{liveNumber(item.openTools)}</td><td className="ad-time">{localTime(item.lastEventAt)}</td></tr>)}</tbody>
                </table>
              </div> : <p className="ad-live-empty">{hookStatus === 'available' ? '近 24h 无已记录的 Hook Agent 汇总；不代表 Agent 未运行。' : hookStatus === 'truncated' ? '保留部分无 Hook Agent 汇总；不能推断完整窗口没有活动。' : 'Hook 汇总不可用，不能将缺失当作零。'}</p>}
              {activityPagination('Hook Agent 汇总', hookSummaryRows, setHookSummaryPage)}
            </section>
            <section className="ad-live-report" aria-label="Hook 最新事件">
              <div className="ad-section-head"><h3>最新 Hook 元数据</h3><span>最新 200 条以内 · 时间降序 · 匹配 {visibleHookEvents.length} / 已取得 {hookEvents.length}</span></div>
              <div className="ad-process-filters">
                <label>Agent<select aria-label="筛选 Hook Agent" value={hookAgent} onChange={(event) => { setHookAgent(event.target.value); setHookSession(''); resetActivityPages(); }}><option value="">全部 Agent</option>{hookAgentOptions.map((agent) => <option key={agent} value={agent}>{liveHookAgentLabel(agent)}</option>)}</select></label>
                <label>事件类型<select aria-label="筛选 Hook 类型" value={hookKind} onChange={(event) => { setHookKind(event.target.value); resetActivityPages(); }}><option value="">全部类型</option>{Object.entries(agentHookKindLabels).map(([kind, label]) => <option key={kind} value={kind}>{label} ({kind})</option>)}</select></label>
                <label>搜索元数据<input type="search" aria-label="搜索 Hook 元数据" value={hookSearch} placeholder="Session ID / 工具 / 模型" onChange={event => { setHookSearch(event.target.value); resetActivityPages(); }} /></label>
                <label>事件分类<select aria-label="筛选 Hook 分类" value={hookCategory} onChange={event => { setHookCategory(event.target.value); resetActivityPages(); }}><option value="">全部分类</option>{activity.categories.map(category => <option key={category.key} value={category.key}>{category.label}</option>)}</select></label>
                <button className="ad-detail-button" disabled={!hookHasFilters} onClick={clearHookFilters}>清除 Hook 筛选</button>
              </div>
              {(hookTool || hookSession || selectedBin) && <div className="ad-filter-context">{hookTool && <span>工具：{hookTool}</span>}{hookSession && <span>会话：{activity.sessions.find(session => session.key === hookSession)?.sessionId ?? '所选会话'}</span>}{selectedBin && <span>时段：{localTime(selectedBin.start)} — {localTime(selectedBin.end)}</span>}</div>}
              <details className="ad-activity-scope"><summary>元数据口径</summary><p>筛选仅作用于已取得的最新 200 条元数据，汇总可能多于列表。interrupt 的 true / false 为来源记录，null 表示未报告，不推断取消或故障。</p></details>
              {hookEventTable()}
              {activityPagination('Hook 事件', hookEventRows, setHookEventPage, size => { setHookEventSize(size); setHookEventPage(1); })}
            </section>
          </>}
          {tab === 'tools' && <>
            {hookCoverage()}
            {!activity.aggregateAvailable ? <p className="ad-live-empty">Hook 累计统计图不可用，不能将最新明细当作全量历史。</p> : <div className="ad-activity-grid">
              {activityRanking('工具回调统计', activity.tools.slice(0, 8).map(tool => ({ label: tool.tool, values: [tool.starts, tool.ends, tool.failures, tool.interrupts] })), ['开始', '结束', '失败', '显式中断'], index => openHookEvents({ tool: activity.tools[index].tool }))}
              {activityRanking('子 Agent 协作', activity.subagents.map(item => ({ label: item.subagent, values: [item.starts, item.stops] })), ['开始', '结束'])}
              {activityBars('任务与交互', activity.kinds.filter(item => ['task_created', 'task_completed', 'teammate_idle', 'elicitation', 'elicitation_result'].includes(item.kind)).map(item => ({ label: item.label, values: [item.count] })), ['已记录事件'], index => openHookEvents({ kind: ['task_created', 'task_completed', 'teammate_idle', 'elicitation', 'elicitation_result'][index] }))}
              {activityBars('授权记录', activity.kinds.filter(item => item.kind === 'permission_request' || item.kind === 'permission_denied').map(item => ({ label: item.label, values: [item.count] })), ['已记录事件'], index => openHookEvents({ kind: index === 0 ? 'permission_request' : 'permission_denied' }))}
              {activityBars('上下文压缩', activity.kinds.filter(item => item.kind === 'compact' || item.kind === 'compact_completed').map(item => ({ label: item.label, values: [item.count] })), ['已记录事件'], index => openHookEvents({ kind: index === 0 ? 'compact' : 'compact_completed' }))}
            </div>}
            <section className="ad-live-report"><div className="ad-section-head"><h3>工具累计统计</h3><span>{activity.aggregateAvailable ? '全量累计聚合 · 不代表任务成功率' : '累计聚合不可用'}</span></div><div className="ad-session-table" role="region" aria-label="Hook 工具统计" tabIndex={0}><table><thead><tr><th>工具</th><th>开始</th><th>结束回调</th><th>失败回调</th><th>显式中断</th><th>累计未配对</th><th>事件</th></tr></thead><tbody>{hookToolRows.rows.map(tool => <tr key={tool.tool}><td>{tool.tool}</td><td>{tool.starts}</td><td>{tool.ends}</td><td>{tool.failures}</td><td>{tool.interrupts}</td><td>{tool.unmatched}</td><td><button className="ad-detail-button" onClick={() => openHookEvents({ tool: tool.tool })}>查看明细</button></td></tr>)}</tbody></table></div>{activityPagination('工具统计', hookToolRows, setHookToolPage, size => { setHookToolSize(size); setHookToolPage(1); })}</section>
          </>}
          {tab === 'sources' && <>{hookCoverage()}<section className="ad-live-report"><div className="ad-section-head"><h3>独立数据接入</h3><span>只读状态 · 不自动安装或启用</span></div><ul className="ad-live-coverage">{liveSourceKeys.map(key => <li key={key}><strong>{agentSourceLabels[key]}</strong><span>{sourceNote(key)}</span></li>)}</ul><details className="ad-activity-scope"><summary>来源边界</summary><p>Hook：会话生命周期、通知、工具回调、授权、任务协作、信息补充与压缩元数据。AgentSight：会话、已记录 Token、中断、LLM 调用延迟与进程探活。两者独立，不跨来源关联 Session ID 或 PID。</p></details></section></>}
        </>}
      </div>
      <details className="ad-collection-details">
        <summary>数据范围</summary>
        {report ? <>
          <dl className="ad-live-meta"><div><dt>统计时间</dt><dd>{localTime(report.window.start)} — {localTime(report.window.end)}</dd></div><div><dt>更新时间</dt><dd>{localTime(report.sampledAt)}</dd></div></dl>
          <ul className="ad-live-coverage">{liveSourceKeys.map((key) => <li key={key}><strong>{agentSourceLabels[key]}</strong><span>{sourceNote(key)}</span></li>)}</ul>
          <p className="ad-live-note">Hook 覆盖：{hookStatusLabels[hookStatus]} · 原因：{hooks?.reason || '未提供'} · 跳过行数：{liveNumber(hooks?.skippedLines ?? null)}。{hookCoverageNote}</p>
          <p className="ad-live-note">Hook 与 AgentSight 独立：上方会话、Token、中断与延迟指标来自 AgentSight；Hook 包含独立全量累计聚合、近 24h 有界元数据汇总（最多 5,000 事件、16 Agent）与最新 200 条列表。不与 AgentSight Session ID 或 PID 做关联，也不推算 Hook Token、耗时或健康分数。</p>
          <p className="ad-live-note">缺失数据不代表正常；— 表示未知，Token 为来源已记录用量，未报告用量可能未计入。{service?.collection?.state === 'disabled' && '采集停用，当前显示历史记录。'}</p>
        </> : <p className="ad-live-note">尚未取得诊断数据。</p>}
      </details>
      {selectedHook && <Modal title={agentHookKindLabels[selectedHook.kind]} subtitle="Hook 事件元数据 · 只读" onClose={() => setSelectedHook(null)} wide={true}><div className="ad-modal-content ad-live"><dl className="ad-live-meta">{[
        ['事件 ID', selectedHook.id], ['Agent', liveHookAgentLabel(selectedHook.agent)], ['事件类型', selectedHook.kind], ['发生时间', localTime(selectedHook.occurredAt)], ['Hook Session ID', selectedHook.sessionId], ['Call ID', selectedHook.callId], ['工具', selectedHook.tool], ['错误类型', selectedHook.errorType], ['模型', selectedHook.model], ['Subagent', selectedHook.subagent], ['interrupt', selectedHook.interrupt === null ? 'null · 未报告' : String(selectedHook.interrupt)],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? '— · 未报告'}</dd></div>)}</dl><div className="ad-modal-actions">{selectedHook.sessionId !== null && <button className="hg-button" onClick={() => { openHookEvents({ session: JSON.stringify([selectedHook.agent, selectedHook.sessionId]) }); setSelectedHook(null); }}>查看 Hook 会话轨迹</button>}<button className="hg-button" onClick={() => setSelectedHook(null)}>关闭</button></div></div></Modal>}
      {selectedInterruption && <Modal title={`${liveInterruptionLabel(selectedInterruption.type)} · ${liveSeverityLabels[selectedInterruption.severity]}`} subtitle="本地报告已有证据 · 只读" onClose={() => setSelectedInterruption(null)} wide={true}>
        <div className="ad-modal-content ad-live"><dl className="ad-live-meta"><div><dt>事件 ID</dt><dd>{selectedInterruption.id}</dd></div><div><dt>类型</dt><dd>{liveInterruptionLabel(selectedInterruption.type)} ({selectedInterruption.type})</dd></div><div><dt>严重度</dt><dd>{liveSeverityLabels[selectedInterruption.severity]}</dd></div><div><dt>发生时间</dt><dd>{localTime(selectedInterruption.occurredAt)}</dd></div><div><dt>Session ID</dt><dd>{selectedInterruption.sessionId ?? '未关联'}</dd></div><div><dt>Call ID</dt><dd>{selectedInterruption.callId ?? '未关联'}</dd></div><div><dt>PID</dt><dd>{selectedInterruption.pid ?? '未关联'}</dd></div><div><dt>Agent</dt><dd>{selectedInterruption.agent ?? '未关联'}</dd></div><div><dt>处理状态</dt><dd>{selectedInterruption.resolved ? '已处理（来源记录）' : '未处理'}</dd></div></dl><p className="ad-modal-note">仅展示本次报告已有证据，未确认故障根因。</p><div className="ad-modal-actions">{report?.sessions.some((session) => session.id === selectedInterruption.sessionId) && <button className="hg-button" onClick={() => { setTab('sessions'); setSessionPage(1); setSearch(selectedInterruption.sessionId ?? ''); setExpandedSession(selectedInterruption.sessionId); setSelectedInterruption(null); }}>查看关联会话</button>}<button className="hg-button" onClick={() => setSelectedInterruption(null)}>关闭</button></div></div>
      </Modal>}
    </div>
  );
}
