import { useEffect, useState, type FormEvent } from 'react';
import { ChevronDown, CircleAlert, LoaderCircle, LockKeyhole, Square, X } from 'lucide-react';
import { problem, request } from './api';
import { actionNames, dateTime, Dialog, ErrorNotice, Loading, money, pretty, StatusBadge } from './components';
import type { ActionInput, ApiProblem, Budget, Job, ProjectSummary } from './types';

export function JobPanel({ job, projects, busy, onCancel }: { job: Job; projects: ProjectSummary[]; busy: boolean; onCancel: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const latest = job.error?.message ?? job.events.at(-1)?.message;
  return (
    <section className={`job-panel job-${job.status}`} aria-label="当前任务">
      <div className="job-strip"><div className="job-indicator" aria-hidden="true">{job.status === 'running' ? <LoaderCircle size={17} className="spin" /> : job.status === 'failed' ? <CircleAlert size={17} /> : <Square size={14} />}</div><div className="job-summary"><div><strong>{actionNames[job.action] ?? job.action}</strong>{job.source === 'schedule' && <span className="job-project">定时触发</span>}{job.chapter !== undefined && <span className="job-project">第 {job.chapter} 章</span>}<span className="job-project">{projects.find((project) => project.id === job.project_id)?.title ?? job.project_id}</span><span role="status"><StatusBadge status={job.status} /></span></div><p>{latest ?? `开始于 ${dateTime(job.started_at)}`}</p></div><div className="job-controls">{job.status === 'running' && <button className="button button-small button-quiet" disabled={busy} onClick={onCancel}><Square size={12} aria-hidden="true" />停止任务</button>}<button className={`icon-button ${expanded ? 'expanded' : ''}`} type="button" aria-label={expanded ? '收起任务日志' : '展开任务日志'} aria-expanded={expanded} aria-controls="job-log" onClick={() => setExpanded(!expanded)}><ChevronDown size={18} /></button></div></div>
      {expanded && <div id="job-log" className="job-log"><div className="job-log-meta"><code>{job.id}</code><span>{dateTime(job.started_at)} 开始{job.finished_at ? ` · ${dateTime(job.finished_at)} 结束` : ''}</span></div>{job.error && <ErrorNotice error={job.error} />}{job.events.length ? <ol className="job-events">{job.events.map((event, index) => <li key={index} className={event.level === 'error' || event.level === 'warn' || event.level === 'warning' ? 'event-warning' : ''}><time dateTime={event.time}>{dateTime(event.time)}</time><span className="event-level">{event.level}</span><div><p>{event.message}</p>{event.details !== undefined && <details><summary>详细信息</summary><pre>{pretty(event.details)}</pre></details>}</div></li>)}</ol> : <p className="field-help">任务尚未产生事件记录。</p>}{job.result !== undefined && <details className="job-result"><summary>服务端任务结果</summary><pre>{pretty(job.result)}</pre></details>}</div>}
    </section>
  );
}

export function ActionConfirmation({ input, projectTitle, budgetSnapshot, busy, error, onClose, onConfirm }: {
  input: ActionInput; projectTitle: string; budgetSnapshot: Budget | null; busy: boolean; error: ApiProblem | null;
  onClose: () => void; onConfirm: (input: ActionInput) => void;
}) {
  const [note, setNote] = useState(input.note ?? '');
  const [budget, setBudget] = useState<Budget | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(input.action === 'redo');
  const [budgetError, setBudgetError] = useState<ApiProblem | null>(null);
  const [reload, setReload] = useState(0);
  const isRedo = input.action === 'redo';
  const isLock = input.action === 'lock';
  const paid = !isLock && input.action !== 'export';
  const currentBudget = isRedo ? budget : budgetSnapshot;

  useEffect(() => {
    if (input.action !== 'redo') return;
    const controller = new AbortController();
    setBudgetLoading(true); setBudgetError(null);
    request<Budget>('/api/budget', { signal: controller.signal }).then(setBudget)
      .catch((cause) => { if (!controller.signal.aborted) setBudgetError(problem(cause)); })
      .finally(() => { if (!controller.signal.aborted) setBudgetLoading(false); });
    return () => controller.abort();
  }, [input.action, reload]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onConfirm({ ...input, ...(isRedo ? { note: note.trim() || undefined } : {}) });
  }

  return (
    <Dialog title={isRedo ? '重绘这一页？' : isLock ? '确定这张设定？' : '确认执行这些选项？'} eyebrow={`${projectTitle} / ${actionNames[input.action]}`} busy={busy} onClose={onClose}>
      <form onSubmit={submit} className="form-stack">
        {isLock ? <div className="confirmation-explanation"><LockKeyhole size={24} strokeWidth={1.5} aria-hidden="true" /><p>锁定 <code>{input.ref_id}</code> 后，同一对象的其他候选将不再被选用。已有锁定不能重新锁定或替换，请先确认这张图符合你的故事。</p></div> : <>
          <p className="dialog-description">{isRedo ? <>将重新生成 <code>{input.page_id}</code>，并重新审查。旧尝试仍保留，当前选定结果可能被替换。</> : <>将对{input.chapter ? `第 ${input.chapter} 章` : '当前作品'}执行「{actionNames[input.action]}」。</>}</p>
          {paid ? <div className="cost-warning"><CircleAlert size={19} aria-hidden="true" /><p>此操作会调用模型，产生新的花费。{isRedo ? '重绘开启新的审查周期，不受历史次数限制；本轮仍受配置的重抽上限和预算闸约束。' : '强制执行可能重新生成已完成的内容。'}</p></div> : <p className="field-help">导出不调用模型，但强制执行会重新生成导出文件。</p>}
          {input.force && <div className="confirmation-option"><strong>强制重新执行</strong><p>不跳过已完成步骤。已有锁定参考图不会因此解除锁定。</p></div>}
          {input.ignore_limit && <div className="confirmation-option confirmation-option-danger"><strong>本次忽略预算上限</strong><p>服务端将跳过本次任务的预算闸检查，实际花费可能超过工作区或项目上限。</p></div>}
          {isRedo && <label className="field"><span>修正要求 <small>可选</small></span><textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} rows={4} placeholder="指出需要修正的格号、文字、动作或角色颜色。这段说明会追加到重绘提示词。" disabled={busy} /></label>}
          {budgetLoading && <Loading>执行前，正在读取最新账本</Loading>}
          {budgetError && <ErrorNotice error={budgetError} onRetry={() => setReload((value) => value + 1)} />}
          {currentBudget && <div className="confirmation-budget"><span>本周期已花费<strong>{money(currentBudget.spent_usd)}</strong></span><span>预算上限<strong>{currentBudget.limit_usd === null ? '未设上限' : money(currentBudget.limit_usd)}</strong></span><span>剩余<strong>{currentBudget.remaining_usd === null ? '不限额' : money(currentBudget.remaining_usd)}</strong></span></div>}
        </>}
        {error && <ErrorNotice error={error} />}
        <div className="dialog-actions"><button className="button button-quiet" type="button" disabled={busy} onClick={onClose}>暂不执行</button><button className={`button ${isLock ? 'button-primary' : 'button-danger'}`} type="submit" disabled={busy || (isRedo && (budgetLoading || Boolean(budgetError) || !budget))}>{busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}{isLock ? '确认锁定，保留此设定' : isRedo ? '确认重绘并计费' : paid ? '确认执行并计费' : '确认重新导出'}</button></div>
      </form>
    </Dialog>
  );
}

export function CancelConfirmation({ job, busy, error, onClose, onConfirm }: {
  job: Job; busy: boolean; error: ApiProblem | null; onClose: () => void; onConfirm: () => void;
}) {
  return <Dialog title="停止当前任务？" eyebrow={actionNames[job.action] ?? job.action} onClose={onClose} busy={busy}>
    <p className="dialog-description">已完成的素材与进度会保留。已经发出的模型请求可能仍会产生花费；最终取消状态以服务端返回为准。</p>
    <code className="cancel-job-id">{job.id}</code>
    {error && <ErrorNotice error={error} />}
    <div className="dialog-actions"><button className="button button-quiet" disabled={busy} onClick={onClose}>继续制作</button><button className="button button-danger" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={16} className="spin" aria-hidden="true" /> : <X size={15} aria-hidden="true" />}确认停止</button></div>
  </Dialog>;
}
