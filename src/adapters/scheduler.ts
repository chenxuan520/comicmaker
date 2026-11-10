import { ulid } from "ulid";
import type { ChapterSchedule, ScheduleInput } from "../../schemas/index.js";
import { PreconditionError } from "../core/errors.js";
import type { Db } from "../core/ports.js";
import type { WorkspaceRuntime } from "./runtime.js";

export async function readChapterSchedule(db: Db): Promise<ChapterSchedule | null> {
  const row = await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schedule.next'");
  return row ? JSON.parse(row.value) as ChapterSchedule : null;
}

export function nextDailyRun(time: string, timezone: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  const wallTime = (date: Date) => {
    const parts = formatter.formatToParts(date);
    const part = (name: string) => Number(parts.find((item) => item.type === name)!.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  };
  const local = new Date(wallTime(now));
  const [hour, minute] = time.split(":").map(Number);
  for (let day = 0; day < 3; day++) {
    const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, hour, minute);
    let candidate = target;
    for (let adjustment = 0; adjustment < 3; adjustment++) candidate += target - wallTime(new Date(candidate));
    if (candidate > now.getTime() && wallTime(new Date(candidate)) === target) return new Date(candidate).toISOString();
  }
  throw new PreconditionError("The daily time does not exist in the selected timezone");
}

export async function nextScheduledChapter(db: Db): Promise<{ idx: number; title: string } | null> {
  const flagged = await db.get<{ id: string }>("SELECT id FROM pages WHERE status = 'flagged' LIMIT 1");
  if (flagged) throw new PreconditionError("Resolve flagged pages before scheduled generation", { page_id: flagged.id });
  const reviews = await db.all<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key LIKE 'storyboard.review.%'");
  const warning = reviews.find((row) => { const review = JSON.parse(row.value); return review.completed && !review.passed; });
  if (warning) throw new PreconditionError("Resolve storyboard review warnings before scheduled generation", { chapter: warning.key.split(".").at(-1) });
  return await db.get<{ idx: number; title: string }>("SELECT idx, title FROM chapters WHERE status <> 'exported' ORDER BY idx LIMIT 1") ?? null;
}

export class ChapterScheduler {
  private readonly schedules = new Map<string, ChapterSchedule>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;

  constructor(
    private readonly workspace: WorkspaceRuntime,
    private readonly dispatch: (projectId: string, schedule: ChapterSchedule) => void,
    private readonly busy: () => boolean,
  ) {}

  private async save(projectId: string, db: Db, schedule: ChapterSchedule): Promise<void> {
    await db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schedule.next', ?)", [JSON.stringify(schedule)]);
    this.schedules.set(projectId, schedule);
  }

  async restore(): Promise<void> {
    const now = new Date();
    for (const project of await this.workspace.store.list()) {
      const handle = await this.workspace.store.open(project.id);
      try {
        let schedule = await readChapterSchedule(handle.db);
        if (!schedule) continue;
        if (schedule.status === "running") schedule = { ...schedule, status: "paused", next_run_at: null, message: "上次定时任务被中断，请检查进度与预算后重新启用。" };
        else if (schedule.status === "scheduled" && schedule.next_run_at && new Date(schedule.next_run_at) <= now) {
          schedule = schedule.mode === "once"
            ? { ...schedule, status: "paused", next_run_at: null, message: "预约时间已错过，请重新设置时间；不会自动补跑。" }
            : { ...schedule, next_run_at: nextDailyRun(schedule.time, schedule.timezone, now), message: "已跳过服务停机期间错过的时间，不补跑。" };
        }
        await this.save(project.id, handle.db, schedule);
      } finally { await handle.db.close(); }
    }
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  tick(now = new Date()): void {
    if (this.stopped || this.busy()) return;
    const due = [...this.schedules].filter(([, schedule]) => schedule.status === "scheduled" && schedule.next_run_at && new Date(schedule.next_run_at) <= now)
      .sort((a, b) => a[1].next_run_at!.localeCompare(b[1].next_run_at!))[0];
    if (due) this.dispatch(due[0], due[1]);
  }

  async get(projectId: string): Promise<ChapterSchedule | null> {
    const handle = await this.workspace.store.open(projectId);
    try { return await readChapterSchedule(handle.db); }
    finally { await handle.db.close(); }
  }

  async set(projectId: string, input: ScheduleInput): Promise<ChapterSchedule | null> {
    const handle = await this.workspace.store.open(projectId);
    try {
      if (input.mode === "off") {
        const schedule = await readChapterSchedule(handle.db);
        if (!schedule) return null;
        const disabled: ChapterSchedule = { ...schedule, status: "disabled", next_run_at: null, message: "定时生成已关闭。" };
        await this.save(projectId, handle.db, disabled);
        return disabled;
      }
      new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(new Date());
      const nextRun = input.mode === "once" ? new Date(input.run_at).toISOString() : nextDailyRun(input.time, input.timezone);
      if (new Date(nextRun) <= new Date()) throw new PreconditionError("Choose a future scheduled time");
      if (!await handle.db.get("SELECT id FROM chapters WHERE status <> 'exported' LIMIT 1")) throw new PreconditionError("Import a novel with unfinished chapters before scheduling");
      const schedule: ChapterSchedule = {
        ...(input.mode === "once" ? { mode: "once", run_at: nextRun, timezone: input.timezone } : { mode: "daily", time: input.time, timezone: input.timezone }),
        id: ulid(), status: "scheduled", next_run_at: nextRun, last_job_id: null, last_chapter: null, message: null,
      };
      await this.save(projectId, handle.db, schedule);
      return schedule;
    } finally { await handle.db.close(); }
  }

  async claim(projectId: string, db: Db, expected: ChapterSchedule, jobId: string): Promise<number | null> {
    const schedule = await readChapterSchedule(db);
    if (!schedule || schedule.id !== expected.id || schedule.status !== "scheduled") {
      this.forget(projectId);
      throw new PreconditionError("This schedule is no longer active");
    }
    const claimed: ChapterSchedule = { ...schedule, status: "running", next_run_at: null, last_job_id: jobId, message: null };
    await this.save(projectId, db, claimed);
    const chapter = await nextScheduledChapter(db);
    if (chapter) await this.save(projectId, db, { ...claimed, last_chapter: chapter.idx });
    return chapter?.idx ?? null;
  }

  async finish(projectId: string, scheduleId: string, outcome: { status: string; error?: { message: string } }, signal?: AbortSignal): Promise<void> {
    const handle = await this.workspace.store.open(projectId);
    try {
      const schedule = await readChapterSchedule(handle.db);
      if (!schedule || schedule.id !== scheduleId) { this.forget(projectId); return; }
      let updated: ChapterSchedule;
      if (signal?.aborted || outcome.status !== "completed") {
        updated = { ...schedule, status: "paused", next_run_at: null, message: outcome.error?.message ?? "任务已取消，请检查进度与预算后重新启用。" };
      } else {
        try {
          const next = await nextScheduledChapter(handle.db);
          updated = schedule.mode === "once" || !next
            ? { ...schedule, status: "completed", next_run_at: null, message: next ? "本次预约已完成。" : "全部章节已完成，定时生成已结束。" }
            : { ...schedule, status: "scheduled", next_run_at: nextDailyRun(schedule.time, schedule.timezone), message: "本章已完成，等待下次定时执行。" };
        } catch (error) {
          updated = { ...schedule, status: "paused", next_run_at: null, message: (error as Error).message };
        }
      }
      await this.save(projectId, handle.db, updated);
    } finally { await handle.db.close(); }
  }

  forget(projectId: string): void { this.schedules.delete(projectId); }
  stop(): void { this.stopped = true; clearInterval(this.timer); }
}
