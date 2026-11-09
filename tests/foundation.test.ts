import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProject, decodeNovel, importNovel, splitNovel } from "../src/core/project.js";
import { Budget, budgetReport, budgetWindow, priceUsage } from "../src/core/budget.js";
import { configSources, loadConfig, mergeConfig } from "../src/adapters/config.js";
import { LocalTemplateStore } from "../src/adapters/templates.js";
import { PromptEngine } from "../src/core/prompts.js";
import { fixture, novel } from "./helpers.js";

test("M0 creates a complete project and persists current selection", async () => {
  const f = await fixture();
  try {
    await createProject(f.workspace.store, "qinglan", "青岚纪");
    await f.workspace.selectProject("qinglan");
    assert.equal(await f.workspace.currentProject(), "qinglan");
    assert.deepEqual(await f.workspace.store.list(), [{ id: "qinglan", title: "青岚纪", chapter_count: 0, completed_chapters: 0 }]);
    await assert.rejects(createProject(f.workspace.store, "qinglan", "again"));
    await assert.rejects(createProject(f.workspace.store, "../outside", "invalid"));
  } finally { await f.close(); }
});

test("configuration deep-merges mappings, replaces arrays and tracks every origin", () => {
  assert.deepEqual(mergeConfig({ a: { x: 1, list: [1, 2] } }, { a: { y: 2, list: [3] } }), { a: { x: 1, y: 2, list: [3] } });
  assert.deepEqual(configSources([{ name: "repository", value: { a: { x: 1, list: [] } } }, { name: "project", value: { a: { x: 2 } } }]), { "a.x": "project", "a.list": "repository" });
});

test("three-level configuration and prompt overrides render strict unescaped templates", async () => {
  const f = await fixture();
  try {
    await createProject(f.workspace.store, "book", "Book");
    await writeFile(join(f.root, "config.yaml"), "image:\n  quality: medium\nprompts:\n  vars:\n    label: 'A&B'\n");
    const project = await f.workspace.store.open("book");
    await project.fs.writeText("project.yaml", "id: book\ntitle: Book\nimage:\n  quality: max\n");
    await project.db.close();
    const loaded = await loadConfig(f.workspace.repository, f.root, "book");
    assert.equal(loaded.config.image.quality, "max");
    assert.equal(loaded.config.storyboard.max_panels, 5);
    assert.equal(loaded.sources["image.quality"], "project");
    assert.equal(loaded.sources["storyboard.max_panels"], "repository");
    const store = new LocalTemplateStore(f.workspace.repository, f.root, "book");
    await store.put("partials/custom.md", "{{vars.label}}", "workspace");
    await store.put("sample.md", "{{> custom}} {{numbered paragraphs}}", "workspace");
    const engine = new PromptEngine(store, { vars: loaded.config.prompts.vars });
    assert.equal((await engine.render("sample", { paragraphs: ["甲", "乙"] })).text, "A&B [1] 甲\n[2] 乙");
    await store.put("sample.md", "{{missing_typo}}", "project");
    await assert.rejects(engine.render("sample"), /missing_typo/);
    assert.equal((await store.get("sample")).source, "project");
  } finally { await f.close(); }
});

test("budget windows honor Shanghai midnight, weekly Monday and end-of-month clamping", () => {
  const policy = { limit_usd: null, period: "month" as const, cycle_start_day: 1, timezone: "Asia/Shanghai" };
  assert.deepEqual(budgetWindow(policy, new Date("2026-10-31T17:00:00Z")), { start: "2026-10-31T16:00:00.000Z", reset_at: "2026-11-30T16:00:00.000Z" });
  assert.deepEqual(budgetWindow({ ...policy, period: "week" }, new Date("2026-11-09T00:00:00Z")), { start: "2026-11-08T16:00:00.000Z", reset_at: "2026-11-15T16:00:00.000Z" });
  assert.deepEqual(budgetWindow({ ...policy, cycle_start_day: 31 }, new Date("2026-02-28T12:00:00Z")), { start: "2026-02-27T16:00:00.000Z", reset_at: "2026-03-30T16:00:00.000Z" });
  assert.deepEqual(budgetWindow({ ...policy, period: "none" }), { start: null, reset_at: null });
});

test("ledger totals and atomic in-process reservations enforce workspace and project caps", async () => {
  const f = await fixture();
  try {
    const policy = { limit_usd: 0.2, period: "none" as const, cycle_start_day: 1, timezone: "Asia/Shanghai" };
    const budget = new Budget(f.workspace.ledger, "a", policy, { ...policy, limit_usd: 0.1 });
    const results = await Promise.allSettled([budget.begin("image", "model", 0.06, "first"), budget.begin("image", "model", 0.06, "second")]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") assert.equal(results[1].reason.code, 3);
    const id = results[0].status === "fulfilled" ? results[0].value : "";
    assert.equal((await budgetReport(f.workspace.ledger, policy)).spent_usd, 0.06);
    await budget.settle(id, 0.02, { input_tokens: 100, output_tokens: 50 });
    await budget.begin("review", "model", 0.06, "third");
    const report = await budgetReport(f.workspace.ledger, policy);
    assert.equal(report.spent_usd, 0.08);
    assert.equal(report.by_project[0].project_id, "a");
    assert.equal(report.by_step.length, 2);
    const blocked = new Budget(f.workspace.ledger, "b", { ...policy, limit_usd: 0.1 }, null);
    await assert.rejects(blocked.begin("image", "model", 0.03, "fourth"), (error: { code?: number }) => error.code === 3);
  } finally { await f.close(); }
});

test("usage pricing distinguishes text and image tokens and falls back to configured estimates", () => {
  const log = () => {};
  assert.deepEqual(priceUsage({ image: { text_in: 5, image_in: 8, image_out: 30 } }, "image", { input_tokens: 120, output_tokens: 20, text_input_tokens: 80, image_input_tokens: 40 }, 0.25, true, log), { cost: 0.00132, estimated: false });
  assert.deepEqual(priceUsage({}, "unknown", undefined, 0.4, true, log), { cost: 0.4, estimated: true });
});

test("novel import splits chapters, supports configured Markdown headings and archives forced imports", async () => {
  const f = await fixture();
  try {
    await createProject(f.workspace.store, "book", "青岚纪");
    const handle = await f.workspace.context("book");
    try {
      assert.equal(decodeNovel(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3])).text, "你好");
      const text = `${novel}\n\n第二章 归来\n\n林青下山。`;
      assert.equal(splitNovel(text, handle.ctx.config.import, "book").length, 2);
      assert.equal(splitNovel("### 第1章 山峰\n\n正文。", { chapter_regex: "^\\s*(?:#{1,6}\\s*)?第[0-9]+章.*$", strip_patterns: [] }, "book")[0].title, "### 第1章 山峰");
      const result = await importNovel(handle.ctx, new TextEncoder().encode(text));
      assert.equal(result.chapters, 2);
      await assert.rejects(importNovel(handle.ctx, new TextEncoder().encode(text)));
      await importNovel(handle.ctx, new TextEncoder().encode(novel), { force: true });
      assert.equal((await handle.ctx.db.all("SELECT id FROM chapters")).length, 1);
    } finally { await handle.close(); }
  } finally { await f.close(); }
});
