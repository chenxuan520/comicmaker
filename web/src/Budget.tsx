import { ArrowUpRight, ReceiptText, RefreshCw } from 'lucide-react';
import { dateTime, money, Warnings } from './components';
import type { Budget as BudgetData, ProjectSummary } from './types';

const periods: Record<string, string> = { month: '本月', week: '本周', none: '累计' };
const steps: Record<string, string> = {
  prepare: '全书预处理', extract: '设定提取', summary: '章节摘要', adapt: '场景改编',
  storyboard: '分页分镜', storyboard_review: '分镜审查', image: '图像生成', refs: '参考图',
  review: '画页审查', review_text: '文字审查', review_visual: '画面审查', rewrite: '安全改写',
};

export default function Budget({ budget, projects, selectedId, onRefresh, onConfig }: {
  budget: BudgetData; projects: ProjectSummary[]; selectedId: string | null; onRefresh: () => void; onConfig: () => void;
}) {
  const hasLimit = budget.limit_usd !== null;
  const reached = hasLimit && budget.remaining_usd !== null && budget.remaining_usd <= 0;
  const progress = budget.limit_usd === null ? 0 : budget.limit_usd > 0 ? Math.min(100, budget.spent_usd / budget.limit_usd * 100) : budget.spent_usd > 0 ? 100 : 0;
  const projectCosts = [...budget.by_project].sort((a, b) => b.cost_usd - a.cost_usd);
  const stepCosts = [...budget.by_step].sort((a, b) => b.cost_usd - a.cost_usd);
  const maxStep = Math.max(0, ...stepCosts.map((item) => item.cost_usd));

  return (
    <div className="budget-view">
      <div className="page-heading"><div><p className="eyebrow">本地花费账本 / LEDGER</p><h1>每一页，也要心中有数。</h1><p>花费来自工作区账本，跨项目汇总。上限由你设置，不替你假定额度。</p></div><button className="button button-quiet" onClick={onRefresh}><RefreshCw size={16} aria-hidden="true" />刷新账本</button></div>
      <section className="ledger-summary">
        <div className="ledger-spent"><span className="eyebrow">{periods[budget.period] ?? budget.period}已花费 / USD</span><strong>{money(budget.spent_usd)}</strong><span className="ledger-note"><ReceiptText size={15} aria-hidden="true" />本地账本记录，不是模型账户余额</span></div>
        <div className="ledger-limit"><div><span>花费上限</span><strong>{hasLimit ? money(budget.limit_usd!) : '未设上限'}</strong></div><div><span>剩余额度</span><strong className={reached ? 'text-vermillion' : ''}>{budget.remaining_usd !== null ? money(budget.remaining_usd) : hasLimit ? '未提供' : '不限额'}</strong></div><div><span>周期重置</span><strong className="ledger-date">{budget.reset_at ? dateTime(budget.reset_at) : budget.period === 'none' ? '不自动重置' : '未提供重置时间'}</strong></div></div>
        {hasLimit && <div className={`budget-meter ${reached ? 'budget-meter-reached' : ''}`} role="meter" aria-label="已使用预算" aria-valuemin={0} aria-valuemax={budget.limit_usd!} aria-valuenow={Math.min(budget.spent_usd, budget.limit_usd!)} aria-valuetext={`已花费 ${money(budget.spent_usd)}，上限 ${money(budget.limit_usd!)}`}><span style={{ width: `${progress}%` }} /></div>}
        <div className={`budget-limit-note ${reached ? 'budget-limit-reached' : ''}`}><p>{reached ? '已到预算上限。后续计费任务可能被服务端拦截，已完成进度仍保留。' : hasLimit ? '预算闸已启用。每次计费调用前，服务端会检查工作区与项目上限。' : '记账始终开启，预算上限尚未启用。可以在配置中设置金额与周期。'}</p><button className="text-link" onClick={onConfig}>调整预算配置<ArrowUpRight size={14} aria-hidden="true" /></button></div>
      </section>
      <Warnings warnings={budget.warnings ?? []} title="账本提醒" />
      <div className="ledger-columns">
        <section className="paper-panel ledger-projects"><div className="section-heading"><div><p className="eyebrow">按作品记账</p><h2>故事各自的花费</h2></div><span className="count-label">{projectCosts.length}</span></div>
          {projectCosts.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th scope="col">作品</th><th scope="col" className="number-cell">花费 / USD</th></tr></thead><tbody>{projectCosts.map((item) => <tr key={item.project_id} className={item.project_id === selectedId ? 'current-project-row' : ''}><td><strong>{projects.find((project) => project.id === item.project_id)?.title ?? item.project_id}</strong><code>{item.project_id}{item.project_id === selectedId ? ' · 当前作品' : ''}</code></td><td className="number-cell">{money(item.cost_usd)}</td></tr>)}</tbody></table></div> : <div className="ledger-empty"><ReceiptText size={26} strokeWidth={1.3} aria-hidden="true" /><p>还没有项目花费记录。</p><span>真实计费发生后，账本会在这里更新。</span></div>}
        </section>
        <section className="paper-panel ledger-steps"><div className="section-heading"><div><p className="eyebrow">按制作步骤</p><h2>花费去了哪里</h2></div></div>{stepCosts.length ? <ol className="step-spend-list">{stepCosts.map((item) => <li key={item.step}><div><span>{steps[item.step] ?? item.step}</span><strong>{money(item.cost_usd)}</strong></div><div className="spend-bar"><span style={{ width: `${maxStep ? item.cost_usd / maxStep * 100 : 0}%` }} /></div><code>{item.step}</code></li>)}</ol> : <div className="ledger-empty"><p>还没有制作步骤花费。</p><span>导入与导出不调用模型。</span></div>}</section>
      </div>
      <p className="ledger-footnote">金额以美元计，使用服务端配置的模型单价；预估记账或缺少单价的情况，以服务端提醒为准。重绘旧页也会产生新的花费。</p>
    </div>
  );
}
