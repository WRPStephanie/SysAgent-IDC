import type { ReactNode } from 'react';
import { buildHookActivity } from './agent-hook-activity';
import { agentHookAgentLabels, type AgentDiagnostic } from './agent-diagnostics-data';

export const activityColors = ['#5b7cfa', '#51a9b9', '#e7a044', '#9176cc', '#e07783'];

export type HookSelection = { kind?: string; category?: string; tool?: string; bin?: number; session?: string };

export function agentStatisticsCards(report: AgentDiagnostic | null) {
  const history = report?.hooks?.history;
  const totals = history?.totals;
  const number = (value: number | null | undefined) => value !== null && value !== undefined && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
  const cards = [['sessions', '已记录会话'], ['events', 'Hook 事件'], ['prompts', '提交提问'], ['toolStarts', '工具开始'], ['turnFailures', '轮次失败'], ['openTools', '未配对开始']] as const;
  return <>
    <section className="ad-hook-kpis" aria-label="Hook 累计总体统计">{cards.map(([key, label]) => <div key={key}><strong>{number(totals?.[key])}</strong><span>{label}</span></div>)}</section>
    <p className="ad-live-note">Hook 累计历史 · {history?.status === 'available' ? '完整汇总' : `汇总不可用或不完整，— 表示未知（${history?.reason?.trim() || '原因未知'}）`} · Hook 独立持久累计，不受明细限制或轮转影响；启用前已删除记录无法恢复。</p>
  </>;
}

export function agentStatisticsCharts(report: AgentDiagnostic | null, onSelect: (criteria: HookSelection) => void) {
  if (!report) return <p className="ad-live-empty">Hook 累计统计图不可用，不能将缺失当作零。</p>;
  const activity = buildHookActivity(report.hooks, report.window);
  if (!activity.aggregateAvailable) return <p className="ad-live-empty">Hook 累计统计图不可用，不能将最新明细当作全量历史。</p>;
  const sessions = [...activity.chartSessions].sort((a, b) => b.events - a.events || a.key.localeCompare(b.key)).slice(0, 8);
  const tools = [...activity.tools].sort((a, b) => (b.starts + b.ends + b.failures + b.interrupts) - (a.starts + a.ends + a.failures + a.interrupts) || a.tool.localeCompare(b.tool)).slice(0, 6);
  const agentLabel = (agent: string) => Object.hasOwn(agentHookAgentLabels, agent) ? agentHookAgentLabels[agent] : agent;
  return <div className="ad-activity-grid">
    {activityBars('活动趋势', activity.bins.map(bin => ({ label: bin.label, values: [bin.count] })), ['事件'], index => onSelect({ bin: index }))}
    {activityDonut('事件构成', activity.categories, index => onSelect({ category: activity.categories[index].key }))}
    {activityRanking('会话活动排行', sessions.map(session => ({ label: `${agentLabel(session.agent)} · 匿名会话 ${session.key.slice(0, 8)}`, values: [session.events] })), ['事件'])}
    {activityRanking('工具活动排行', tools.map(tool => ({ label: tool.tool, values: [tool.starts, tool.ends, tool.failures, tool.interrupts] })), ['开始', '结束', '失败', '显式中断'], index => onSelect({ tool: tools[index].tool }))}
  </div>;
}

export function activityBars(title: string, rows: { label: string; values: number[] }[], legend: string[], onSelect?: (index: number) => void) {
  const maximum = Math.max(1, ...rows.map(row => row.values.reduce((sum, value) => sum + value, 0)));
  const width = 560;
  const height = 210;
  const step = 500 / Math.max(1, rows.length);
  return <section className="ad-live-report ad-activity-chart" aria-label={title}>
    <div className="ad-section-head"><h3>{title}</h3><span>全量累计聚合 · {rows.reduce((total, row) => total + row.values.reduce((sum, value) => sum + value, 0), 0)} 条</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} role={onSelect ? 'group' : 'img'} aria-label={`${title}：${rows.map(row => `${row.label} ${row.values.join('/')}`).join('，')}`}>
      {[...new Set([0, Math.ceil(maximum / 2), maximum])].map(tick => <g key={tick}><line x1="40" x2="550" y1={170 - tick / maximum * 145} y2={170 - tick / maximum * 145} stroke="#e4eaf3" /><text x="34" y={174 - tick / maximum * 145} textAnchor="end">{tick}</text></g>)}
      {rows.map((row, index) => {
        let bottom = 170;
        const total = row.values.reduce((sum, value) => sum + value, 0);
        return <g key={`${row.label}-${index}`} role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={`${row.label}，${total} 条${onSelect ? '，查看事件' : ''}`} onClick={onSelect ? () => onSelect(index) : undefined} onKeyDown={onSelect ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(index); } } : undefined} className={onSelect ? 'ad-chart-target' : undefined}>
          <rect x={40 + index * step} y="20" width={step} height="155" fill="transparent" />
          {row.values.map((value, series) => { const barHeight = value / maximum * 145; bottom -= barHeight; return <rect key={series} x={44 + index * step} y={bottom} width={Math.max(2, step - 8)} height={barHeight} rx="2" fill={activityColors[series % activityColors.length]} />; })}
          <text x={40 + (index + 0.5) * step} y="193" textAnchor="middle">{row.label.length > 9 ? `${row.label.slice(0, 8)}…` : row.label}</text>
        </g>;
      })}
    </svg>
    <div className="ad-chart-legend">{legend.map((label, index) => <span key={label}><i style={{ background: activityColors[index % activityColors.length] }} />{label}</span>)}</div>
  </section>;
}

export function activityDonut(title: string, rows: { label: string; count: number }[], onSelect: (index: number) => void) {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  let offset = 0;
  return <section className="ad-live-report ad-activity-chart" aria-label={title}>
    <div className="ad-section-head"><h3>{title}</h3><span>全量累计聚合</span></div>
    <div className="ad-donut-content"><svg viewBox="0 0 200 200" role="img" aria-label={`${title}：${rows.map(row => `${row.label} ${row.count}`).join('，')}`}>
      <circle cx="100" cy="100" r="70" fill="none" stroke="#edf1f7" strokeWidth="24" />
      {rows.map((row, index) => { const length = total ? row.count / total * 100 : 0; const start = offset; offset += length; return <circle key={row.label} cx="100" cy="100" r="70" fill="none" stroke={activityColors[index % activityColors.length]} strokeWidth="24" pathLength="100" strokeDasharray={`${length} ${100 - length}`} strokeDashoffset={-start} transform="rotate(-90 100 100)" />; })}
      <text x="100" y="98" textAnchor="middle" className="ad-donut-total">{total}</text><text x="100" y="121" textAnchor="middle">已取得事件</text>
    </svg><div className="ad-donut-legend">{rows.map((row, index) => <button key={row.label} className="ad-chart-category" onClick={() => onSelect(index)} aria-label={`查看${row.label}类 Hook 事件`}><i style={{ background: activityColors[index % activityColors.length] }} /><span>{row.label}</span><strong>{row.count}</strong></button>)}</div></div>
  </section>;
}

export function activityRanking(title: string, rows: { label: string; values: number[] }[], legend: string[], onSelect?: (index: number) => void) {
  const maximum = Math.max(1, ...rows.map(row => row.values.reduce((sum, value) => sum + value, 0)));
  return <section className="ad-live-report ad-activity-chart" aria-label={title}><div className="ad-section-head"><h3>{title}</h3><span>全量累计聚合 · 前 {rows.length} 项</span></div>
    <div className="ad-activity-ranking">{rows.length ? rows.map((row, index) => {
      const content: ReactNode = <><span className="ad-ranking-label">{row.label}</span><span className="ad-ranking-track" aria-hidden="true">{row.values.map((value, series) => <i key={series} style={{ width: `${value / maximum * 100}%`, background: activityColors[series % activityColors.length] }} />)}</span><strong>{row.values.reduce((sum, value) => sum + value, 0)}</strong></>;
      return onSelect ? <button key={row.label} onClick={() => onSelect(index)} aria-label={`查看 ${row.label} Hook 明细`}>{content}</button> : <div key={row.label}>{content}</div>;
    }) : <p className="ad-live-empty">没有已记录的分类明细。</p>}</div>
    <div className="ad-chart-legend">{legend.map((label, index) => <span key={label}><i style={{ background: activityColors[index % activityColors.length] }} />{label}</span>)}</div>
  </section>;
}

export function activityPagination(name: string, page: { page: number; pages: number; start: number; end: number; total: number; size: number }, onPage: (page: number) => void, onSize?: (size: number) => void) {
  const first = Math.max(1, Math.min(page.page - 2, page.pages - 4));
  const numbers = Array.from({ length: Math.min(5, page.pages) }, (_, index) => first + index);
  return <nav className="ad-activity-pagination" aria-label={`${name}分页`}><span>{page.start}–{page.end} / {page.total} 条 · 第 {page.page} / {page.pages} 页</span>
    {onSize && <label>每页<select aria-label={`${name}每页条数`} value={page.size} onChange={event => onSize(Number(event.target.value))}>{[5, 10, 20].map(size => <option key={size} value={size}>{size}</option>)}</select></label>}
    <div><button className="ad-detail-button" aria-label={`${name}首页`} disabled={page.page === 1} onClick={() => onPage(1)}>首页</button><button className="ad-detail-button" aria-label={`${name}上一页`} disabled={page.page === 1} onClick={() => onPage(page.page - 1)}>上一页</button>{numbers.map(number => <button key={number} className="ad-detail-button" aria-label={`${name}第 ${number} 页`} aria-current={page.page === number ? 'page' : undefined} onClick={() => onPage(number)}>{number}</button>)}<button className="ad-detail-button" aria-label={`${name}下一页`} disabled={page.page === page.pages} onClick={() => onPage(page.page + 1)}>下一页</button><button className="ad-detail-button" aria-label={`${name}末页`} disabled={page.page === page.pages} onClick={() => onPage(page.pages)}>末页</button></div>
  </nav>;
}
