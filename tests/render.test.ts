import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { createProject, importNovel } from "../src/core/project.js";
import { BudgetError } from "../src/core/errors.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { renderChapter, renderPage, redoPage } from "../src/core/steps/render.js";
import { exportChapter } from "../src/core/steps/export.js";
import { compareText, evaluateReview, normalizeText } from "../src/core/review.js";
import { exportFont } from "../src/adapters/runtime.js";
import { MockAi, fixture, mockOutput, novel, png, storyboard, visual } from "./helpers.js";
import type { Page } from "../src/core/types.js";

async function prepared(t: TestContext) {
  const ai = new MockAi();
  const f = await fixture(ai);
  await createProject(f.workspace.store, "book", "青岚纪");
  const handle = await f.workspace.context("book");
  t.after(async () => { await handle.close(); await f.close(); });
  const ctx = handle.ctx;
  ctx.config.refs.candidates = 1;
  ctx.config.image.retry_backoff_sec = [];
  await importNovel(ctx, new TextEncoder().encode(novel));
  await prepareBook(ctx);
  for (const kind of ["style", "outfit", "location"] as const) await lockRef(ctx, (await generateRefs(ctx, { kind })).refs[0].id);
  await ctx.db.run("INSERT INTO pages (id, chapter_id, page_no, storyboard, status) VALUES ('001-p01', '001', 1, ?, 'planned')", [JSON.stringify(storyboard)]);
  return { ...f, ...handle, ai };
}

test("text comparison normalizes punctuation and whitespace but never matches a different panel", () => {
  assert.equal(normalizeText(" 你 好... (来了?) "), "你好……（来了？）");
  assert.equal(normalizeText('“好了！”'), normalizeText('"好了!"'));
  const page = structuredClone(storyboard);
  page.panels[0].dialogue = [{ speaker: null, type: "speech", text: "甲。" }, { speaker: null, type: "speech", text: "乙。" }];
  page.panels[1].dialogue = [];
  page.panels[2].dialogue = [];
  const errors = compareText(page, { panels: [{ panel: 1, texts: ["乙。", "丙。"] }] });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].expected, "甲。");
  assert.equal(errors[0].actual, "丙。");
  assert.equal(compareText(page, { panels: [{ panel: 2, texts: ["甲。", "乙。"] }] }).length, 4);
  assert.equal(compareText(page, { panels: [{ panel: 1, texts: ["甲。", "乙。", "轰！"] }] }, ["^轰！$"]).length, 0);
});

test("review thresholds reject missing identities/colors and disabled checks do not reduce scores", async (t) => {
  const f = await prepared(t);
  const bad = { ...structuredClone(visual), characters: [] };
  assert.equal(evaluateReview(storyboard, [], bad, f.ctx.config.review).passed, false);
  const config = structuredClone(f.ctx.config.review);
  config.checks.identity = false;
  config.checks.color = false;
  assert.equal(evaluateReview(storyboard, [], bad, config).score, config.base_score);
  assert.equal(evaluateReview(storyboard, [], bad, config).passed, true);
  const mismatch = evaluateReview(storyboard, [], { ...visual, panel_count: 4 }, f.ctx.config.review);
  assert.equal(mismatch.passed, false);
  assert.equal(mismatch.panel_mismatch, true);
  const extra = { ...structuredClone(visual), characters: [...visual.characters, { panel: 1, char_id: "unexpected_person", identity_match: 0.2, color_match: 0.3, issue: null }] };
  assert.equal(evaluateReview(storyboard, [], extra, f.ctx.config.review).passed, false);
});

test("M2 retries a text error with exact corrections, preserves attempts, and skips passed pages", async (t) => {
  const f = await prepared(t);
  let textCalls = 0;
  f.ai.onStructured = (request) => {
    if (request.schema_name === "review_text" && ++textCalls === 1) return { panels: [{ panel: 1, texts: [] }, { panel: 2, texts: ["你走了。"] }, { panel: 3, texts: ["弟子来了。"] }] };
    return mockOutput(request);
  };
  const initialImages = f.ai.imageCalls.length;
  const result = await renderPage(f.ctx, "001-p01");
  assert.equal(result.status, "passed");
  assert.equal(f.ai.imageCalls.length - initialImages, 2);
  assert.match(f.ai.imageCalls.at(-1)!.prompt, /Panel 2 bubble must read exactly: "你来了。"/);
  assert.ok(await f.ctx.fs.readBytes("chapters/001/attempts/p01-a1.png"));
  assert.ok(await f.ctx.fs.readBytes("chapters/001/attempts/p01-a2.png"));
  assert.ok(await f.ctx.fs.readBytes("chapters/001/pages/p01.png"));
  const count = f.ai.imageCalls.length;
  assert.equal((await renderPage(f.ctx, "001-p01")).skipped, true);
  assert.equal(f.ai.imageCalls.length, count);
  f.ctx.config.review.max_attempts = 1;
  await redoPage(f.ctx, "001-p01", "Keep the mountain mist lighter.");
  assert.match(f.ai.imageCalls.at(-1)!.prompt, /Keep the mountain mist lighter/);
  assert.ok(await f.ctx.fs.readBytes("chapters/001/attempts/p01-a3.png"));
});

test("failed reviews choose the highest score, remain flagged after PDF and HTML export", async (t) => {
  const f = await prepared(t);
  f.ctx.config.export.reading_image_kb = null;
  f.ctx.config.review.max_attempts = 2;
  let visualCalls = 0;
  f.ai.onStructured = (request) => {
    if (request.schema_name === "review_text") return { panels: [] };
    if (request.schema_name === "review_visual" && ++visualCalls === 1) return { ...visual, characters: visual.characters.map((item) => ({ ...item, identity_match: 0.8 })) };
    return mockOutput(request);
  };
  const result = await renderChapter(f.ctx, 1);
  assert.deepEqual(result.flagged, ["001-p01"]);
  const selected = await f.ctx.db.get<{ seq: number }>("SELECT a.seq FROM attempts a JOIN pages p ON p.final_attempt_id = a.id WHERE p.id = '001-p01'");
  assert.equal(selected!.seq, 2);
  const font = await exportFont(f.ctx, f.root);
  if (!font) f.ctx.config.export.ai_notice_page = false;
  const exported = await exportChapter(f.ctx, 1, { font });
  assert.deepEqual(exported.flagged, ["001-p01"]);
  assert.equal((await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.status, "flagged");
  const pdf = await PDFDocument.load((await f.ctx.fs.readBytes(exported.pdf!))!);
  assert.equal(pdf.getPageCount(), font ? 2 : 1);
  assert.match((await f.ctx.fs.readText(exported.html!))!, /src="\.\.\/pages\/p01.png"/);
});

test("content refusals do not consume generation quota; only action and pose are rewritten", async (t) => {
  const f = await prepared(t);
  f.ctx.config.review.max_attempts = 1;
  let calls = 0;
  f.ai.onImage = () => { if (++calls === 1) throw Object.assign(new Error("content policy moderation refused"), { status: 400 }); };
  const result = await renderPage(f.ctx, "001-p01");
  assert.equal(result.status, "passed");
  const attempts = await f.ctx.db.all<{ status: string }>("SELECT status FROM attempts WHERE page_id = '001-p01' ORDER BY seq");
  assert.deepEqual(attempts.map((attempt) => attempt.status), ["refused", "ok"]);
  const page = JSON.parse((await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.storyboard);
  assert.deepEqual(page.panels.map((panel: { dialogue: unknown }) => panel.dialogue), storyboard.panels.map((panel) => panel.dialogue));
  assert.match(page.panels[0].action, /无血腥/);
  assert.equal(f.ai.structuredCalls.filter((request) => request.schema_name === "rewrite").length, 1);
});

test("repeated moderation refusals export a dialogue-only page instead of a broken image", async (t) => {
  const f = await prepared(t);
  f.ai.onImage = () => { throw Object.assign(new Error("moderation content policy"), { status: 400 }); };
  const rendered = await renderChapter(f.ctx, 1);
  assert.deepEqual(rendered.flagged, ["001-p01"]);
  assert.equal(f.ai.structuredCalls.filter((request) => request.schema_name === "rewrite").length, 2);
  assert.equal((await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.final_attempt_id, null);
  const font = await exportFont(f.ctx, f.root);
  if (!font) f.ctx.config.export.pdf = false;
  const exported = await exportChapter(f.ctx, 1, { font });
  const html = (await f.ctx.fs.readText(exported.html!))!;
  assert.match(html, /弟子来了。/);
  assert.ok(!html.includes("<img"));
  if (exported.pdf) assert.equal((await PDFDocument.load((await f.ctx.fs.readBytes(exported.pdf))!)).getPageCount(), 2);
});

test("timeouts are estimated and consume quota, while saved pending images resume without generation", async (t) => {
  const f = await prepared(t);
  f.ctx.config.review.max_attempts = 2;
  let calls = 0;
  f.ai.onImage = () => { if (++calls === 1) throw Object.assign(new Error("Request timed out"), { name: "APIConnectionTimeoutError" }); };
  await renderPage(f.ctx, "001-p01");
  const timeout = await f.workspace.ledger.get<{ cost_usd: number; estimated: number }>("SELECT s.cost_usd, s.estimated FROM spend s JOIN (SELECT id FROM spend WHERE step = 'image' ORDER BY created_at DESC LIMIT 2) recent ON recent.id = s.id WHERE s.estimated = 1");
  assert.equal(timeout!.cost_usd, f.ctx.config.budget.estimates.image);
  assert.equal(timeout!.estimated, 1);
  await f.ctx.db.run("INSERT INTO pages (id, chapter_id, page_no, storyboard, status) VALUES ('001-p02', '001', 2, ?, 'generating')", [JSON.stringify({ ...storyboard, page_no: 2 })]);
  await f.ctx.fs.writeImage("chapters/001/attempts/p02-a1.png", png);
  await f.ctx.db.run("INSERT INTO attempts (id, page_id, seq, status, path, prompt, ref_paths, cost_usd) VALUES ('pending-image', '001-p02', 1, 'pending', 'chapters/001/attempts/p02-a1.png', 'saved', '[]', 0.25)");
  const before = f.ai.imageCalls.length;
  assert.equal((await renderPage(f.ctx, "001-p02")).status, "passed");
  assert.equal(f.ai.imageCalls.length, before);
});

test("budget stop between OCR and visual review resumes without repeating OCR or image calls", async (t) => {
  const f = await prepared(t);
  let reviews = 0;
  const original = f.ctx.budget.begin.bind(f.ctx.budget);
  f.ctx.budget.begin = async (step, model, estimate, ref) => {
    if (step === "review" && ++reviews === 2) throw new BudgetError("Test cap reached", { scope: "workspace" });
    return original(step, model, estimate, ref);
  };
  await assert.rejects(renderPage(f.ctx, "001-p01"), (error: { code?: number }) => error.code === 3);
  const images = f.ai.imageCalls.length;
  const textCalls = f.ai.structuredCalls.filter((request) => request.schema_name === "review_text").length;
  f.ctx.budget.begin = original;
  assert.equal((await renderPage(f.ctx, "001-p01")).status, "passed");
  assert.equal(f.ai.imageCalls.length, images);
  assert.equal(f.ai.structuredCalls.filter((request) => request.schema_name === "review_text").length, textCalls);
});

test("a budget-blocked redo preserves the previous selected image and resumes the new cycle", async (t) => {
  const f = await prepared(t);
  await renderPage(f.ctx, "001-p01");
  const previous = await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'");
  const images = f.ai.imageCalls.length;
  const original = f.ctx.budget.begin.bind(f.ctx.budget);
  f.ctx.budget.begin = async () => { throw new BudgetError("Test cap reached", { scope: "workspace" }); };
  await assert.rejects(redoPage(f.ctx, "001-p01", "Keep the morning mist lighter"), (error: { code?: number }) => error.code === 3);
  assert.equal((await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.final_attempt_id, previous!.final_attempt_id);
  assert.ok(await f.ctx.fs.readBytes("chapters/001/pages/p01.png"));
  assert.equal(f.ai.imageCalls.length, images);
  f.ctx.budget.begin = original;
  await renderPage(f.ctx, "001-p01");
  assert.notEqual((await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.final_attempt_id, previous!.final_attempt_id);
  assert.match(f.ai.imageCalls.at(-1)!.prompt, /Keep the morning mist lighter/);
});

test("interruption preserves passed pages and only the unfinished page generates on resume", async (t) => {
  const f = await prepared(t);
  f.ctx.config.image.concurrency = 1;
  await f.ctx.db.run("INSERT INTO pages (id, chapter_id, page_no, storyboard, status) VALUES ('001-p02', '001', 2, ?, 'planned')", [JSON.stringify({ ...storyboard, page_no: 2 })]);
  const controller = new AbortController();
  f.ctx.signal = controller.signal;
  let calls = 0;
  f.ai.onImage = async (request) => {
    if (++calls === 2) {
      const promise = new Promise<void>((_, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
      controller.abort(new Error("Interrupted"));
      await promise;
    }
  };
  await assert.rejects(renderChapter(f.ctx, 1), /Interrupted/);
  assert.equal((await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.status, "passed");
  const before = f.ai.imageCalls.length;
  f.ctx.signal = undefined;
  f.ai.onImage = undefined;
  await renderChapter(f.ctx, 1);
  assert.equal(f.ai.imageCalls.length, before + 1);
  assert.equal((await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p02'"))!.status, "passed");
});
