import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import type { ChapterSchedule } from "../schemas/index.js";
import { nextDailyRun } from "../src/adapters/scheduler.js";
import { startServer, type Job } from "../src/adapters/server.js";
import { createProject, importNovel } from "../src/core/project.js";
import { runChapter } from "../src/core/pipeline.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { extraction, fixture, MockAi, mockOutput, novel, png } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
const baseTime = Date.parse("2030-11-10T14:59:00Z");
const onceInput = { mode: "once", run_at: "2030-11-10T15:00:00Z", timezone: "Asia/Shanghai", confirm_cost: true };
const dailyInput = { mode: "daily", time: "23:00", timezone: "Asia/Shanghai", confirm_cost: true };
const threeChapters = [1, 2, 3].map((idx) => novel.replace("第一章 青岚峰", `第${idx}章 青岚峰`)).join("\n\n");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function api(server: Server, path: string, input?: unknown, method = "PUT") {
  const response = await fetch(`${server.url}${path}`, input === undefined ? undefined : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return { status: response.status, data: await response.json() };
}

async function finished(server: Server): Promise<Job> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { data } = await api(server, "/api/jobs/current");
    if (data.job && data.job.status !== "running") return data.job as Job;
    await delay(5);
  }
  throw new Error("Scheduled job did not settle");
}

async function scheduleFixture(t: TestContext, ready = true) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: baseTime });
  const ai = new MockAi();
  ai.onStructured = (request) => {
    if (request.schema_name === "extract") {
      const result = structuredClone(extraction);
      result.characters[0].outfits[0].chapters = [1, 2, 3];
      result.locations[0].chapters = [1, 2, 3];
      return result;
    }
    if (request.schema_name === "summary") return { chapters: [1, 2, 3].map((chapter) => ({ chapter, summary: "林青在青岚峰与师父相见。" })) };
    return mockOutput(request);
  };
  const f = await fixture(ai);
  const servers: Server[] = [];
  const releases: (() => void)[] = [];
  t.after(async () => {
    for (const release of releases) release();
    for (const server of servers) if (server.server.listening) await server.close();
    await f.close();
  });
  await createProject(f.workspace.store, "book", "Scheduled Book");
  const handle = await f.workspace.context("book");
  try {
    await handle.ctx.fs.writeText("project.yaml", stringify({ id: "book", title: "Scheduled Book", refs: { candidates: 1 }, review: { max_attempts: 1 }, export: { pdf: false, reading_image_kb: null } }));
    await importNovel(handle.ctx, new TextEncoder().encode(threeChapters));
    if (ready) {
      handle.ctx.config.refs.candidates = 1;
      await prepareBook(handle.ctx);
      for (const [kind, target] of [["style", "project"], ["outfit", "lin_qing.daily"], ["location", "qinglan_peak"]] as const) {
        const result = await generateRefs(handle.ctx, { kind, target });
        await lockRef(handle.ctx, result.refs[0].id);
      }
    }
  } finally { await handle.close(); }
  const start = async () => {
    const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
    servers.push(server);
    return server;
  };
  return { ...f, ai, server: await start(), start, releases };
}

async function schedule(server: Server): Promise<ChapterSchedule | null> {
  const result = await api(server, "/api/projects/book/schedule");
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.schedule;
}

test("daily schedules respect timezone, day boundaries and daylight-saving skipped or repeated times", () => {
  assert.equal(nextDailyRun("23:00", "Asia/Shanghai", new Date("2030-11-10T14:59:00Z")), "2030-11-10T15:00:00.000Z");
  assert.equal(nextDailyRun("23:00", "Asia/Shanghai", new Date("2030-11-10T15:00:00Z")), "2030-11-11T15:00:00.000Z");
  assert.equal(nextDailyRun("00:15", "Asia/Tokyo", new Date("2030-12-31T15:10:00Z")), "2030-12-31T15:15:00.000Z");
  assert.equal(nextDailyRun("02:30", "America/New_York", new Date("2026-03-08T06:59:00Z")), "2026-03-09T06:30:00.000Z");
  assert.equal(nextDailyRun("01:30", "America/New_York", new Date("2026-11-01T04:00:00Z")), "2026-11-01T05:30:00.000Z");
  assert.equal(nextDailyRun("01:30", "America/New_York", new Date("2026-11-01T05:45:00Z")), "2026-11-02T06:30:00.000Z");
});

test("scheduling defaults off and saving a confirmed future appointment never starts generation immediately", async (t) => {
  const f = await scheduleFixture(t);
  const before = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  assert.equal(await schedule(f.server), null);
  assert.equal((await api(f.server, "/api/projects/book")).data.schedule, null);
  const enabled = await api(f.server, "/api/projects/book/schedule", onceInput);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.schedule.status, "scheduled");
  assert.equal(enabled.data.schedule.next_run_at, "2030-11-10T15:00:00.000Z");
  t.mock.timers.tick(30_000);
  assert.equal((await api(f.server, "/api/jobs/current")).data.job, null);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, before);
});

test("schedule validation requires fee confirmation, future times and valid timezone and cannot bypass budgets", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", onceInput);
  const original = await schedule(f.server);
  const invalid = [
    { input: { ...onceInput, confirm_cost: false }, status: 400 },
    { input: { mode: "once", run_at: onceInput.run_at, timezone: onceInput.timezone }, status: 400 },
    { input: { ...onceInput, run_at: "2030-11-10T14:00:00Z" }, status: 409 },
    { input: { ...dailyInput, time: "25:00" }, status: 400 },
    { input: { ...dailyInput, timezone: "not-a-timezone" }, status: 400 },
    { input: { ...onceInput, force: true }, status: 400 },
    { input: { ...onceInput, ignore_limit: true }, status: 400 },
  ];
  for (const item of invalid) {
    const result = await api(f.server, "/api/projects/book/schedule", item.input);
    assert.equal(result.status, item.status, JSON.stringify(result.data));
    assert.deepEqual(await schedule(f.server), original);
  }
  await createProject(f.workspace.store, "empty", "Empty");
  assert.equal((await api(f.server, "/api/projects/empty/schedule", onceInput)).status, 409);
});

test("one-time scheduling chooses the earliest unfinished chapter rather than max completed plus one", async (t) => {
  const f = await scheduleFixture(t);
  const handle = await f.workspace.context("book");
  try {
    handle.ctx.config.export.pdf = false;
    handle.ctx.config.export.reading_image_kb = null;
    await runChapter(handle.ctx, 1);
    await runChapter(handle.ctx, 3);
  } finally { await handle.close(); }
  const before = (await api(f.server, "/api/projects/book")).data;
  const refs = before.refs.map((ref: { id: string; path: string }) => ({ id: ref.id, path: ref.path }));
  const imageCount = f.ai.imageCalls.length;
  await api(f.server, "/api/projects/book/schedule", onceInput);
  t.mock.timers.tick(61_000);
  const job = await finished(f.server);
  assert.equal(job.status, "completed", JSON.stringify(job));
  assert.equal(job.source, "schedule");
  assert.equal(job.chapter, 2);
  assert.equal(f.ai.imageCalls.length, imageCount + 1);
  const after = (await api(f.server, "/api/projects/book")).data;
  assert.ok(after.chapters.every((chapter: { status: string }) => chapter.status === "exported"));
  assert.equal(after.schedule.status, "completed");
  assert.equal(after.schedule.last_chapter, 2);
  assert.deepEqual(after.refs.map((ref: { id: string; path: string }) => ({ id: ref.id, path: ref.path })), refs);
  assert.equal(after.pages.find((page: { chapter_id: string }) => page.chapter_id === "001").final_attempt_id, before.pages.find((page: { chapter_id: string }) => page.chapter_id === "001").final_attempt_id);
  t.mock.timers.tick(86_400_000);
  assert.equal(f.ai.imageCalls.length, imageCount + 1);
});

test("daily scheduling generates at most one chapter per occurrence and completes after the final chapter", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  for (const idx of [1, 2, 3]) {
    t.mock.timers.tick(idx === 1 ? 61_000 : 86_400_000);
    const job = await finished(f.server);
    assert.equal(job.status, "completed", JSON.stringify(job));
    assert.equal(job.chapter, idx);
    const saved = (await schedule(f.server))!;
    assert.equal(saved.last_chapter, idx);
    assert.equal(saved.status, idx === 3 ? "completed" : "scheduled");
    if (idx < 3) assert.equal(saved.next_run_at, `2030-11-${10 + idx}T15:00:00.000Z`);
  }
  const calls = f.ai.imageCalls.length;
  t.mock.timers.tick(86_400_000);
  assert.equal(f.ai.imageCalls.length, calls);
});

test("disabling and replacing a schedule do not execute the old appointment", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", onceInput);
  const original = (await schedule(f.server))!;
  assert.equal((await api(f.server, "/api/projects/book/schedule", { mode: "off" })).data.schedule.status, "disabled");
  const replacement = await api(f.server, "/api/projects/book/schedule", { ...onceInput, run_at: "2030-11-10T16:00:00Z" });
  assert.notEqual(replacement.data.schedule.id, original.id);
  t.mock.timers.tick(61_000);
  assert.equal((await api(f.server, "/api/jobs/current")).data.job, null);
  await api(f.server, "/api/projects/book/schedule", { mode: "off" });
  t.mock.timers.tick(3_600_000);
  assert.equal((await api(f.server, "/api/jobs/current")).data.job, null);
});

for (const mode of ["once", "daily"]) {
  test(`server restart preserves future ${mode} schedules and never catches up missed occurrences`, async (t) => {
    const f = await scheduleFixture(t);
    await api(f.server, "/api/projects/book/schedule", mode === "once" ? onceInput : dailyInput);
    const original = (await schedule(f.server))!;
    await f.server.close();
    const restarted = await f.start();
    assert.equal((await schedule(restarted))!.id, original.id);
    await restarted.close();
    const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
    t.mock.timers.tick(120_000);
    const late = await f.start();
    const saved = (await schedule(late))!;
    assert.equal(saved.status, mode === "once" ? "paused" : "scheduled");
    assert.equal(saved.next_run_at, mode === "once" ? null : "2030-11-11T15:00:00.000Z");
    assert.equal((await api(late, "/api/jobs/current")).data.job, null);
    assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
  });
}

test("due schedules wait for the workspace task gate instead of racing manual jobs", async (t) => {
  const f = await scheduleFixture(t);
  const entered = deferred();
  const release = deferred();
  f.releases.push(release.resolve);
  f.ai.onImage = async () => { entered.resolve(); await release.promise; };
  await api(f.server, "/api/projects/book/schedule", onceInput);
  const manual = await api(f.server, "/api/projects/book/actions", { action: "run", chapter: 3 }, "POST");
  assert.equal(manual.status, 202);
  await entered.promise;
  const calls = f.ai.imageCalls.length;
  t.mock.timers.tick(61_000);
  assert.equal((await api(f.server, "/api/jobs/current")).data.job.id, manual.data.job.id);
  assert.equal((await schedule(f.server))!.status, "scheduled");
  assert.equal(f.ai.imageCalls.length, calls);
  release.resolve();
  await finished(f.server);
  t.mock.timers.tick(1000);
  const job = await finished(f.server);
  assert.equal(job.source, "schedule");
  assert.equal(job.chapter, 1);
});

test("due schedules wait until an in-flight workspace mutation commits", async (t) => {
  const f = await scheduleFixture(t);
  const entered = deferred();
  const release = deferred();
  f.releases.push(release.resolve);
  const select = f.workspace.selectProject.bind(f.workspace);
  f.workspace.selectProject = async (id) => { await select(id); entered.resolve(); await release.promise; };
  await api(f.server, "/api/projects/book/schedule", onceInput);
  const creation = api(f.server, "/api/projects", { id: "other", title: "Other" }, "POST");
  await entered.promise;
  t.mock.timers.tick(61_000);
  assert.equal((await api(f.server, "/api/jobs/current")).data.job, null);
  assert.equal((await schedule(f.server))!.status, "scheduled");
  release.resolve();
  assert.equal((await creation).status, 201);
  t.mock.timers.tick(1000);
  assert.equal((await finished(f.server)).source, "schedule");
});

test("missing locked references pause scheduling without auto-locking or charging", async (t) => {
  const f = await scheduleFixture(t, false);
  const handle = await f.workspace.context("book");
  try { await prepareBook(handle.ctx); }
  finally { await handle.close(); }
  const count = f.ai.structuredCalls.length + f.ai.imageCalls.length;
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  t.mock.timers.tick(61_000);
  const job = await finished(f.server);
  assert.equal(job.status, "failed");
  assert.equal(job.error!.code, 2);
  assert.equal((await schedule(f.server))!.status, "paused");
  assert.match((await schedule(f.server))!.message!, /Lock/);
  assert.equal(f.ai.structuredCalls.length + f.ai.imageCalls.length, count);
  t.mock.timers.tick(86_400_000);
  assert.equal(f.ai.structuredCalls.length + f.ai.imageCalls.length, count);
  assert.deepEqual((await api(f.server, "/api/projects/book")).data.refs, []);
});

test("budget failures pause scheduling without bypassing or reserving beyond the limit", async (t) => {
  const f = await scheduleFixture(t);
  await writeFile(join(f.root, "config.yaml"), "budget:\n  limit_usd: 0\n  period: none\n");
  const before = (await api(f.server, "/api/budget")).data.spent_usd;
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  t.mock.timers.tick(61_000);
  const job = await finished(f.server);
  assert.equal(job.status, "failed");
  assert.equal(job.error!.code, 3);
  assert.equal((await schedule(f.server))!.status, "paused");
  assert.equal((await api(f.server, "/api/budget")).data.spent_usd, before);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
});

test("flagged scheduled pages pause subsequent daily chapters even when export completed", async (t) => {
  const f = await scheduleFixture(t);
  const structured = f.ai.onStructured!;
  f.ai.onStructured = (request) => request.schema_name === "review_visual"
    ? { panel_count: 3, characters: [], content: [], artifacts: [], fix_instructions: "Restore character identity" }
    : structured(request);
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  t.mock.timers.tick(61_000);
  const job = await finished(f.server);
  assert.equal(job.status, "completed");
  const project = (await api(f.server, "/api/projects/book")).data;
  assert.equal(project.chapters[0].status, "exported");
  assert.equal(project.pages[0].status, "flagged");
  assert.equal(project.schedule.status, "paused");
  assert.match(project.schedule.message, /flagged/);
  const calls = f.ai.imageCalls.length;
  t.mock.timers.tick(86_400_000);
  assert.equal(f.ai.imageCalls.length, calls);
});

test("existing flagged content prevents new scheduled model calls", async (t) => {
  const f = await scheduleFixture(t);
  const handle = await f.workspace.context("book");
  try { await handle.ctx.db.run("INSERT INTO pages (id, chapter_id, page_no, storyboard, status) VALUES ('001-p01', '001', 1, '{}', 'flagged')"); }
  finally { await handle.close(); }
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  await api(f.server, "/api/projects/book/schedule", onceInput);
  t.mock.timers.tick(61_000);
  assert.equal((await finished(f.server)).status, "failed");
  assert.equal((await schedule(f.server))!.status, "paused");
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
});

test("cancelling a scheduled request preserves estimated fees and leaves the schedule paused across restart", async (t) => {
  const f = await scheduleFixture(t);
  const entered = deferred();
  f.ai.onImage = async (request) => {
    entered.resolve();
    await new Promise<void>((_, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
  };
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  t.mock.timers.tick(61_000);
  await entered.promise;
  const current = (await api(f.server, "/api/jobs/current")).data.job;
  assert.equal((await schedule(f.server))!.status, "running");
  assert.equal((await api(f.server, "/api/projects/book/schedule", { mode: "off" })).status, 409);
  await api(f.server, `/api/jobs/${current.id}/cancel`, {}, "POST");
  assert.equal((await finished(f.server)).status, "cancelled");
  assert.equal((await schedule(f.server))!.status, "paused");
  const latest = await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT cost_usd, estimated FROM spend WHERE step = 'image' ORDER BY rowid DESC LIMIT 1");
  assert.deepEqual([latest!.cost_usd, latest!.estimated], [0.25, 1]);
  await f.server.close();
  t.mock.timers.tick(86_400_000);
  const restarted = await f.start();
  const calls = f.ai.imageCalls.length;
  t.mock.timers.tick(86_400_000);
  assert.equal((await schedule(restarted))!.status, "paused");
  assert.equal(f.ai.imageCalls.length, calls);
});

test("cancellation during schedule finalization stays effective and does not rearm daily generation", async (t) => {
  const f = await scheduleFixture(t);
  const entered = deferred();
  const release = deferred();
  f.releases.push(release.resolve);
  let finishing = false;
  const context = f.workspace.context.bind(f.workspace);
  f.workspace.context = async (id, options) => {
    const handle = await context(id, options);
    if (!options?.signal) return handle;
    return { ...handle, close: async () => { await handle.close(); finishing = true; } };
  };
  const open = f.workspace.store.open.bind(f.workspace.store);
  f.workspace.store.open = async (id) => {
    if (finishing) { finishing = false; entered.resolve(); await release.promise; }
    return open(id);
  };
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  t.mock.timers.tick(61_000);
  await entered.promise;
  const current = (await api(f.server, "/api/jobs/current")).data.job;
  assert.equal(current.status, "running");
  await api(f.server, `/api/jobs/${current.id}/cancel`, {}, "POST");
  release.resolve();
  assert.equal((await finished(f.server)).status, "cancelled");
  assert.equal((await schedule(f.server))!.status, "paused");
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  t.mock.timers.tick(86_400_000);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
});

test("reimporting a novel clears its schedule and retains locked immutable reference images", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", onceInput);
  const result = await fetch(`${f.server.url}/api/projects/book/import?force=true`, { method: "POST", body: novel });
  assert.equal(result.status, 200, await result.text());
  assert.equal(await schedule(f.server), null);
  t.mock.timers.tick(61_000);
  assert.equal((await api(f.server, "/api/jobs/current")).data.job, null);
  const handle = await f.workspace.context("book");
  try {
    const refs = await handle.ctx.db.all<{ path: string; status: string }>("SELECT path, status FROM refs");
    assert.equal(refs.length, 3);
    for (const ref of refs) {
      assert.equal(ref.status, "locked");
      assert.deepEqual(await handle.ctx.fs.readBytes(ref.path), png);
    }
  } finally { await handle.close(); }
});

test("restarting after an interrupted persisted job pauses rather than silently retrying", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  const saved = (await schedule(f.server))!;
  await f.server.close();
  const handle = await f.workspace.store.open("book");
  try {
    await handle.db.run("UPDATE meta SET value = ? WHERE key = 'schedule.next'", [JSON.stringify({ ...saved, status: "running", last_job_id: "interrupted-job", last_chapter: 1, next_run_at: null })]);
  } finally { await handle.db.close(); }
  const restarted = await f.start();
  assert.equal((await schedule(restarted))!.status, "paused");
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  t.mock.timers.tick(86_400_000);
  assert.equal((await api(restarted, "/api/jobs/current")).data.job, null);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
});

test("project configuration failures pause the plan and still allow disabling it", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  await writeFile(join(f.root, "projects/book/project.yaml"), "storyboard:\n  min_panels: 8\n  max_panels: 2\n");
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  t.mock.timers.tick(61_000);
  assert.equal((await finished(f.server)).status, "failed");
  assert.equal((await schedule(f.server))!.status, "paused");
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
  assert.equal((await api(f.server, "/api/projects/book/schedule", { mode: "off" })).status, 200);
  assert.equal((await schedule(f.server))!.status, "disabled");
});

test("storyboard review warnings pause scheduling before any new model calls", async (t) => {
  const f = await scheduleFixture(t);
  const handle = await f.workspace.store.open("book");
  try {
    await handle.db.run("INSERT INTO meta (key, value) VALUES ('storyboard.review.001', ?)", [JSON.stringify({ completed: true, passed: false, issues: [] })]);
  } finally { await handle.db.close(); }
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  await api(f.server, "/api/projects/book/schedule", dailyInput);
  t.mock.timers.tick(61_000);
  assert.equal((await finished(f.server)).status, "failed");
  assert.match((await schedule(f.server))!.message!, /storyboard review/);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
});

test("schedule persistence failures cannot automatically resume generation when storage recovers", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", onceInput);
  let failWrites = true;
  const open = f.workspace.store.open.bind(f.workspace.store);
  f.workspace.store.open = async (id) => {
    const handle = await open(id);
    const run = handle.db.run.bind(handle.db);
    handle.db.run = async (sql, params) => {
      if (failWrites && sql.includes("VALUES ('schedule.next'")) throw new Error("Simulated schedule storage failure");
      return run(sql, params);
    };
    return handle;
  };
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  t.mock.timers.tick(61_000);
  const failed = await finished(f.server);
  assert.equal(failed.status, "failed");
  assert.match(failed.error!.message, /storage failure/);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
  failWrites = false;
  t.mock.timers.tick(1000);
  assert.equal((await api(f.server, "/api/jobs/current")).data.job.id, failed.id);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
  const enabled = await api(f.server, "/api/projects/book/schedule", { ...onceInput, run_at: "2030-11-10T15:02:00Z" });
  assert.equal(enabled.status, 200);
  t.mock.timers.tick(120_000);
  const resumed = await finished(f.server);
  assert.equal(resumed.status, "completed", JSON.stringify(resumed));
  assert.notEqual(resumed.id, failed.id);
  assert.equal(resumed.chapter, 1);
});

test("closing the server clears schedule timers and never dispatches pending appointments", async (t) => {
  const f = await scheduleFixture(t);
  await api(f.server, "/api/projects/book/schedule", onceInput);
  const calls = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  await f.server.close();
  t.mock.timers.tick(86_400_000);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, calls);
});
