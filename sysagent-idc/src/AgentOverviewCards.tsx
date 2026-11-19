import { useEffect, useRef, useState, type MouseEventHandler } from 'react';
import { Bot, ChevronRight, Coins, HeartPulse, LoaderCircle, MessagesSquare, RefreshCw, TriangleAlert } from 'lucide-react';
import { agentSummary, formatNumber } from './agent-summary';
import { agentStatisticsCards } from './AgentActivityCharts';
import { fetchAgentDiagnostic } from './idc-client';
import type { AgentDiagnostic } from './agent-diagnostics-data';
import { localTime } from '../agent-diagnostics';

export function HomeAgentStatistics({ onOpen }: { onOpen: () => void }) {
  const [report, setReport] = useState<AgentDiagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const requestLock = useRef(false);

  async function load(refresh: boolean) {
    if (!mounted.current || requestLock.current) return;
    requestLock.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await fetchAgentDiagnostic(refresh);
      if (mounted.current) setReport(next);
    } catch {
      if (mounted.current) setError('暂时无法更新 Agent 统计，请稍后重试。');
    } finally {
      requestLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    void load(false);
    return () => { mounted.current = false; };
  }, []);

  return <section className="sh-home-panel agent sh-agent-summary ad-live" aria-label="Agent 总体统计" aria-busy={busy}>
    <div className="sh-panel-head">
      <span className="sh-panel-mark"><Bot size={19} /></span>
      <div><h2>Agent 总体统计</h2><p>本机已记录活动 · 汇总与明细分开 · 只读</p></div>
      <div className="sh-panel-aside sh-agent-summary-actions">
        <button className="hg-text-button" disabled={busy} aria-label="刷新 Agent 总体统计" onClick={() => { void load(true); }}>{busy ? <LoaderCircle size={13} className="spinning" /> : <RefreshCw size={13} />}刷新统计</button>
        <button className="hg-text-button" onClick={onOpen}>进入 Agent 管家<ChevronRight size={13} /></button>
      </div>
    </div>
    {agentStatisticsCards(report)}
    <p className="sh-agent-summary-note" role="status">{busy ? report ? '正在更新，当前显示上次报告。' : '正在获取 Agent 统计…' : report ? `更新于 ${localTime(report.sampledAt)} · — 表示未知。` : '尚未取得本机报告，— 表示未知。'}</p>
    {error && <p className="sh-agent-summary-error" role="alert">{error}{report ? ' 保留上次报告，不代表本次状态。' : ''}</p>}
  </section>;
}

const agentColors = ['#5b7cfa', '#a5b8ff'];

interface AgentOverviewCardsProps {
  recovered: boolean;
  disabled: boolean;
  onOpen: MouseEventHandler<HTMLButtonElement>;
}

export function AgentOverviewCards({ recovered, disabled, onOpen }: AgentOverviewCardsProps) {
  const { sessions, sessionsByAgent, inputTokens, outputTokens } = agentSummary;
  const interruptions = agentSummary.interruptions;
  const totalTokens = inputTokens + outputTokens;
  const healthyProcesses = recovered ? agentSummary.processes : agentSummary.processes - 1;

  return (
    <section className="sh-home-panel agent sh-agent-overview" aria-label="Agent 概览">
      <div className="sh-panel-head">
        <span className="sh-panel-mark">
          <Bot size={19} />
        </span>
        <div>
          <h2>Agent 概览</h2>
          <p>Session 运行、Token 消耗与异常中断 · Demo 数据</p>
        </div>
        <button
          className="hg-text-button sh-panel-aside"
          disabled={disabled}
          onClick={onOpen}
        >
          进入 Agent 管家
          <ChevronRight size={13} />
        </button>
      </div>
      <div className="sh-agent-stats">
        <button
          className="sh-agent-stat sessions"
          data-agent-stat="sessions"
          aria-label={`Agent Sessions ${sessions} 个，查看 Agent 管家`}
          disabled={disabled}
          onClick={onOpen}
        >
          <div className="sh-agent-stat-top">
            <span>
              <MessagesSquare size={16} />
            </span>
            <em>Sessions</em>
          </div>
          <strong>{sessions}</strong>
          <div className="sh-agent-bar">
            {sessionsByAgent.map((agent, index) => (
              <i key={agent.name} style={{ flex: agent.count, background: agentColors[index] }} />
            ))}
          </div>
          <div className="sh-agent-legend">
            {sessionsByAgent.map((agent, index) => (
              <span key={agent.name}>
                <i style={{ background: agentColors[index] }} />
                {agent.name}{' '}{agent.count}
              </span>
            ))}
          </div>
        </button>
        <button
          className="sh-agent-stat tokens"
          data-agent-stat="tokens"
          aria-label={`Token 消耗 ${formatNumber(totalTokens)}，查看 Agent 管家`}
          disabled={disabled}
          onClick={onOpen}
        >
          <div className="sh-agent-stat-top">
            <span>
              <Coins size={16} />
            </span>
            <em>Token 消耗</em>
          </div>
          <strong>
            {formatNumber(totalTokens)}
            <small>总量</small>
          </strong>
          <div className="sh-agent-bar">
            <i className="input" style={{ flex: inputTokens }} />
            <i className="output" style={{ flex: outputTokens }} />
          </div>
          <div className="sh-agent-legend">
            <span>
              <i className="input" />
              {'输入 '}{formatNumber(inputTokens)}
            </span>
            <span>
              <i className="output" />
              {'输出 '}{formatNumber(outputTokens)}
            </span>
          </div>
        </button>
        <button
          className="sh-agent-stat interruptions"
          data-agent-stat="interruptions"
          aria-label={`异常中断 ${interruptions.total} 条，查看 Agent 管家`}
          disabled={disabled}
          onClick={onOpen}
        >
          <div className="sh-agent-stat-top">
            <span>
              <TriangleAlert size={16} />
            </span>
            <em>异常中断</em>
            <b className="critical">{'严重 '}{interruptions.critical}</b>
            <b className="high">{'高危 '}{interruptions.high}</b>
          </div>
          <strong>{interruptions.total}</strong>
          <div className="sh-agent-bar">
            {interruptions.byType.map((interruption) => (
              <i
                key={interruption.label}
                className={interruption.tone}
                style={{ flex: interruption.count }}
              />
            ))}
          </div>
          <div className="sh-agent-legend">
            {interruptions.byType.map((interruption) => (
              <span key={interruption.label}>
                <i className={interruption.tone} />
                {interruption.label}{' '}{interruption.count}
              </span>
            ))}
          </div>
        </button>
        <button
          className={`sh-agent-stat process ${recovered ? 'healthy' : 'warning'}`}
          data-agent-stat="process"
          aria-label={`Agent 进程 ${healthyProcesses} / ${agentSummary.processes} 正常，查看 Agent 管家`}
          disabled={disabled}
          onClick={onOpen}
        >
          <div className="sh-agent-stat-top">
            <span>
              <HeartPulse size={16} />
            </span>
            <em>Agent 进程</em>
          </div>
          <strong>
            {healthyProcesses}
            <small>{'/ '}{agentSummary.processes}{' 正常'}</small>
          </strong>
          <div className="sh-agent-bar">
            {Array.from({ length: agentSummary.processes }, (_, index) => (
              <i
                key={index}
                className={index < healthyProcesses ? 'ok' : 'stuck'}
                style={{ flex: 1 }}
              />
            ))}
          </div>
          <p className="sh-agent-status">
            {recovered
              ? '全部探活正常 · 已完成受控恢复'
              : `${agentSummary.stuckProcess.role} 响应卡住 · 探活 ${agentSummary.stuckProcess.latency}`}
          </p>
        </button>
      </div>
    </section>
  );
}
