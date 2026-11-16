import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/adapters/config.js";
import { startServer } from "../src/adapters/server.js";
import { Budget } from "../src/core/budget.js";
import { getCover, generateCover } from "../src/core/steps/cover.js";
import { createProject, importNovel } from "../src/core/project.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { saveStoryboard } from "../src/core/steps/adapt.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { renderChapter } from "../src/core/steps/render.js";
import { getStatus } from "../src/core/status.js";
import { fixture, MockAi, novel, png, storyboard } from "./helpers.js";

async function coverFixture(t: TestContext, enabled = true) {
  const ai = new MockAi();
  const f = await fixture(ai);
  await writeFile(join(f.root, "config.yaml"), `cover:\n  enabled: ${enabled}\nrefs:\n  candidates: 1\nexport:\n  pdf: false\n  reading_image_kb: null\n`);
  await createProject(f.workspace.store, "book", "青岚纪");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  await importNovel(handle.ctx, new TextEncoder().encode(novel));
  const styles = await generateRefs(handle.ctx, { kind: "style" });
  await lockRef(handle.ctx, styles.refs[0].id);
  return { ...f, ctx: handle.ctx, ai };
}

test("book covers default on without making project creation or import paid", async (t) => {
  const ai = new MockAi(), f = await fixture(ai);
  t.after(f.close);
  const loaded = await loadConfig(f.workspace.repository, f.root);
  assert.equal((loaded.defaults.cover as { enabled: boolean }).enabled, true);
  await createProject(f.workspace.store, "book", "Book");
  const h = await f.workspace.context("book");
  try { await importNovel(h.ctx, new TextEncoder().encode(novel)); }
  finally { await h.close(); }
  assert.equal(ai.imageCalls.length, 0);
  assert.equal(ai.structuredCalls.length, 0);
});

test("one cover is generated and repeated requests reuse the same immutable image and fee", async (t) => {
  const f = await coverFixture(t);
  const first = await generateCover(f.ctx), calls = f.ai.imageCalls.length;
  assert.equal(first.skipped, false);
  assert.equal(first.cover!.kind, "cover");
  assert.match(first.cover!.path!, /^refs\/cover\/.+\.png$/);
  assert.match(f.ai.imageCalls.at(-1)!.prompt, /青岚纪/);
  assert.match(f.ai.imageCalls.at(-1)!.prompt, /not a comic page/);
  const before = await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id");
  const next = await generateCover(f.ctx);
  assert.equal(next.skipped, true);
  assert.equal(next.cover!.id, first.cover!.id);
  assert.equal(f.ai.imageCalls.length, calls);
  assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id"), before);
  assert.deepEqual(await f.ctx.fs.readBytes(first.cover!.path!), png);
  assert.equal((await f.workspace.store.list())[0].cover_path, first.cover!.path);
  const status = await getStatus(f.ctx);
  assert.equal(status.cover!.id, first.cover!.id);
  assert.ok(status.refs.every((ref) => ref.kind !== "cover"));
});

test("explicit cover redraw preserves the original and keeps the previous cover if the redraw fails", async (t) => {
  const f = await coverFixture(t), first = await generateCover(f.ctx);
  const replacement = await generateCover(f.ctx, { force: true });
  assert.notEqual(replacement.cover!.id, first.cover!.id);
  assert.deepEqual(await f.ctx.fs.readBytes(first.cover!.path!), png);
  f.ai.onImage = () => { throw new Error("Generation failed"); };
  await assert.rejects(generateCover(f.ctx, { force: true }));
  assert.equal((await getCover(f.ctx))!.id, replacement.cover!.id);
  await assert.rejects(lockRef(f.ctx, replacement.cover!.id), /not locked as model references/);
});

test("disabled covers make no image requests", async (t) => {
  const f = await coverFixture(t, false), calls = f.ai.imageCalls.length;
  assert.deepEqual(await generateCover(f.ctx), { cover: null, skipped: true });
  assert.equal(f.ai.imageCalls.length, calls);
  assert.equal(await getCover(f.ctx), null);
});

test("chapter rendering creates one book cover and never mixes it into body pages", async (t) => {
  const f = await coverFixture(t);
  await prepareBook(f.ctx);
  for (const [kind, target] of [["outfit", "lin_qing.daily"], ["location", "qinglan_peak"]] as const) {
    const refs = await generateRefs(f.ctx, { kind, target });
    await lockRef(f.ctx, refs.refs[0].id);
  }
  await saveStoryboard(f.ctx, "001", [storyboard]);
  const first = await renderChapter(f.ctx, 1);
  const cover = await getCover(f.ctx), calls = f.ai.imageCalls.length;
  assert.equal(first.cover!.id, cover!.id);
  const page = await f.ctx.db.get<{ final_attempt_id: string }>("SELECT final_attempt_id FROM pages WHERE id='001-p01'");
  await renderChapter(f.ctx, 1);
  assert.equal(f.ai.imageCalls.length, calls);
  assert.deepEqual(await f.ctx.db.get("SELECT final_attempt_id FROM pages WHERE id='001-p01'"), page);
  await f.ctx.db.run("INSERT INTO chapters (id,idx,title,text,status) VALUES ('002',2,'再见',?,'imported')", [novel]);
  await saveStoryboard(f.ctx, "002", [storyboard]);
  await renderChapter(f.ctx, 2);
  assert.equal((await getCover(f.ctx))!.id, cover!.id);
  assert.equal(f.ai.imageCalls.length, calls + 1);
  assert.equal((await f.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM refs WHERE kind='cover'"))!.n, 1);
  assert.equal((await f.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM pages"))!.n, 2);
});

test("cover budget failures do not call the provider and can resume the uninvoked request", async (t) => {
  const f = await coverFixture(t), calls = f.ai.imageCalls.length;
  const policy = { limit_usd: 0, period: "none" as const, cycle_start_day: 1, timezone: "Asia/Shanghai" };
  f.ctx.budget = new Budget(f.workspace.ledger, "book", policy, null);
  await assert.rejects(generateCover(f.ctx), (error: { code?: number }) => error.code === 3);
  assert.equal(f.ai.imageCalls.length, calls);
  f.ctx.budget = new Budget(f.workspace.ledger, "book", { ...policy, limit_usd: 10 }, null);
  const result = await generateCover(f.ctx);
  assert.ok(result.cover);
  assert.equal(f.ai.imageCalls.length, calls + 1);
  assert.equal((await f.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM refs WHERE kind='cover'"))!.n, 1);
});

test("failed cover requests keep their fee estimate and do not silently generate another image", async (t) => {
  const f = await coverFixture(t);
  f.ai.onImage = () => { throw Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" }); };
  await assert.rejects(generateCover(f.ctx));
  const calls = f.ai.imageCalls.length, before = await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id");
  await assert.rejects(generateCover(f.ctx), /retained fees/);
  assert.equal(f.ai.imageCalls.length, calls);
  assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id"), before);
  assert.equal((await f.workspace.ledger.get<{ n: number }>("SELECT COUNT(*) AS n FROM spend WHERE estimated=1 AND cost_usd>0"))!.n, 1);
});

test("an explicit force retry appends a new cover after failure without discarding the earlier fee", async (t) => {
  const f = await coverFixture(t);
  f.ai.onImage = () => { throw Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" }); };
  await assert.rejects(generateCover(f.ctx));
  const before = await f.workspace.ledger.all<{ id: string; cost_usd: number }>("SELECT * FROM spend ORDER BY id");
  f.ai.onImage = undefined;
  const retried = await generateCover(f.ctx, { force: true });
  assert.ok(retried.cover);
  const after = await f.workspace.ledger.all<{ id: string; cost_usd: number }>("SELECT * FROM spend ORDER BY id");
  for (const row of before) assert.deepEqual(after.find((item) => item.id === row.id), row);
  assert.equal((await f.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM refs WHERE kind='cover'"))!.n, 2);
});

test("saved cover images recover after a selection-write interruption without re-generation", async (t) => {
  const f = await coverFixture(t), originalRun = f.ctx.db.run.bind(f.ctx.db);
  f.ctx.db.run = async (sql, params) => {
    if (sql.startsWith("UPDATE refs SET path")) throw new Error("Selection write interrupted");
    return originalRun(sql, params);
  };
  await assert.rejects(generateCover(f.ctx), /interrupted/);
  f.ctx.db.run = originalRun;
  const calls = f.ai.imageCalls.length, before = await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id");
  const restored = await generateCover(f.ctx);
  assert.equal(restored.skipped, true);
  assert.deepEqual(await f.ctx.fs.readBytes(restored.cover!.path!), png);
  assert.equal(f.ai.imageCalls.length, calls);
  assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id"), before);
});

test("a missing cover original blocks instead of spending again", async (t) => {
  const f = await coverFixture(t), first = await generateCover(f.ctx), calls = f.ai.imageCalls.length;
  await rm(join(f.root, "projects/book", first.cover!.path!));
  await assert.rejects(generateCover(f.ctx), /missing or changed/);
  assert.equal(f.ai.imageCalls.length, calls);
});

test("new-manuscript covers do not inherit stale characters or later outfits", async (t) => {
  const f = await coverFixture(t);
  await prepareBook(f.ctx);
  const refs = await generateRefs(f.ctx, { kind: "outfit", target: "lin_qing.daily" });
  await lockRef(f.ctx, refs.refs[0].id);
  const row = await f.ctx.db.get<{ spec: string }>("SELECT spec FROM characters WHERE id='lin_qing'");
  const character = JSON.parse(row!.spec);
  character.outfits.push({ ...character.outfits[0], id: "lin_qing.future", name: "后期战甲", chapters: [99] });
  await f.ctx.db.run("UPDATE characters SET spec = ? WHERE id='lin_qing'", [JSON.stringify(character)]);
  await generateCover(f.ctx);
  assert.doesNotMatch(f.ai.imageCalls.at(-1)!.prompt, /后期战甲/);
  await importNovel(f.ctx, new TextEncoder().encode("第一章 海岸\n\n白鹭在海岸静坐。"), { force: true });
  await generateCover(f.ctx);
  assert.equal(f.ai.imageCalls.at(-1)!.images.length, 1);
  assert.doesNotMatch(f.ai.imageCalls.at(-1)!.prompt, /林青|后期战甲/);
  assert.ok(await f.ctx.fs.readBytes(refs.refs[0].path!));
});

test("library covers follow the effective YAML title while preserving invalid-config repair access", async (t) => {
  const f = await coverFixture(t);
  await generateCover(f.ctx);
  await writeFile(join(f.root, "projects/book/project.yaml"), "id: book\ntitle: 新书名\n");
  const renamed = await f.workspace.context("book");
  try {
    const created = await generateCover(renamed.ctx);
    const listed = (await f.workspace.store.list())[0];
    assert.equal(listed.title, "新书名");
    assert.equal(listed.cover_path, created.cover!.path);
    assert.equal((await getCover(renamed.ctx))!.id, created.cover!.id);
  } finally { await renamed.close(); }
  await writeFile(join(f.root, "projects/book/project.yaml"), "title: [unterminated\n");
  assert.equal((await f.workspace.store.list())[0].title, "青岚纪");
});

test("reimporting another manuscript invalidates the current cover but preserves the previous original", async (t) => {
  const f = await coverFixture(t), first = await generateCover(f.ctx);
  await importNovel(f.ctx, new TextEncoder().encode(`${novel}\n\n林青又望向山间。`), { force: true });
  assert.equal(await getCover(f.ctx), null);
  const next = await generateCover(f.ctx);
  assert.notEqual(next.cover!.id, first.cover!.id);
  assert.deepEqual(await f.ctx.fs.readBytes(first.cover!.path!), png);
  assert.equal((await f.workspace.store.list())[0].cover_path, next.cover!.path);
});

test("first-cover failures expose a persisted retry flag and recover through a confirmed API retry", async (t) => {
  const f = await coverFixture(t);
  f.ai.onImage = () => { throw Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" }); };
  await assert.rejects(generateCover(f.ctx));
  const failed = await getStatus(f.ctx);
  assert.equal(failed.cover, null);
  assert.equal(failed.cover_retry_required, true);
  f.ai.onImage = undefined;
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  try {
    const started = await fetch(`${server.url}/api/projects/book/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cover", force: true }) });
    assert.equal(started.status, 202);
    let job: { status: string } | undefined;
    for (let i = 0; i < 100; i++) {
      job = (await (await fetch(`${server.url}/api/jobs/current`)).json()).job;
      if (job!.status !== "running") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job!.status, "completed");
    const current = await (await fetch(`${server.url}/api/projects/book`)).json();
    assert.ok(current.cover.image_url);
    assert.equal(current.cover_retry_required, false);
  } finally { await server.close(); }
});

test("cover API jobs expose the generated image to the book library without charging on reads", async (t) => {
  const f = await coverFixture(t), server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  try {
    const created = await fetch(`${server.url}/api/projects/book/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cover" }) });
    assert.equal(created.status, 202);
    let job: { status: string; error?: unknown } | undefined;
    for (let i = 0; i < 100; i++) {
      job = (await (await fetch(`${server.url}/api/jobs/current`)).json()).job;
      if (job!.status !== "running") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job!.status, "completed", JSON.stringify(job));
    const workspace = await (await fetch(`${server.url}/api/workspace`)).json();
    const url = workspace.projects[0].cover_url;
    assert.match(url, /^\/api\/projects\/book\/files\/refs\/cover\/.+\.png$/);
    assert.deepEqual(new Uint8Array(await (await fetch(`${server.url}${url}`)).arrayBuffer()), png);
    const before = f.ai.imageCalls.length;
    const detail = await (await fetch(`${server.url}/api/projects/book`)).json();
    assert.equal(detail.cover.image_url, url);
    assert.equal(f.ai.imageCalls.length, before);
  } finally { await server.close(); }
});
