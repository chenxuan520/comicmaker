import { useEffect, useState, type FormEvent } from 'react';
import { CircleAlert, Clock3, LoaderCircle } from 'lucide-react';
import { problem, projectUrl, send } from './api';
import { Dialog, ErrorNotice } from './components';
import type { ApiProblem, ChapterSchedule, ProjectDetail, ScheduleInput } from './types';

type ActiveScheduleInput = Exclude<ScheduleInput, { mode: 'off' }>;

const statuses: Record<ChapterSchedule['status'], [string, string]> = {
  scheduled: ['待执行', 'blue'], running: ['进行中', 'blue'], paused: ['已暂停', 'orange'],
  completed: ['已完成', 'teal'], disabled: ['已关闭', 'muted'],
};

export default function Schedule({ project, busy, onUpdated }: { project: ProjectDetail; busy: boolean; onUpdated: () => void }) {
  const [schedule, setSchedule] = useState(project.schedule);
  const [mode, setMode] = useState<'once' | 'daily'>(project.schedule?.mode ?? 'once');
  const [runAt, setRunAt] = useState(() => project.schedule?.mode === 'once' ? localDateTime(project.schedule.run_at, project.schedule.timezone) : '');
  const [time, setTime] = useState(project.schedule?.mode === 'daily' ? project.schedule.time : '09:00');
  const [timezone, setTimezone] = useState(project.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiProblem | null>(null);
  const [confirmation, setConfirmation] = useState<ActiveScheduleInput | null>(null);
  const nextChapter = project.chapters.filter((chapter) => chapter.status !== 'exported').sort((a, b) => a.idx - b.idx)[0];
  const nextChapterLabel = nextChapter ? `第 ${nextChapter.idx} 章${nextChapter.title ? ` · ${nextChapter.title}` : ''}` : project.chapters.length ? '所有章节均已导出' : '尚未导入章节';
  const [statusLabel, statusTone] = statuses[schedule?.status ?? 'disabled'];

  useEffect(() => { setSchedule(project.schedule); }, [project.schedule]);

  function openConfirmation(event: FormEvent) {
    event.preventDefault(); setError(null); setSaved(false);
    const zone = timezone.trim();
    try {
      if (/^[+-]/.test(zone)) throw new RangeError();
      new Intl.DateTimeFormat('zh-CN', { timeZone: zone }).format();
    } catch { setError({ message: '请输入有效的 IANA 时区，例如 Asia/Shanghai 或 America/New_York。' }); return; }
    try {
      if (mode === 'daily') setConfirmation({ mode, time, timezone: zone, confirm_cost: true });
      else {
        const run_at = onceRunAt(runAt, zone);
        if (Date.parse(run_at) <= Date.now()) { setError({ message: '单次执行时间必须在未来，请按所填时区选择新的时间。' }); return; }
        setConfirmation({ mode, run_at, timezone: zone, confirm_cost: true });
      }
    } catch (cause) { setError(problem(cause)); }
  }

  async function save(input: ScheduleInput) {
    setSaving(true); setError(null); setSaved(false);
    try {
      const data = await send<{ schedule: ChapterSchedule | null }>(`${projectUrl(project.project.id)}/schedule`, 'PUT', input);
      setSchedule(data.schedule); setSaved(true); setConfirmation(null); onUpdated();
    } catch (cause) { setError(problem(cause)); }
    finally { setSaving(false); }
  }

  if (project.schedule === undefined) return (
    <section className="comic-format-panel paper-panel" aria-labelledby="schedule-heading">
      <div className="section-heading"><div><p className="eyebrow">仅当前作品 / NEXT CHAPTER</p><h2 id="schedule-heading">定时制作下一章</h2></div></div>
      <p className="section-description" role="status">当前本地服务尚不支持定时制作；更新后的服务重启后才能使用。现有服务与任务不会在这里被停止。</p>
    </section>
  );

  return (
    <section className="comic-format-panel paper-panel" aria-labelledby="schedule-heading" aria-busy={saving}>
      <div className="section-heading"><div><p className="eyebrow">仅当前作品 / NEXT CHAPTER</p><h2 id="schedule-heading">让下一章，按时落笔。</h2></div><span className={`status status-${statusTone}`} role="status"><span aria-hidden="true" />{statusLabel}</span></div>
      <div className="form-stack">
        <p className="section-description" id="schedule-help">默认关闭。每次触发只制作尚未导出的最早一章，由服务端到时确定，不是当前选中的章节。</p>
        <div className="confirmation-option">
          <strong>已保存的定时</strong>
          <p>{schedule ? schedule.mode === 'once' ? `仅一次 · ${localDateTime(schedule.run_at, schedule.timezone).replace('T', ' ')}（${schedule.timezone}）` : `每天 ${schedule.time}（${schedule.timezone}）` : '尚未设置，不会自动生成。'}</p>
          <p>下次触发：{schedule?.next_run_at ? <time dateTime={schedule.next_run_at}>{localDateTime(schedule.next_run_at, schedule.timezone).replace('T', ' ')}（{schedule.timezone}）</time> : '无已安排的触发'}</p>
          <p>下一未完成章节：{nextChapterLabel}</p>
          <p>上次执行章节：{schedule?.last_chapter != null ? `第 ${schedule.last_chapter} 章` : '尚未执行'}</p>
          <p role="status">执行消息：{schedule?.message ?? '暂无执行消息'}</p>
        </div>
        <form className="form-stack" onSubmit={openConfirmation}>
          <div className="segmented" role="group" aria-label="定时执行频率" aria-describedby="schedule-help"><button type="button" className={mode === 'once' ? 'active' : ''} aria-pressed={mode === 'once'} disabled={saving} onClick={() => { setMode('once'); setSaved(false); }}>仅一次</button><button type="button" className={mode === 'daily' ? 'active' : ''} aria-pressed={mode === 'daily'} disabled={saving} onClick={() => { setMode('daily'); setSaved(false); }}>每天</button></div>
          {mode === 'once' ? <label className="field"><span>单次执行日期与时间 <small>按下方时区</small></span><input type="datetime-local" required step={60} value={runAt} disabled={saving} onChange={(event) => { setRunAt(event.target.value); setSaved(false); }} /></label> : <label className="field"><span>每天执行时间 <small>按下方时区</small></span><input type="time" required step={60} value={time} disabled={saving} onChange={(event) => { setTime(event.target.value); setSaved(false); }} /></label>}
          <label className="field"><span>IANA 时区</span><input type="text" required value={timezone} placeholder="Asia/Shanghai" autoCapitalize="none" autoComplete="off" spellCheck={false} disabled={saving} aria-describedby="schedule-timezone-help" onChange={(event) => { setTimezone(event.target.value); setSaved(false); }} /><small id="schedule-timezone-help">默认使用浏览器时区；也可填写 America/New_York 等 IANA 名称。更改时区不会自动换算输入框里的时间。</small></label>
          <div className="panel-actions"><button className="button button-primary" type="submit" disabled={busy || saving}><Clock3 size={16} aria-hidden="true" />{schedule && schedule.status !== 'disabled' ? '更新并确认定时' : '启用并确认定时'}</button><button className="button button-quiet" type="button" disabled={busy || saving || !schedule || schedule.status === 'disabled'} onClick={() => void save({ mode: 'off' })}>{saving && <LoaderCircle size={16} className="spin" aria-hidden="true" />}关闭定时</button></div>
          {busy && <p className="field-help">当前工作区正在处理任务或设置，空闲后可启用或更新定时；关闭定时不会停止已启动的任务。</p>}
        </form>
        <p className="field-help">保存设置不计费；未来触发会调用模型并产生花费。关闭定时仅停止未来触发；已启动的任务请使用「停止任务」，已发出的请求仍可能计费。</p>
        <p className="field-help" id="schedule-server-help">必须保持本地服务运行和电脑唤醒；浏览器可以关闭。每个作品最多保留一个有效定时，更新会替换原设置。</p>
        <details className="run-options"><summary>定时运行与暂停规则</summary><p className="field-help">工作区繁忙时等待空闲；按已有进度续跑，不强制重新执行、不忽略预算、不自动锁定或重绘。缺少锁定设定、预算不足、失败、取消、画页待复核或分镜警告时暂停；全部章节已导出后完成。</p><p className="field-help">服务重启后，已过期的单次定时与中断的任务会暂停；每天定时跳到下一个未来时段，不补跑。强制重新导入原稿会清除定时，需要重新确认。</p></details>
        {saved && <p className="save-confirmation" role="status">{!schedule || schedule.status === 'disabled' ? '定时已关闭；已启动的任务不会因此停止。' : '定时已保存；设置本身不计费，未来触发将按预算规则计费。'}</p>}
        {error && !confirmation && <ErrorNotice error={error} />}
      </div>
      {confirmation && <Dialog title={schedule && schedule.status !== 'disabled' ? '替换定时，并授权未来计费？' : '启用定时，并授权未来计费？'} eyebrow={`${project.project.title} / 定时制作下一章`} busy={saving} onClose={() => setConfirmation(null)}>
        <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void save(confirmation); }}>
          <div className="confirmation-option"><strong>{confirmation.mode === 'once' ? '仅执行一次' : '每天制作一章'}</strong>{confirmation.mode === 'once' ? <><p>执行时间：<time dateTime={confirmation.run_at}>{localDateTime(confirmation.run_at, confirmation.timezone).replace('T', ' ')}（{confirmation.timezone}）</time></p><p>UTC：<code>{confirmation.run_at}</code></p></> : <p>每天 {confirmation.time}（{confirmation.timezone}），从下一个未来时段开始，不补跑错过的时段。</p>}</div>
          <p className="dialog-description">当前下一未完成章节：<strong>{nextChapterLabel}</strong>。触发时由服务端重新选择最早尚未导出的章节，不固定为当前选中章；工作区繁忙时等待空闲。</p>
          <div className="cost-warning"><CircleAlert size={19} aria-hidden="true" /><p><strong>确认即授权未来自动调用模型并产生花费，到时不再另行确认。</strong>保存设置本身不计费。{confirmation.mode === 'daily' && '每日触发可能持续产生新的花费，直至关闭、暂停或全部完成。'}仍检查工作区与项目预算，不自动锁定、重绘或突破上限。</p></div>
          <p className="field-help">必须保持本地服务运行和电脑唤醒，浏览器可以关闭。关闭定时不能取消已启动的任务。</p>
          {error && <ErrorNotice error={error} />}
          <div className="dialog-actions"><button className="button button-quiet" type="button" disabled={saving} onClick={() => setConfirmation(null)}>返回编辑</button><button className="button button-danger" type="submit" disabled={busy || saving}>{saving && <LoaderCircle size={16} className="spin" aria-hidden="true" />}确认定时并授权未来计费</button></div>
        </form>
      </Dialog>}
    </section>
  );
}

function localDateTime(value: string, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function onceRunAt(value: string, timezone: string) {
  const target = Date.parse(`${value}Z`);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = Date.parse(`${localDateTime(new Date(timestamp).toISOString(), timezone)}Z`);
    if (current === target) return new Date(timestamp).toISOString();
    timestamp += target - current;
  }
  throw new Error('所填时区不存在这个时间，请避开夏令时跳转时段。');
}
