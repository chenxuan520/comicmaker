import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { parse } from "yaml";
import { configSchema, type Adaptation, type Config, type PageStoryboard, type StoryboardIssue } from "../schemas/index.js";
import { SqliteDb } from "../src/adapters/sqlite.js";
import { Budget } from "../src/core/budget.js";
import { entitiesForChapter } from "../src/core/data.js";
import { ComicError, PreconditionError } from "../src/core/errors.js";
import type { AiProvider, LogLevel, ProjectFs, StructuredRequest, TemplateStore } from "../src/core/ports.js";
import { PromptEngine } from "../src/core/prompts.js";
import { renderStepPrompt } from "../src/core/pipeline.js";
import { getStatus } from "../src/core/status.js";
import { adaptChapter, patchStoryboard, saveStoryboard } from "../src/core/steps/adapt.js";
import { exportChapter } from "../src/core/steps/export.js";
import { redoPage, renderChapter } from "../src/core/steps/render.js";
import { addLocationChapter, addOutfitChapter } from "../src/core/steps/prepare.js";
import { countChineseCharacters, validateStoryboard } from "../src/core/storyboardCheck.js";
import type { Bible, Chapter, Context, Page, Ref } from "../src/core/types.js";

const defaults = configSchema.parse(parse(await readFile(new URL("../config.default.yaml", import.meta.url), "utf8")));

function makeConfig(storyboard: Partial<Config["storyboard"]> = {}): Config {
  return configSchema.parse({ ...structuredClone(defaults), storyboard: { ...defaults.storyboard, ...storyboard } });
}

function makeBible(ids = ["hero"]): Bible {
  const outfits: Bible["outfits"] = ids.map((id) => ({ id: `${id}.daily`, name: "Daily", desc: null, main_color: null, accent_color: null, chapters: [1, 2] }));
  return {
    characters: ids.map((id, index) => ({
      id, name: id, aliases: [], role: null, gender: null, age_look: null, height_build: null,
      face: null, hair: null, hair_color: null, eye_color: null, skin: null, marks: null,
      outfits: [outfits[index]], evidence: [],
    })),
    outfits,
    locations: [{ id: "mountain", name: "Mountain", desc: null, palette: null, chapters: [1, 2] }],
  };
}

function makeRefs(bible: Bible): Ref[] {
  return [
    { id: "style", kind: "style", target_id: "project", path: "refs/style/style.png", sha256: "hash", prompt: "", status: "locked" },
    ...bible.outfits.map((outfit): Ref => ({ id: outfit.id, kind: "outfit", target_id: outfit.id, path: `refs/characters/${outfit.id}/ref.png`, sha256: "hash", prompt: "", status: "locked" })),
    ...bible.locations.map((location): Ref => ({ id: location.id, kind: "location", target_id: location.id, path: `refs/locations/${location.id}/ref.png`, sha256: "hash", prompt: "", status: "locked" })),
  ];
}

function makeAdaptation(): Adaptation {
  return {
    scenes: [{
      id: "s1", location_id: "mountain", time: null, characters: [{ id: "hero", outfit: "hero.daily" }],
      beats: [{ id: "b1", src_paras: [1], importance: 2, action: "hero enters Mountain", dialogue: [{ speaker: "hero", type: "speech", text: "\u4f60\u6765\u4e86\u3002" }] }],
    }],
    suggested_pages: 1,
  };
}

function makePage(pageNo = 1): PageStoryboard {
  return {
    page_no: pageNo, layout: "1 wide | 2",
    panels: Array.from({ length: 3 }, (_, index) => ({
      id: `p${index + 1}`, row: index === 0 ? 1 : 2, size: index === 0 ? "wide" : "medium",
      shot: "\u8fdc\u666f", angle: "\u5e73\u89c6", location_id: "mountain", time: null,
      characters: [{ id: "hero", outfit: "hero.daily", pose: "standing", expression: "neutral", position: "\u5de6" }],
      action: `Page ${pageNo}, panel ${index + 1}`,
      dialogue: index === 0 ? [{ speaker: "hero", type: "speech", text: "\u4f60\u6765\u4e86\u3002" }] : [],
      beat_ids: index === 0 ? ["b1"] : [],
    })),
  };
}

function makeStrip(pageNo = 1): PageStoryboard {
  const page = makePage(pageNo);
  return {
    ...page, layout: "strip-4",
    panels: Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(page.panels[0]), id: `p${index + 1}`, row: index + 1, size: "wide",
      dialogue: index === 0 ? page.panels[0].dialogue : [], beat_ids: index === 0 ? ["b1"] : [],
    })),
  };
}

const pass = { pass: true, issues: [] };
const issue = (page = 1): StoryboardIssue => ({ page, panel: "p1", type: "faithfulness", detail: "The action changes the source meaning", fix: "Restore the original action on this page" });

async function harness(t: TestContext, responses: unknown[] = [], bible = makeBible(), config = makeConfig()) {
  const db = new SqliteDb(":memory:");
  const ledger = new SqliteDb(":memory:", "ledger");
  t.after(async () => { await db.close(); await ledger.close(); });
  const refs = makeRefs(bible);
  const bytes = new Map(refs.map((ref) => [ref.path!, new Uint8Array([1, 2, 3])]));
  const json = new Map<string, unknown>();
  const jsonWrites: string[] = [];
  const unused = async (): Promise<never> => { throw new Error("Unexpected image/file operation"); };
  const fs: ProjectFs = {
    writeImage: unused, replaceCopy: unused, writeReadingCopy: unused, writeText: unused, writeBytes: unused, writeNovel: unused,
    readText: async () => null,
    exists: unused,
    readBytes: async (path) => bytes.get(path) ?? null,
    writeJson: async (path, value) => { json.set(path, structuredClone(value)); jsonWrites.push(path); },
  };
  const calls: StructuredRequest[] = [];
  const queue = [...responses];
  const ai: AiProvider = {
    ready() {}, image: unused,
    async structured(request) {
      calls.push(request);
      const response = queue.shift();
      if (response instanceof Error) throw response;
      assert.notEqual(response, undefined, `Unexpected ${request.schema_name} call`);
      return { text: JSON.stringify(response), usage: { input_tokens: 10, output_tokens: 10 } };
    },
  };
  const templates: TemplateStore = {
    get: async (name) => ({ name, content: name.endsWith("/system.md") ? "{{project.title}}" : "{{json this}}", source: "repository" }),
    list: async () => [], put: unused,
  };
  const project = { id: "test", title: "Test novel", style_desc: "Test style" };
  const logs: { level: LogLevel; message: string; details?: unknown }[] = [];
  const ctx: Context = {
    project, config, db, fs, ai, budget: new Budget(ledger, project.id, config.budget, null),
    prompts: new PromptEngine(templates, { project, config, vars: {} }),
    log: (level, message, details) => { logs.push({ level, message, details }); },
  };
  await db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('001', 1, 'Chapter one', ?, 'Chapter summary', 'imported')", ["hero enters Mountain.\n\nhero stops."]);
  await db.run("INSERT INTO meta (key, value) VALUES ('prepare.extract.completed', 'true'), ('prepare.summary.completed', 'true')");
  for (const character of bible.characters) await db.run("INSERT INTO characters (id, name, aliases, spec) VALUES (?, ?, ?, ?)", [character.id, character.name, JSON.stringify(character.aliases), JSON.stringify(character)]);
  for (const outfit of bible.outfits) await db.run("INSERT INTO outfits (id, character_id, name, spec, chapters) VALUES (?, ?, ?, ?, ?)", [outfit.id, outfit.id.split(".")[0], outfit.name, JSON.stringify(outfit), JSON.stringify(outfit.chapters)]);
  for (const location of bible.locations) await db.run("INSERT INTO locations (id, name, spec) VALUES (?, ?, ?)", [location.id, location.name, JSON.stringify(location)]);
  for (const ref of refs) await db.run("INSERT INTO refs (id, kind, target_id, path, sha256, prompt, status) VALUES (?, ?, ?, ?, ?, ?, ?)", [ref.id, ref.kind, ref.target_id, ref.path, ref.sha256, ref.prompt, ref.status]);
  return { ctx, db, ledger, calls, json, jsonWrites, bytes, logs };
}

async function seedHistory(h: Awaited<ReturnType<typeof harness>>, pageNo: number, seq: number) {
  const pageId = `001-p${String(pageNo).padStart(2, "0")}`;
  const id = `${pageId}-attempt-${seq}`;
  const path = `chapters/001/attempts/p${String(pageNo).padStart(2, "0")}-a${seq}.png`;
  await h.db.run("INSERT INTO attempts (id, page_id, seq, status, path, prompt) VALUES (?, ?, ?, 'ok', ?, ?)", [id, pageId, seq, path, `Historical prompt for ${id}`]);
  await h.db.run("INSERT INTO reviews (id, attempt_id, score, passed) VALUES (?, ?, 100, 1)", [`review-${id}`, id]);
  await h.db.run("UPDATE pages SET status = 'passed', final_attempt_id = ? WHERE id = ?", [id, pageId]);
  h.bytes.set(path, new Uint8Array([pageNo, seq]));
  h.bytes.set(`chapters/001/pages/p${String(pageNo).padStart(2, "0")}.png`, new Uint8Array([pageNo, seq]));
  return id;
}

async function cacheScenes(h: Awaited<ReturnType<typeof harness>>, adaptation = makeAdaptation()) {
  await h.db.run("INSERT INTO adaptations (chapter_id, scenes, version) VALUES ('001', ?, 1)", [JSON.stringify(adaptation.scenes)]);
  await h.db.run("UPDATE chapters SET status = 'adapted' WHERE id = '001'");
}

test("Chinese counting includes Han code points and Chinese punctuation, not Latin or whitespace", () => {
  assert.equal(countChineseCharacters("\u4f60\u597d\uff0c\u4e16\u754c\uff01 Hello 123\n\t"), 6);
  assert.equal(countChineseCharacters("\u201c\u4f60\u597d\u2026\u2026\u201d"), 6);
  assert.equal(countChineseCharacters("\u{20000}\u3007"), 2);
  assert.equal(countChineseCharacters("abc 123!?.,\t\n\u3000\uff21\uff12"), 0);
  assert.equal(countChineseCharacters(""), 0);
});

test("valid storyboards do not require render-time color checks", () => {
  const bible = makeBible();
  assert.deepEqual(validateStoryboard([makePage()], makeAdaptation().scenes, bible, makeRefs(bible), makeConfig()), []);
});

test("comic format defaults to page and rejects unknown formats", () => {
  const legacy = structuredClone(defaults);
  delete (legacy.storyboard as Partial<Config["storyboard"]>).format;
  assert.equal(configSchema.parse(legacy).storyboard.format, "page");
  assert.throws(() => makeConfig({ format: "horizontal" as Config["storyboard"]["format"] }));
});

test("strip storyboards use four full-width rows rather than paged panel limits", () => {
  const bible = makeBible();
  assert.deepEqual(validateStoryboard([makeStrip()], makeAdaptation().scenes, bible, makeRefs(bible), makeConfig({ format: "strip", min_panels: 1, max_panels: 1 })), []);
  assert.ok(validateStoryboard([makeStrip()], makeAdaptation().scenes, bible, makeRefs(bible), makeConfig()).some((issue) => issue.detail.includes("Paged format")));
});

test("strip storyboards reject grids, out-of-order rows, and non-wide panels", () => {
  const bible = makeBible();
  const strip = makeStrip();
  const short = { ...strip, panels: strip.panels.slice(0, 3) };
  const long = { ...strip, panels: [...strip.panels, { ...strip.panels[3], id: "p5", row: 5 }] };
  const grid = { ...strip, layout: "2 | 2" };
  const rows = structuredClone(strip);
  rows.panels[1].row = 1;
  const narrow = structuredClone(strip);
  narrow.panels[1].size = "medium";
  for (const page of [short, long, grid, rows, narrow]) {
    const issues = validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), makeConfig({ format: "strip" }));
    assert.ok(issues.some((issue) => issue.type === "pacing" && /strip/i.test(issue.detail)));
  }
});

test("changing generation format leaves completed pages and selected images untouched", async (t) => {
  const page = makePage();
  const h = await harness(t, [makeAdaptation(), { pages: [page] }, pass]);
  await adaptChapter(h.ctx, 1);
  const attempt = await seedHistory(h, 1, 1);
  const calls = h.calls.length;
  const original = structuredClone(h.bytes.get("chapters/001/pages/p01.png"));
  h.ctx.config.storyboard.format = "strip";
  const result = await adaptChapter(h.ctx, 1) as { skipped: boolean };
  const status = await getStatus(h.ctx, 1);
  assert.equal(result.skipped, true);
  assert.equal(h.calls.length, calls);
  assert.equal(status.comic_format, "strip");
  assert.equal(status.pages[0].format, "page");
  assert.deepEqual(status.pages[0].storyboard, page);
  assert.equal(status.pages[0].final_attempt_id, attempt);
  assert.deepEqual(h.bytes.get("chapters/001/pages/p01.png"), original);
});

test("panel and bubble limits come from configuration", () => {
  const bible = makeBible();
  const config = makeConfig({ min_panels: 2, max_panels: 2, max_bubble_chars: 2, max_bubbles_per_panel: 1 });
  const page = makePage();
  page.panels[0].dialogue.push({ speaker: null, type: "narration", text: "Latin only 123" });
  const issues = validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), config);
  assert.ok(issues.some((issue) => issue.detail.includes("allowed range is 2-2")));
  assert.ok(issues.some((issue) => issue.detail.includes("2 bubbles; maximum is 1")));
  assert.ok(issues.some((issue) => issue.detail.includes("4 Chinese characters/punctuation; maximum is 2")));
  assert.ok(issues.every((issue) => issue.type === "pacing"));
  page.panels = page.panels.slice(0, 2);
  page.panels[0].dialogue = [{ speaker: "hero", type: "speech", text: "\u4f60\u597d LATIN 123" }];
  assert.deepEqual(validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), config), []);
});

test("page character limits count unique visible characters, not appearances", () => {
  const bible = makeBible(["hero", "ally"]);
  const config = makeConfig({ max_chars_per_page: 1 });
  const page = makePage();
  assert.deepEqual(validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), config), []);
  page.panels[1].characters = [{ ...page.panels[1].characters[0], id: "ally", outfit: "ally.daily" }];
  assert.ok(validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), config).some((issue) => issue.type === "pacing" && issue.detail.includes("2 unique characters")));
});

test("important beats need coverage and climax beats need a large or wide placement", () => {
  const bible = makeBible();
  const adaptation = makeAdaptation();
  adaptation.scenes[0].beats[0].importance = 1;
  adaptation.scenes[0].beats.push({ ...structuredClone(adaptation.scenes[0].beats[0]), id: "b2", importance: 3 });
  const page = makePage();
  page.panels[0].beat_ids = [];
  assert.ok(validateStoryboard([page], adaptation.scenes, bible, makeRefs(bible), makeConfig()).some((issue) => issue.type === "omission" && issue.detail.includes("b2")));
  page.panels[1].beat_ids = ["b2"];
  assert.ok(validateStoryboard([page], adaptation.scenes, bible, makeRefs(bible), makeConfig()).some((issue) => issue.type === "pacing" && issue.detail.includes("no large or wide")));
  page.panels[1].size = "large";
  assert.deepEqual(validateStoryboard([page], adaptation.scenes, bible, makeRefs(bible), makeConfig()), []);
  page.panels = [page.panels[1]];
  page.panels[0].size = "small";
  page.layout = "1";
  assert.deepEqual(validateStoryboard([page], adaptation.scenes, bible, makeRefs(bible), makeConfig({ min_panels: 1, max_panels: 1 })), []);
});

test("beats requiring emphasis still need coverage when the coverage threshold is higher", () => {
  const bible = makeBible();
  const config = makeConfig({ coverage_min_importance: 3, emphasis_min_importance: 2 });
  const page = makePage();
  page.panels[0].beat_ids = [];
  assert.ok(validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), config).some((issue) => issue.type === "omission" && issue.detail.includes("b1")));
  page.panels[1].beat_ids = ["b1"];
  assert.ok(validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), config).some((issue) => issue.type === "pacing" && issue.detail.includes("no large or wide")));
  page.panels[1].size = "large";
  assert.deepEqual(validateStoryboard([page], makeAdaptation().scenes, bible, makeRefs(bible), config), []);
});

test("unknown IDs, outfit ownership, and unlocked references are faithfulness issues", () => {
  const bible = makeBible(["hero", "ally"]);
  const page = makePage();
  page.panels[0].characters[0].outfit = "ally.daily";
  page.panels[1].characters[0] = { ...page.panels[1].characters[0], id: "stranger", outfit: "stranger.daily" };
  page.panels[1].location_id = "unknown_location";
  page.panels[2].beat_ids = ["b99"];
  page.panels[0].dialogue[0].speaker = "stranger";
  const refs = makeRefs(bible).map((ref): Ref => ({ ...ref, status: "candidate" }));
  const issues = validateStoryboard([page], makeAdaptation().scenes, bible, refs, makeConfig());
  for (const text of ["does not belong", "Unknown character", "Unknown outfit", "Unknown location", "Unknown beat", "Unknown dialogue speaker", "style reference is not locked", "no locked reference"]) {
    assert.ok(issues.some((issue) => issue.type === "faithfulness" && issue.detail.includes(text)), text);
  }
});

test("character IDs are unique within a panel, not across panels or pages", () => {
  const bible = makeBible();
  const refs = makeRefs(bible);
  const pages = [makePage(1), makePage(2)];
  assert.deepEqual(validateStoryboard(pages, makeAdaptation().scenes, bible, refs, makeConfig()), []);
  pages[0].panels[0].characters.push({ ...pages[0].panels[0].characters[0], pose: "an unnamed wolf pouncing", position: "右" });
  const duplicates = validateStoryboard(pages, makeAdaptation().scenes, bible, refs, makeConfig()).filter((issue) => issue.detail.includes("Duplicate character ID"));
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].page, 1);
  assert.equal(duplicates[0].panel, "p1");
  assert.equal(duplicates[0].type, "faithfulness");
  assert.match(duplicates[0].detail, /hero/);
});

test("page/panel/beat definitions are unique, but panel IDs and beat placements may repeat across pages", () => {
  const bible = makeBible();
  const refs = makeRefs(bible);
  assert.deepEqual(validateStoryboard([makePage(1), makePage(2)], makeAdaptation().scenes, bible, refs, makeConfig()), []);
  const pages = [makePage(), makePage()];
  pages[0].panels[1].id = "p1";
  pages[0].panels[0].beat_ids.push("b1");
  const adaptation = makeAdaptation();
  adaptation.scenes.push(structuredClone(adaptation.scenes[0]));
  const issues = validateStoryboard(pages, adaptation.scenes, bible, refs, makeConfig());
  for (const text of ["Duplicate page number", "Duplicate panel ID", "Duplicate scene ID", "Duplicate beat ID", "Duplicate beat reference"]) assert.ok(issues.some((issue) => issue.detail.includes(text)), text);
  assert.ok(validateStoryboard([makePage(2)], makeAdaptation().scenes, bible, refs, makeConfig()).some((issue) => issue.page === 1 && issue.detail.includes("Missing page")));
  assert.ok(validateStoryboard([], makeAdaptation().scenes, bible, refs, makeConfig()).some((issue) => issue.detail.includes("empty")));
});

test("large page numbers produce bounded, actionable consecutive-page issues", () => {
  const bible = makeBible();
  for (const pages of [[makePage(10_000)], [makePage(1), makePage(10_000)], [makePage(3), makePage(1)]]) {
    const issues = validateStoryboard(pages, makeAdaptation().scenes, bible, makeRefs(bible), makeConfig());
    assert.equal(issues.length, 1);
    assert.equal(issues[0].page, pages.length);
    assert.match(issues[0].detail, new RegExp(`Missing page ${pages.length}`));
  }
});

test("adaptation, storyboard and independent review persist the required DB and mirror shapes", async (t) => {
  const adaptation = makeAdaptation();
  const page = makePage();
  const h = await harness(t, [adaptation, { pages: [page] }, pass]);
  assert.deepEqual(await adaptChapter(h.ctx, 1), { chapter: "001", pages: 1, passed: true, issues: [], revisions: 0, skipped: false });
  assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard_review"]);
  assert.deepEqual(h.calls.map((call) => call.model), [h.ctx.config.models.adapt, h.ctx.config.models.storyboard, h.ctx.config.models.storyboard_review]);
  const adaptData = JSON.parse(h.calls[0].user);
  assert.equal(adaptData.prev_summary, "");
  assert.deepEqual(adaptData.chapter.paragraphs, ["hero enters Mountain.", "hero stops."]);
  assert.deepEqual(JSON.parse(h.calls[1].user).review_issues, []);
  assert.deepEqual(JSON.parse(h.calls[2].user).storyboard, { pages: [page] });
  const stored = await h.db.get<{ scenes: string; version: number }>("SELECT scenes, version FROM adaptations WHERE chapter_id = '001'");
  assert.deepEqual(JSON.parse(stored!.scenes), adaptation.scenes);
  assert.equal(stored!.version, 1);
  assert.deepEqual(h.json.get("chapters/001/adaptation.json"), adaptation);
  assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: [page] });
  assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.review.001'"))!.value), { completed: true, passed: true, issues: [] });
  assert.equal((await h.db.get<Chapter>("SELECT * FROM chapters WHERE id = '001'"))!.status, "storyboarded");
  const row = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'");
  assert.equal(row!.status, "planned");
  assert.equal(row!.final_attempt_id, null);
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p01'"))!.value, "0");
  assert.equal((await h.ledger.all("SELECT * FROM spend")).length, 3);

  await h.db.run("UPDATE chapters SET status = 'exported' WHERE id = '001'");
  await h.db.run("DELETE FROM meta WHERE key LIKE 'prepare.%'");
  const writes = h.jsonWrites.length;
  assert.deepEqual(await adaptChapter(h.ctx, "001"), { chapter: "001", pages: 1, passed: true, issues: [], skipped: true });
  assert.equal(h.calls.length, 3);
  assert.equal(h.jsonWrites.length, writes);
  assert.equal((await h.db.get<Chapter>("SELECT * FROM chapters WHERE id = '001'"))!.status, "exported");
});

test("later chapters receive the preceding chapter summary", async (t) => {
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass]);
  await h.db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('002', 2, 'Chapter two', 'hero enters Mountain.', 'Second summary', 'imported')");
  await adaptChapter(h.ctx, 2);
  assert.equal(JSON.parse(h.calls[0].user).prev_summary, "Chapter summary");
  assert.equal(JSON.parse(h.calls[1].user).chapter.id, "002");
  assert.ok(h.json.has("chapters/002/storyboard.json"));
});

test("storyboard review receives chapter-relevant settings and preceding context", async (t) => {
  const bible = makeBible(["hero", "absent"]);
  bible.characters[0].marks = "An established old hand injury";
  bible.outfits[1].chapters = [3];
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass], bible);
  await h.db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('002', 2, 'Chapter two', 'hero enters Mountain.', 'Second summary', 'imported')");
  await adaptChapter(h.ctx, 2);
  const review = JSON.parse(h.calls.find((call) => call.schema_name === "storyboard_review")!.user);
  assert.equal(review.prev_summary, "Chapter summary");
  assert.deepEqual(review.characters, [bible.characters[0]]);
  assert.deepEqual(review.outfits, [bible.outfits[0]]);
});

for (const key of ["prepare.extract.completed", "prepare.summary.completed"]) {
  test(`adaptation requires ${key}`, async (t) => {
    const h = await harness(t);
    await h.db.run("DELETE FROM meta WHERE key = ?", [key]);
    await assert.rejects(adaptChapter(h.ctx, 1), (error: unknown) => error instanceof PreconditionError && error.code === 2 && (error.details as { missing: string }).missing === key);
    assert.equal(h.calls.length, 0);
  });
}

test("chapter characters without relevant outfits are listed as precondition failures", async (t) => {
  const bible = makeBible();
  bible.outfits[0].chapters = [2];
  const h = await harness(t, [], bible);
  await assert.rejects(adaptChapter(h.ctx, 1), (error: unknown) => error instanceof PreconditionError && error.message.includes("hero (hero)") && (error.details as { characters: string[] }).characters.includes("hero"));
  assert.equal(h.calls.length, 0);
});

test("existing outfit chapter association is sourced, free and preserves refs and prior selections", async (t) => {
  const bible = makeBible();
  bible.outfits[0].chapters = [1];
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass], bible);
  await saveStoryboard(h.ctx, "001", [makePage()]);
  await seedHistory(h, 1, 2);
  await h.db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('002', 2, 'Chapter two', 'hero enters Mountain.', 'Second summary', 'imported')");
  await assert.rejects(adaptChapter(h.ctx, 2), /without chapter-relevant outfits/);
  const pages = await h.db.all("SELECT * FROM pages");
  const refs = await h.db.all("SELECT * FROM refs ORDER BY id");
  const attempts = await h.db.all("SELECT * FROM attempts ORDER BY id");
  const reviews = await h.db.all("SELECT * FROM reviews ORDER BY id");
  const meta = await h.db.all("SELECT * FROM meta ORDER BY key");
  const images = [...h.bytes.entries()];
  assert.deepEqual(await addOutfitChapter(h.ctx, "hero.daily", 2, 1), { chapter: "002", outfit: "hero.daily", source: "2:1", skipped: false });
  assert.equal(h.calls.length, 0);
  assert.equal((await h.ledger.all("SELECT * FROM spend")).length, 0);
  assert.deepEqual(await h.db.all("SELECT * FROM pages"), pages);
  assert.deepEqual(await h.db.all("SELECT * FROM refs ORDER BY id"), refs);
  assert.deepEqual(await h.db.all("SELECT * FROM attempts ORDER BY id"), attempts);
  assert.deepEqual(await h.db.all("SELECT * FROM reviews ORDER BY id"), reviews);
  assert.deepEqual(await h.db.all("SELECT * FROM meta ORDER BY key"), meta);
  assert.deepEqual([...h.bytes.entries()], images);
  const saved = await h.db.get<{ spec: string; chapters: string }>("SELECT spec, chapters FROM outfits WHERE id = 'hero.daily'");
  assert.deepEqual(JSON.parse(saved!.chapters), [1, 2]);
  assert.deepEqual(JSON.parse(saved!.spec), { ...bible.outfits[0], chapters: [1, 2] });
  assert.deepEqual((h.json.get("bible/characters.json") as Bible["characters"])[0].evidence, ["2:1"]);
  assert.deepEqual((h.json.get("bible/characters.json") as Bible["characters"])[0].outfits[0].chapters, [1, 2]);
  assert.deepEqual(await addOutfitChapter(h.ctx, "hero.daily", 2, 1), { chapter: "002", outfit: "hero.daily", source: "2:1", skipped: true });
  await h.db.run("UPDATE refs SET status = 'candidate' WHERE target_id = 'hero.daily'");
  await assert.rejects(adaptChapter(h.ctx, 2), /Lock the missing reference images/);
  assert.equal(h.calls.length, 0);
  await h.db.run("UPDATE refs SET status = 'locked' WHERE target_id = 'hero.daily'");
  await adaptChapter(h.ctx, 2);
  assert.equal(h.calls.length, 3);
});

test("existing location chapter association preserves all other settings and old rendering state", async (t) => {
  const bible = makeBible();
  bible.locations[0].name = "旧屋";
  bible.locations[0].chapters = [1];
  const h = await harness(t, [], bible);
  await saveStoryboard(h.ctx, "001", [makePage()]);
  await seedHistory(h, 1, 2);
  await h.db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('002', 2, 'Chapter two', 'hero回家。', 'Second summary', 'imported')");
  const chapter = (await h.db.get<Chapter>("SELECT * FROM chapters WHERE id = '002'"))!;
  assert.deepEqual(entitiesForChapter(bible, chapter).locations, []);
  const tables = ["outfits", "characters", "refs", "pages", "attempts", "reviews", "meta"];
  const old = await Promise.all(tables.map((table) => h.db.all(`SELECT * FROM ${table}`)));
  assert.deepEqual(await addLocationChapter(h.ctx, "mountain", 2, 1), { chapter: "002", location: "mountain", source: "2:1", skipped: false });
  assert.deepEqual(await Promise.all(tables.map((table) => h.db.all(`SELECT * FROM ${table}`))), old);
  const location = JSON.parse((await h.db.get<{ spec: string }>("SELECT spec FROM locations WHERE id = 'mountain'"))!.spec);
  assert.deepEqual(location, { ...bible.locations[0], chapters: [1, 2] });
  assert.deepEqual(h.json.get("bible/locations.json"), [location]);
  assert.deepEqual(await addLocationChapter(h.ctx, "mountain", 2, 1), { chapter: "002", location: "mountain", source: "2:1", skipped: true });
  const saved = await h.db.all("SELECT * FROM locations");
  for (const [target, paragraph] of [["unknown", 1], ["mountain", 0], ["mountain", 2]] as const) await assert.rejects(addLocationChapter(h.ctx, target, 2, paragraph), PreconditionError);
  assert.deepEqual(await h.db.all("SELECT * FROM locations"), saved);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.ledger.all("SELECT * FROM spend")).length, 0);
});

test("outfit chapter association rejects unknown targets and invalid source paragraphs before writing", async (t) => {
  const h = await harness(t);
  const saved = await h.db.all("SELECT * FROM outfits");
  const characters = await h.db.all("SELECT * FROM characters");
  for (const [outfit, chapter, paragraph] of [["unknown", 1, 1], ["hero.daily", 99, 1], ["hero.daily", 1, 0], ["hero.daily", 1, 3], ["hero.daily", 1, "x"]] as const) {
    await assert.rejects(addOutfitChapter(h.ctx, outfit, chapter, paragraph), PreconditionError);
  }
  assert.deepEqual(await h.db.all("SELECT * FROM outfits"), saved);
  assert.deepEqual(await h.db.all("SELECT * FROM characters"), characters);
  assert.equal(h.calls.length, 0);
  assert.equal(h.jsonWrites.length, 0);
});

test("later chapters do not require comparison-only characters' outfits or locked references", async (t) => {
  const bible = makeBible(["hero", "father"]);
  bible.characters[1].name = "主角父亲";
  bible.characters[1].aliases = ["父亲"];
  bible.characters[1].evidence = ["1:1"];
  bible.outfits[1].chapters = [1];
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass], bible);
  await h.db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('002', 2, 'Chapter two', ?, 'Second summary', 'imported')", ["hero enters Mountain.\n\nhero看起来比主角父亲年轻。"]);
  await h.db.run("UPDATE refs SET status = 'candidate' WHERE target_id = 'father.daily'");
  await adaptChapter(h.ctx, 2);
  assert.deepEqual(JSON.parse(h.calls[0].user).characters.map((character: { id: string }) => character.id), ["hero"]);
  assert.deepEqual(JSON.parse(h.calls[0].user).outfits.map((outfit: { id: string }) => outfit.id), ["hero.daily"]);
  assert.equal(h.calls.length, 3);
  assert.equal((await h.db.get<Ref>("SELECT * FROM refs WHERE target_id = 'father.daily'"))!.status, "candidate");
});

test("family and generic-owner references do not require absent characters' outfits", async (t) => {
  const bible = makeBible(["hero", "traveler", "companion"]);
  bible.characters[1].name = "山中修士";
  bible.characters[2].name = "陶顺";
  for (let index = 1; index < bible.characters.length; index++) {
    bible.characters[index].evidence = ["1:1"];
    bible.outfits[index].chapters = [1];
  }
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass], bible);
  await h.db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('002', 2, 'Chapter two', ?, 'Second summary', 'imported')", ["hero enters Mountain.\n说陶顺的家人收过信，又问起陶顺家的近况。铺里有一只山中修士常用的旧囊。"]);
  await h.db.run("UPDATE refs SET status = 'candidate' WHERE target_id IN ('traveler.daily', 'companion.daily')");
  await adaptChapter(h.ctx, 2);
  assert.deepEqual(JSON.parse(h.calls[0].user).characters.map((character: { id: string }) => character.id), ["hero"]);
  assert.deepEqual(JSON.parse(h.calls[0].user).outfits.map((outfit: { id: string }) => outfit.id), ["hero.daily"]);
  assert.equal(h.calls.length, 3);
  assert.equal((await h.db.get<Ref>("SELECT * FROM refs WHERE target_id = 'traveler.daily'"))!.status, "candidate");
  assert.equal((await h.db.get<Ref>("SELECT * FROM refs WHERE target_id = 'companion.daily'"))!.status, "candidate");
});

test("new generic cargo owners do not reintroduce the earlier cargo owner", () => {
  for (const [text, evidence, chapters, included] of [
    ["新来的货主围着看。", [], [1], false],
    ["新来的货主围着看。货主来到Mountain。", [], [1], true],
    ["新来的货主围着看。", ["2:1"], [1], true],
    ["新来的货主围着看。", [], [2], true],
  ] as const) {
    const bible = makeBible(["hero", "owner"]);
    bible.characters[1].name = "货主";
    bible.characters[1].aliases = [];
    bible.characters[1].evidence = [...evidence];
    bible.outfits[1].chapters = [...chapters];
    const chapter: Chapter = { id: "002", idx: 2, title: "Chapter two", text, summary: null, status: "imported" };
    assert.equal(entitiesForChapter(bible, chapter).characters.some((character) => character.id === "owner"), included, text);
  }
});

test("comparison filtering preserves real mentions, chapter evidence and outfit associations", () => {
  for (const [scenario, text, evidence, chapters, included] of [
    ["comparison alias", "hero比父亲年轻。", [], [1], false],
    ["family-only reference", "hero提起主角父亲的家人收过信。", [], [1], false],
    ["family-only reference without 的", "hero提起主角父亲家收过信。", [], [1], false],
    ["generic-owner reference", "铺里有主角父亲常用的旧囊。", [], [1], false],
    ["receipt recipient only", "面前放着写给主角父亲的收条。", [], [1], false],
    ["receipt recipient and real appearance", "写给主角父亲的收条还在。主角父亲来到Mountain。", [], [1], true],
    ["family reference and real appearance", "主角父亲的家人收过信。主角父亲来到Mountain。", [], [1], true],
    ["owner reference and real appearance", "有主角父亲常用的旧囊。主角父亲来到Mountain。", [], [1], true],
    ["reference with chapter evidence", "主角父亲的家人收过信。", ["2:1"], [1], true],
    ["reference with chapter outfit", "主角父亲常用的旧囊。", [], [2], true],
    ["another real mention", "hero比主角父亲年轻。主角父亲来到Mountain。", [], [1], true],
    ["chapter evidence", "hero比主角父亲年轻。", ["2:1"], [1], true],
    ["chapter outfit", "hero比主角父亲年轻。", [], [2], true],
    ["unscoped outfit", "主角父亲来到Mountain。", [], [], true],
    ["missing outfit", "主角父亲来到Mountain。", [], null, true],
  ] as const) {
    const bible = makeBible(["hero", "father"]);
    bible.characters[1].name = "主角父亲";
    bible.characters[1].aliases = ["父亲"];
    bible.characters[1].evidence = [...evidence];
    if (chapters === null) bible.outfits = bible.outfits.filter((outfit) => outfit.id !== "father.daily");
    else bible.outfits[1].chapters = [...chapters];
    const chapter: Chapter = { id: "002", idx: 2, title: "Chapter two", text, summary: null, status: "imported" };
    assert.equal(entitiesForChapter(bible, chapter).characters.some((character) => character.id === "father"), included, scenario);
  }
});

for (const kind of ["style", "outfit", "location"]) {
  test(`adaptation requires locked ${kind} images`, async (t) => {
    const h = await harness(t);
    await h.db.run("UPDATE refs SET status = 'candidate' WHERE kind = ?", [kind]);
    await assert.rejects(adaptChapter(h.ctx, 1), (error: unknown) => error instanceof PreconditionError && (error.details as { missing: { kind: string }[] }).missing.some((item) => item.kind === kind));
    assert.equal(h.calls.length, 0);
  });
}

test("locked image bytes must exist, but unrelated chapter references need not be locked", async (t) => {
  const bible = makeBible(["hero", "ally"]);
  bible.outfits[1].chapters = [2];
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass], bible);
  await h.db.run("UPDATE refs SET status = 'candidate' WHERE target_id = 'ally.daily'");
  const path = "refs/characters/hero.daily/ref.png";
  const bytes = h.bytes.get(path)!;
  h.bytes.delete(path);
  await assert.rejects(adaptChapter(h.ctx, 1), PreconditionError);
  assert.equal(h.calls.length, 0);
  h.bytes.set(path, bytes);
  await adaptChapter(h.ctx, 1);
  assert.deepEqual(JSON.parse(h.calls[0].user).characters.map((character: { id: string }) => character.id), ["hero"]);
});

const invalidAdaptations: [string, (adaptation: Adaptation) => void, string][] = [
  ["paragraphs outside the actual chapter", (adaptation) => { adaptation.scenes[0].beats[0].src_paras = [3]; }, "within 1-2"],
  ["empty source paragraph provenance", (adaptation) => { adaptation.scenes[0].beats[0].src_paras = []; }, "within 1-2"],
  ["duplicate scenes", (adaptation) => { adaptation.scenes.push(structuredClone(adaptation.scenes[0])); }, "Duplicate scene ID"],
  ["duplicate beats", (adaptation) => { adaptation.scenes[0].beats.push(structuredClone(adaptation.scenes[0].beats[0])); }, "Duplicate beat ID"],
  ["unknown characters", (adaptation) => { adaptation.scenes[0].characters[0].id = "stranger"; }, "unknown character"],
  ["unknown outfits", (adaptation) => { adaptation.scenes[0].characters[0].outfit = "hero.other"; }, "unknown outfit"],
  ["outfits owned by another character", (adaptation) => { adaptation.scenes[0].characters[0].outfit = "ally.daily"; }, "does not belong"],
  ["unknown locations", (adaptation) => { adaptation.scenes[0].location_id = "elsewhere"; }, "unknown location"],
  ["unknown speakers", (adaptation) => { adaptation.scenes[0].beats[0].dialogue[0].speaker = "stranger"; }, "unknown speaker"],
  ["empty scenes", (adaptation) => { adaptation.scenes = []; }, "no scenes"],
  ["empty beats", (adaptation) => { adaptation.scenes[0].beats = []; }, "no beats"],
];
for (const [name, change, detail] of invalidAdaptations) {
  test(`adaptation rejects ${name} before persistence`, async (t) => {
    const adaptation = makeAdaptation();
    change(adaptation);
    const h = await harness(t, [adaptation], makeBible(["hero", "ally"]));
    await assert.rejects(adaptChapter(h.ctx, 1), (error: unknown) => error instanceof ComicError && (error.details as { issues: string[] }).issues.some((issue) => issue.includes(detail)));
    assert.equal(h.calls.length, 1);
    assert.equal(await h.db.get("SELECT * FROM adaptations WHERE chapter_id = '001'"), undefined);
    assert.equal((await h.db.get<Chapter>("SELECT * FROM chapters WHERE id = '001'"))!.status, "imported");
    assert.ok(!h.json.has("chapters/001/adaptation.json"));
  });
}

test("program-invalid revisions exhaust the limit as an error without calling independent review", async (t) => {
  const bad = makePage();
  bad.panels = bad.panels.slice(0, 2);
  const h = await harness(t, [makeAdaptation(), { pages: [bad] }, { pages: [bad] }], makeBible(), makeConfig({ max_revisions: 1 }));
  await assert.rejects(adaptChapter(h.ctx, 1), (error: unknown) => error instanceof ComicError && error.message.includes("program validation after 1 revisions"));
  assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard"]);
  assert.ok(JSON.parse(h.calls[2].user).review_issues.some((issue: StoryboardIssue) => issue.type === "pacing"));
  assert.equal((await h.db.all("SELECT * FROM pages")).length, 0);
  assert.equal((await h.db.get<Chapter>("SELECT * FROM chapters WHERE id = '001'"))!.status, "adapted");
  assert.ok(!h.json.has("chapters/001/storyboard.json"));
  assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"))!.value), { pages: [bad], revisions: 1 });
  await assert.rejects(adaptChapter(h.ctx, 1), /program validation after 1 revisions/);
  assert.equal(h.calls.length, 3);
});

test("program revisions fill a missing page and may append new pages", async (t) => {
  const p1 = makePage(1);
  const p3 = makePage(3);
  const p2 = makePage(2);
  const p4 = makePage(4);
  const h = await harness(t, [makeAdaptation(), { pages: [p1, p3] }, { pages: [p2, p4] }, pass], makeBible(), makeConfig({ max_revisions: 1 }));
  await adaptChapter(h.ctx, 1);
  assert.deepEqual(JSON.parse(h.calls[2].user).review_issues.map((issue: StoryboardIssue) => issue.page), [2]);
  assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: [p1, p2, p3, p4] });
});

for (const [scenario, pageNumbers] of [
  ["single outlier", [10_000]],
  ["outlier with untouched first page", [1, 10_000]],
  ["duplicate valid number", [1, 1]],
  ["duplicate outlier", [10_000, 10_000]],
] as const) {
  test(`program numbering repair handles ${scenario} in one revision`, async (t) => {
    const p1 = makePage(1);
    const p2 = makePage(2);
    const regenerated = structuredClone(p1);
    regenerated.panels[0].action = "Regenerated first page";
    const initial = pageNumbers.map((pageNo) => makePage(pageNo));
    const replacements = initial.length === 1 ? [p1] : [regenerated, p2];
    const expected = scenario === "outlier with untouched first page" ? [p1, p2] : replacements;
    const h = await harness(t, [makeAdaptation(), { pages: initial }, { pages: replacements }, pass], makeBible(), makeConfig({ max_revisions: 1 }));
    assert.deepEqual(await adaptChapter(h.ctx, 1), { chapter: "001", pages: expected.length, passed: true, issues: [], revisions: 1, skipped: false });
    assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard", "storyboard_review"]);
    assert.ok(JSON.parse(h.calls[2].user).review_issues.length <= initial.length + 1);
    assert.deepEqual(JSON.parse(h.calls[3].user).storyboard, { pages: expected });
    assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: expected });
    assert.deepEqual((await h.db.all<Page>("SELECT * FROM pages ORDER BY page_no")).map((page) => JSON.parse(page.storyboard)), expected);
  });
}

test("program numbering repair does not discard newly returned invalid page numbers", async (t) => {
  const bad = makePage();
  bad.panels = bad.panels.slice(0, 2);
  const h = await harness(t, [makeAdaptation(), { pages: [bad] }, { pages: [makePage(), makePage(10_000)] }, pass], makeBible(), makeConfig({ max_revisions: 1 }));
  await assert.rejects(adaptChapter(h.ctx, 1), /program validation after 1 revisions/);
  assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard"]);
  assert.deepEqual(await h.db.all("SELECT * FROM pages"), []);
  assert.ok(!h.json.has("chapters/001/storyboard.json"));
});

test("blank initial storyboards are never accepted", async (t) => {
  const h = await harness(t, [makeAdaptation(), { pages: [] }], makeBible(), makeConfig({ max_revisions: 0 }));
  await assert.rejects(adaptChapter(h.ctx, 1), /program validation/);
  assert.equal(h.calls.length, 2);
  assert.ok(!h.json.has("chapters/001/storyboard.json"));
});

test("program and LLM revisions share one total revision allowance", async (t) => {
  const bad = makePage();
  bad.panels = bad.panels.slice(0, 2);
  const issues = [issue()];
  const h = await harness(t, [makeAdaptation(), { pages: [bad] }, { pages: [makePage()] }, { pass: false, issues }], makeBible(), makeConfig({ max_revisions: 1 }));
  assert.deepEqual(await adaptChapter(h.ctx, 1), { chapter: "001", pages: 1, passed: false, issues, revisions: 1, skipped: false });
  assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard", "storyboard_review"]);
  assert.ok(h.logs.some((log) => log.level === "warning" && log.message.includes("continuing with program-valid pages")));
  assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.review.001'"))!.value), { completed: true, passed: false, issues });
  await adaptChapter(h.ctx, 1);
  assert.equal(h.calls.length, 4);
});

for (const fullResponse of [false, true]) {
  test(`LLM revisions preserve uninvolved pages and finals with a ${fullResponse ? "full" : "partial"} response`, async (t) => {
    const p1 = makePage(1);
    const p2 = makePage(2);
    const revised = structuredClone(p2);
    revised.panels[0].action = "Corrected source action";
    const unrelated = structuredClone(p1);
    unrelated.panels[0].action = "Unrequested change";
    const issues = [issue(2)];
    const h = await harness(t, [{ pass: false, issues }, { pages: fullResponse ? [unrelated, revised] : [revised] }, pass]);
    await cacheScenes(h);
    await saveStoryboard(h.ctx, "001", [p1, p2]);
    await seedHistory(h, 1, 7);
    await seedHistory(h, 2, 9);
    await h.db.run("UPDATE pages SET storyboard = ? WHERE id = '001-p01'", [JSON.stringify({ panels: p1.panels, layout: p1.layout, page_no: p1.page_no }, null, 2)]);
    await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('render.start.001-p01', '3'), ('render.note.001-p01', 'Keep this redo note'), ('render.note.001-p02', 'Old action correction')");
    const untouched = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'");
    const attempts = await h.db.all("SELECT * FROM attempts ORDER BY id");
    const reviews = await h.db.all("SELECT * FROM reviews ORDER BY id");
    const images = [...h.bytes.entries()];
    await adaptChapter(h.ctx, 1);
    assert.deepEqual(h.calls.map((call) => call.schema_name), ["storyboard_review", "storyboard", "storyboard_review"]);
    assert.deepEqual(JSON.parse(h.calls[1].user).review_issues, issues);
    assert.deepEqual(JSON.parse(h.calls[2].user).storyboard.pages, [p1, revised]);
    assert.deepEqual(await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"), untouched);
    const changed = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p02'");
    assert.deepEqual(JSON.parse(changed!.storyboard), revised);
    assert.equal(changed!.status, "planned");
    assert.equal(changed!.final_attempt_id, null);
    assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p01'"))!.value, "3");
    assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p02'"))!.value, "9");
    assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.note.001-p01'"))!.value, "Keep this redo note");
    assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'render.note.001-p02'"), undefined);
    assert.deepEqual(await h.db.all("SELECT * FROM attempts ORDER BY id"), attempts);
    assert.deepEqual(await h.db.all("SELECT * FROM reviews ORDER BY id"), reviews);
    assert.deepEqual([...h.bytes.entries()], images);
    assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: [p1, revised] });
  });
}

test("revision output cannot rename the issued page number", async (t) => {
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, { pass: false, issues: [issue()] }, { pages: [makePage(2)] }]);
  await assert.rejects(adaptChapter(h.ctx, 1), (error: unknown) => error instanceof ComicError && (error.details as { missing_pages: number[] }).missing_pages.includes(1));
  assert.ok(!h.json.has("chapters/001/storyboard.json"));
});

test("an invalid LLM revision cannot use the warn-and-continue path", async (t) => {
  const bad = makePage();
  bad.panels = bad.panels.slice(0, 2);
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, { pass: false, issues: [issue()] }, { pages: [bad] }], makeBible(), makeConfig({ max_revisions: 1 }));
  await assert.rejects(adaptChapter(h.ctx, 1), /program validation/);
  assert.equal(h.calls.filter((call) => call.schema_name === "storyboard_review").length, 1);
  assert.ok(!h.logs.some((log) => log.message.includes("continuing with program-valid pages")));
  assert.ok(!h.json.has("chapters/001/storyboard.json"));
  assert.deepEqual(JSON.parse((await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.storyboard), makePage());
  assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"))!.value), { pages: [bad], revisions: 1 });
  assert.equal(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.review.001'"))!.value).completed, false);
  await assert.rejects(adaptChapter(h.ctx, 1), /program validation/);
  assert.equal(h.calls.length, 4);
  assert.ok(!h.logs.some((log) => log.message.includes("continuing with program-valid pages")));
});

test("an invalid candidate blocks render, redo and export of historical passed pages", async (t) => {
  const pages = [makePage(1), makePage(2)];
  const bad = structuredClone(pages[1]);
  bad.panels = bad.panels.slice(0, 2);
  const h = await harness(t, [{ pass: false, issues: [issue(2)] }, { pages: [bad] }], makeBible(), makeConfig({ max_revisions: 1 }));
  await cacheScenes(h);
  await saveStoryboard(h.ctx, "001", pages);
  await seedHistory(h, 1, 7);
  await seedHistory(h, 2, 9);
  const historical = await h.db.all<Page>("SELECT * FROM pages ORDER BY page_no");
  const renderMeta = await h.db.all("SELECT * FROM meta WHERE key LIKE 'render.%' ORDER BY key");
  await assert.rejects(adaptChapter(h.ctx, 1), /program validation/);
  assert.deepEqual(await h.db.all<Page>("SELECT * FROM pages ORDER BY page_no"), historical);
  await assert.rejects(renderChapter(h.ctx, 1), PreconditionError);
  await assert.rejects(redoPage(h.ctx, "001-p01", "Must not start a new render epoch"), PreconditionError);
  await assert.rejects(exportChapter(h.ctx, 1), PreconditionError);
  assert.deepEqual(await h.db.all<Page>("SELECT * FROM pages ORDER BY page_no"), historical);
  assert.deepEqual(await h.db.all("SELECT * FROM meta WHERE key LIKE 'render.%' ORDER BY key"), renderMeta);
  assert.equal(h.calls.length, 2);
});

test("an unfinished storyboard can be patched without re-adapting or bypassing review", async (t) => {
  const pages = [makePage(1), makePage(2)];
  const bad = structuredClone(pages[1]);
  bad.panels = bad.panels.slice(0, 2);
  const h = await harness(t, [{ pass: false, issues: [issue(2)] }, { pages: [bad] }, pass], makeBible(), makeConfig({ max_revisions: 1 }));
  await cacheScenes(h);
  await saveStoryboard(h.ctx, "001", pages);
  await seedHistory(h, 1, 7);
  await seedHistory(h, 2, 9);
  await assert.rejects(adaptChapter(h.ctx, 1), /program validation/);
  const untouched = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p02'");
  const attempts = await h.db.all("SELECT * FROM attempts ORDER BY id");
  const reviews = await h.db.all("SELECT * FROM reviews ORDER BY id");
  const refs = await h.db.all("SELECT * FROM refs ORDER BY id");
  const spend = await h.ledger.all("SELECT * FROM spend");
  const images = [...h.bytes.entries()];
  const calls = h.calls.length;
  const replacement = structuredClone(pages[0]);
  replacement.panels[0].action = "Corrected source action";
  assert.deepEqual(await patchStoryboard(h.ctx, 1, [replacement]), { chapter: "001", updated: ["001-p01"], review_required: true, skipped: false });
  assert.equal(h.calls.length, calls);
  assert.deepEqual(await h.ledger.all("SELECT * FROM spend"), spend);
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"), undefined);
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.revisions.001'"), undefined);
  await assert.rejects(renderChapter(h.ctx, 1), PreconditionError);
  await assert.rejects(redoPage(h.ctx, "001-p02"), PreconditionError);
  await assert.rejects(exportChapter(h.ctx, 1), PreconditionError);
  assert.deepEqual(await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p02'"), untouched);
  assert.deepEqual(await h.db.all("SELECT * FROM attempts ORDER BY id"), attempts);
  assert.deepEqual(await h.db.all("SELECT * FROM reviews ORDER BY id"), reviews);
  assert.deepEqual(await h.db.all("SELECT * FROM refs ORDER BY id"), refs);
  assert.deepEqual([...h.bytes.entries()], images);
  await adaptChapter(h.ctx, 1);
  assert.equal(h.calls.length, calls + 1);
  assert.equal(h.calls.at(-1)!.schema_name, "storyboard_review");
  assert.deepEqual(JSON.parse(h.calls.at(-1)!.user).storyboard.pages, [replacement, pages[1]]);
  assert.equal((await h.db.get<{ version: number }>("SELECT version FROM adaptations WHERE chapter_id = '001'"))!.version, 1);
});

test("unfinished review resumes the saved adaptation and program-valid storyboard", async (t) => {
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, new Error("review interrupted"), pass]);
  await assert.rejects(adaptChapter(h.ctx, 1), /review interrupted/);
  assert.ok(!h.json.has("chapters/001/storyboard.json"));
  await adaptChapter(h.ctx, 1);
  assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard_review", "storyboard_review"]);
  assert.equal((await h.db.get<{ version: number }>("SELECT version FROM adaptations WHERE chapter_id = '001'"))!.version, 1);
});

test("interrupted targeted revision resumes the saved review issues without repeating independent review", async (t) => {
  const revised = makePage();
  revised.panels[0].action = "Corrected source action";
  const issues = [issue()];
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, { pass: false, issues }, new Error("writer interrupted"), { pages: [revised] }, pass]);
  await assert.rejects(adaptChapter(h.ctx, 1), /writer interrupted/);
  await adaptChapter(h.ctx, 1);
  assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard_review", "storyboard", "storyboard", "storyboard_review"]);
  assert.deepEqual(JSON.parse(h.calls[4].user).review_issues, issues);
  assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: [revised] });
});

test("storyboard revision allowance persists across an interrupted independent review", async (t) => {
  const revised = makePage();
  revised.panels[0].action = "Corrected action";
  const issues = [issue()];
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, { pass: false, issues }, { pages: [revised] }, new Error("review interrupted"), { pass: false, issues }], makeBible(), makeConfig({ max_revisions: 1 }));
  await assert.rejects(adaptChapter(h.ctx, 1), /review interrupted/);
  const result = await adaptChapter(h.ctx, 1) as { passed: boolean; revisions: number };
  assert.equal(result.revisions, 1);
  assert.equal(result.passed, false);
  assert.equal(h.calls.filter((call) => call.schema_name === "storyboard").length, 2);
});

test("a later interrupted revision reuses the review issues for the already-reviewed candidate", async (t) => {
  const first = makePage();
  first.panels[0].action = "First correction";
  const second = structuredClone(first);
  second.panels[0].action = "Second correction";
  const laterIssues = [{ ...issue(), detail: "The first correction still changes the source action" }];
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, { pass: false, issues: [issue()] }, { pages: [first] }, { pass: false, issues: laterIssues }, new Error("second writer interrupted"), { pages: [second] }, pass], makeBible(), makeConfig({ max_revisions: 2 }));
  await assert.rejects(adaptChapter(h.ctx, 1), /second writer interrupted/);
  const result = await adaptChapter(h.ctx, 1) as { revisions: number };
  assert.equal(result.revisions, 2);
  assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard_review", "storyboard", "storyboard_review", "storyboard", "storyboard", "storyboard_review"]);
  assert.deepEqual(JSON.parse(h.calls[6].user).review_issues, laterIssues);
  assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: [second] });
});

for (const programRevision of [true, false]) {
  test(`a committed ${programRevision ? "program" : "LLM"} revision candidate survives a crash before storyboard saving`, async (t) => {
    const initial = makePage();
    if (programRevision) initial.panels = initial.panels.slice(0, 2);
    const revised = makePage();
    revised.panels[0].action = "Atomically persisted correction";
    const h = await harness(t, [makeAdaptation(), { pages: [initial] }, ...(programRevision ? [] : [{ pass: false, issues: [issue()] }]), { pages: [revised] }, pass], makeBible(), makeConfig({ max_revisions: 1 }));
    const transaction = h.db.transaction.bind(h.db);
    let interrupt = true;
    h.db.transaction = async (statements) => {
      await transaction(statements);
      if (interrupt && statements.some((statement) => statement.sql.startsWith("INSERT") && statement.params?.[0] === "storyboard.candidate.001")) {
        interrupt = false;
        throw new Error("candidate commit interrupted");
      }
    };
    await assert.rejects(adaptChapter(h.ctx, 1), /candidate commit interrupted/);
    assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"))!.value), { pages: [revised], revisions: 1 });
    assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.revisions.001'"))!.value, "1");
    assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.review.001'"))!.value), { completed: false, passed: false, issues: [] });
    if (!programRevision) assert.deepEqual(JSON.parse((await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.storyboard), initial);
    const calls = h.calls.length;
    assert.deepEqual(await adaptChapter(h.ctx, 1), { chapter: "001", pages: 1, passed: true, issues: [], revisions: 1, skipped: false });
    assert.equal(h.calls.length, calls + 1);
    assert.equal(h.calls.at(-1)!.schema_name, "storyboard_review");
    assert.deepEqual(JSON.parse(h.calls.at(-1)!.user).storyboard, { pages: [revised] });
    assert.deepEqual(JSON.parse((await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.storyboard), revised);
    assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: [revised] });
    assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"), undefined);
    assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.revisions.001'"))!.value, "1");
  });
}

test("saving identical handwritten pages preserves their final and retry epoch unless forced", async (t) => {
  const h = await harness(t);
  const page = makePage();
  await saveStoryboard(h.ctx, "001", [page]);
  await seedHistory(h, 1, 5);
  await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('render.note.001-p01', 'Keep the current correction')");
  await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('storyboard.review.001', ?)", [JSON.stringify({ completed: true, passed: true, issues: [] })]);
  const previous = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'");
  await saveStoryboard(h.ctx, "001", [page]);
  assert.deepEqual(await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"), previous);
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p01'"))!.value, "0");
  assert.equal(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.review.001'"))!.value).completed, true);
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.note.001-p01'"))!.value, "Keep the current correction");
  assert.equal(h.jsonWrites.length, 0);
  await saveStoryboard(h.ctx, "001", [page], { force: true });
  const forced = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'");
  assert.equal(forced!.status, "planned");
  assert.equal(forced!.final_attempt_id, null);
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p01'"))!.value, "5");
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'render.note.001-p01'"), undefined);
});

test("default prompts require identity cards and explicit spatial and temporal transitions as audited text", async () => {
  const load = (name: string) => readFile(new URL(`../prompts/${name}`, import.meta.url), "utf8");
  const [system, user, review, image, ocr] = await Promise.all([
    load("storyboard/system.md"), load("storyboard/user.md"), load("storyboard_review/system.md"), load("image/text_rules.md"), load("review_text/system.md"),
  ]);
  assert.ok(system.includes("姓名/称呼＋当前身份"));
  assert.ok(system.includes("type=narration"));
  assert.ok(system.includes("多少年后"));
  assert.ok(system.includes("空间切换要标清"));
  assert.ok(system.includes("没有依据不编"));
  assert.ok(user.includes("first_appearance_characters"));
  assert.ok(review.includes("姓名或称呼与当前已知身份"));
  assert.ok(review.includes("跨章延续"));
  assert.ok(review.includes("每个受影响页分别"));
  assert.ok(system.includes("同页未涉及问题的画格"));
  assert.ok(image.includes("character-introduction box BESIDE"));
  assert.ok(image.includes("Character names may appear ONLY"));
  assert.ok(ocr.includes("同一气泡或介绍/旁白框内部的换行合并"));
});

test("character introduction context excludes earlier visible people, not locked reference candidates", async (t) => {
  const bible = makeBible(["hero", "ally"]);
  const secondAdaptation = makeAdaptation();
  secondAdaptation.scenes[0].characters.push({ id: "ally", outfit: "ally.daily" });
  const secondPage = makePage();
  secondPage.panels[0].characters.push({ id: "ally", outfit: "ally.daily", pose: "standing", expression: "neutral", position: "右" });
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass, secondAdaptation, { pages: [secondPage] }, pass], bible);
  await adaptChapter(h.ctx, 1);
  await h.db.run("INSERT INTO chapters (id, idx, title, text, summary, status) VALUES ('002', 2, 'Chapter two', 'hero meets ally in Mountain.', 'Meeting', 'imported')");
  await adaptChapter(h.ctx, 2);
  const storyboard = h.calls.filter((call) => call.schema_name === "storyboard").at(-1)!;
  const review = h.calls.filter((call) => call.schema_name === "storyboard_review").at(-1)!;
  const expected = [{ id: "ally", name: "ally", recurring: true }];
  assert.deepEqual(JSON.parse(storyboard.user).first_appearance_characters, expected);
  assert.deepEqual(JSON.parse(review.user).first_appearance_characters, expected);
  const preview = await renderStepPrompt(h.ctx, "storyboard", { chapter: 2 }) as { user: string };
  assert.deepEqual(JSON.parse(preview.user).first_appearance_characters, expected);
});

test("targeted storyboard patch adds an introduction without regenerating or touching other pages", async (t) => {
  const pages = [makePage(1), makePage(2)];
  const h = await harness(t, [makeAdaptation(), { pages }, pass, pass]);
  await adaptChapter(h.ctx, 1);
  await seedHistory(h, 1, 7);
  await seedHistory(h, 2, 9);
  await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('render.note.001-p02', 'Keep this note'), ('storyboard.revisions.001', '8'), ('storyboard.candidate.001', ?)", [JSON.stringify({ pages, revisions: 8 })]);
  const untouched = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p02'");
  const attempts = await h.db.all("SELECT * FROM attempts ORDER BY id");
  const reviews = await h.db.all("SELECT * FROM reviews ORDER BY id");
  const refs = await h.db.all("SELECT * FROM refs ORDER BY id");
  const images = [...h.bytes.entries()];
  const calls = h.calls.length;
  const replacement = structuredClone(pages[0]);
  replacement.panels[0].dialogue.push({ speaker: null, type: "narration", text: "hero：山中弟子" });
  assert.deepEqual(await patchStoryboard(h.ctx, 1, [replacement]), { chapter: "001", updated: ["001-p01"], review_required: true, skipped: false });
  assert.equal(h.calls.length, calls);
  assert.deepEqual(await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p02'"), untouched);
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p02'"))!.value, "0");
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.note.001-p02'"))!.value, "Keep this note");
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p01'"))!.value, "7");
  assert.equal((await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.status, "planned");
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"), undefined);
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.revisions.001'"), undefined);
  assert.deepEqual(await h.db.all("SELECT * FROM attempts ORDER BY id"), attempts);
  assert.deepEqual(await h.db.all("SELECT * FROM reviews ORDER BY id"), reviews);
  assert.deepEqual(await h.db.all("SELECT * FROM refs ORDER BY id"), refs);
  assert.deepEqual([...h.bytes.entries()], images);
  await assert.rejects(renderChapter(h.ctx, 1), PreconditionError);
  await assert.rejects(exportChapter(h.ctx, 1), PreconditionError);
  await adaptChapter(h.ctx, 1);
  assert.equal(h.calls.length, calls + 1);
  assert.equal(h.calls.at(-1)!.schema_name, "storyboard_review");
  assert.deepEqual(JSON.parse(h.calls.at(-1)!.user).storyboard.pages, [replacement, pages[1]]);
  assert.deepEqual(await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p02'"), untouched);
});

test("committed storyboard patch clears obsolete review candidates before a crash", async (t) => {
  const original = makePage();
  const revised = structuredClone(original);
  revised.panels[0].dialogue.push({ speaker: null, type: "narration", text: "hero：山中弟子" });
  const h = await harness(t, [makeAdaptation(), { pages: [original] }, pass, pass]);
  await adaptChapter(h.ctx, 1);
  await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('storyboard.candidate.001', ?), ('storyboard.revisions.001', '8')", [JSON.stringify({ pages: [original], revisions: 8 })]);
  const transaction = h.db.transaction.bind(h.db);
  let interrupt = true;
  h.db.transaction = async (statements) => {
    await transaction(statements);
    if (interrupt && statements.some((statement) => statement.sql.startsWith("INSERT INTO pages"))) {
      interrupt = false;
      throw new Error("Interrupted after patch commit");
    }
  };
  await assert.rejects(patchStoryboard(h.ctx, 1, [revised]), /after patch commit/);
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"), undefined);
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.revisions.001'"), undefined);
  await adaptChapter(h.ctx, 1);
  assert.deepEqual(JSON.parse((await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!.storyboard), revised);
  assert.equal(h.calls.length, 4);
});

test("storyboard patch rejects unknown pages and invalid captions without changing saved progress", async (t) => {
  const h = await harness(t, [makeAdaptation(), { pages: [makePage()] }, pass]);
  await adaptChapter(h.ctx, 1);
  await seedHistory(h, 1, 3);
  const saved = await h.db.all("SELECT * FROM pages");
  const meta = await h.db.all("SELECT * FROM meta ORDER BY key");
  const invalid = makePage();
  invalid.panels[0].dialogue.push({ speaker: null, type: "narration", text: "这是一段超出配置长度的人物身份介绍文字，不应该写入分镜。" });
  for (const replacement of [makePage(2), invalid]) await assert.rejects(patchStoryboard(h.ctx, 1, [replacement]), PreconditionError);
  assert.deepEqual(await h.db.all("SELECT * FROM pages"), saved);
  assert.deepEqual(await h.db.all("SELECT * FROM meta ORDER BY key"), meta);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(await patchStoryboard(h.ctx, 1, [makePage()]), { chapter: "001", updated: [], review_required: false, skipped: true });
});

test("new handwritten pages start after existing orphan attempt history", async (t) => {
  const h = await harness(t);
  await seedHistory(h, 4, 12);
  await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('render.note.001-p04', 'Obsolete correction')");
  await saveStoryboard(h.ctx, "001", [makePage(4)]);
  const row = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p04'");
  assert.equal(row!.status, "planned");
  assert.equal(row!.final_attempt_id, null);
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p04'"))!.value, "12");
  assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'render.note.001-p04'"), undefined);
  assert.equal((await h.db.all("SELECT * FROM attempts")).length, 1);
});

for (const writerFailure of [true, false]) {
  test(`forced adaptation ${writerFailure ? "writer failure" : "invalid storyboard"} removes old working pages without losing history`, async (t) => {
    const oldPages = [makePage(1), makePage(2)];
    const adaptation = makeAdaptation();
    adaptation.scenes[0].beats[0].action = "New scene action";
    const revised = makePage();
    revised.panels[0].action = "New storyboard action";
    const bad = structuredClone(revised);
    bad.panels = bad.panels.slice(0, 2);
    const h = await harness(t, [makeAdaptation(), { pages: oldPages }, pass, adaptation, ...(writerFailure ? [new Error("forced writer interrupted"), { pages: [revised] }, pass] : [{ pages: [bad] }, { pages: [bad] }])], makeBible(), makeConfig({ max_revisions: 1 }));
    await adaptChapter(h.ctx, 1);
    await seedHistory(h, 1, 5);
    await seedHistory(h, 2, 8);
    await h.db.run("UPDATE chapters SET status = 'exported' WHERE id = '001'");
    await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('render.start.001-p01', '3'), ('render.note.001-p01', 'Old redo note'), ('storyboard.revisions.001', '1')");
    await h.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('storyboard.candidate.001', ?)", [JSON.stringify({ pages: oldPages, revisions: 1 })]);
    const attempts = await h.db.all("SELECT * FROM attempts ORDER BY id");
    const reviews = await h.db.all("SELECT * FROM reviews ORDER BY id");
    const refs = await h.db.all("SELECT * FROM refs ORDER BY id");
    const images = [...h.bytes.entries()];
    const renderMeta = await h.db.all("SELECT * FROM meta WHERE key LIKE 'render.%' ORDER BY key");
    await assert.rejects(adaptChapter(h.ctx, 1, { force: true }), writerFailure ? /forced writer interrupted/ : /program validation after 1 revisions/);
    assert.deepEqual(await h.db.all("SELECT * FROM pages WHERE chapter_id = '001'"), []);
    assert.equal((await h.db.get<{ version: number }>("SELECT version FROM adaptations WHERE chapter_id = '001'"))!.version, 2);
    assert.equal((await h.db.get<Chapter>("SELECT * FROM chapters WHERE id = '001'"))!.status, "adapted");
    assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.review.001'"))!.value), { completed: false, passed: false, issues: [] });
    assert.deepEqual(await h.db.all("SELECT * FROM meta WHERE key LIKE 'render.%' ORDER BY key"), renderMeta);
    assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: oldPages });
    await assert.rejects(renderChapter(h.ctx, 1), PreconditionError);
    await assert.rejects(exportChapter(h.ctx, 1), PreconditionError);
    if (writerFailure) {
      assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"), undefined);
      assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'storyboard.revisions.001'"), undefined);
      await adaptChapter(h.ctx, 1);
      assert.deepEqual(h.calls.map((call) => call.schema_name), ["adapt", "storyboard", "storyboard_review", "adapt", "storyboard", "storyboard", "storyboard_review"]);
      const row = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'");
      assert.deepEqual(JSON.parse(row!.storyboard), revised);
      assert.equal(row!.status, "planned");
      assert.equal(row!.final_attempt_id, null);
      assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p01'"))!.value, "5");
      assert.equal(await h.db.get("SELECT value FROM meta WHERE key = 'render.note.001-p01'"), undefined);
      assert.equal(await h.db.get("SELECT * FROM pages WHERE id = '001-p02'"), undefined);
    } else {
      assert.deepEqual(JSON.parse((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'storyboard.candidate.001'"))!.value), { pages: [bad], revisions: 1 });
      const calls = h.calls.length;
      await assert.rejects(adaptChapter(h.ctx, 1), /program validation after 1 revisions/);
      assert.equal(h.calls.length, calls);
      assert.deepEqual(await h.db.all("SELECT * FROM pages WHERE chapter_id = '001'"), []);
    }
    assert.deepEqual(await h.db.all("SELECT * FROM attempts ORDER BY id"), attempts);
    assert.deepEqual(await h.db.all("SELECT * FROM reviews ORDER BY id"), reviews);
    assert.deepEqual(await h.db.all("SELECT * FROM refs ORDER BY id"), refs);
    assert.deepEqual([...h.bytes.entries()], images);
  });
}

test("forced full regeneration increments scene version, removes obsolete DB pages, and preserves all artifacts/history", async (t) => {
  const p1 = makePage(1);
  const p2 = makePage(2);
  const h = await harness(t, [makeAdaptation(), { pages: [p1, p2] }, pass, makeAdaptation(), { pages: [p1] }, pass]);
  await adaptChapter(h.ctx, 1);
  await seedHistory(h, 1, 5);
  await seedHistory(h, 2, 8);
  await h.db.run("UPDATE chapters SET status = 'exported' WHERE id = '001'");
  const attempts = await h.db.all("SELECT * FROM attempts ORDER BY id");
  const reviews = await h.db.all("SELECT * FROM reviews ORDER BY id");
  const refs = await h.db.all("SELECT * FROM refs ORDER BY id");
  const images = [...h.bytes.entries()];
  await adaptChapter(h.ctx, 1, { force: true });
  assert.equal((await h.db.get<{ version: number }>("SELECT version FROM adaptations WHERE chapter_id = '001'"))!.version, 2);
  assert.equal(await h.db.get("SELECT * FROM pages WHERE id = '001-p02'"), undefined);
  const row = await h.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'");
  assert.equal(row!.status, "planned");
  assert.equal(row!.final_attempt_id, null);
  assert.equal((await h.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'render.start.001-p01'"))!.value, "5");
  assert.deepEqual(await h.db.all("SELECT * FROM attempts ORDER BY id"), attempts);
  assert.deepEqual(await h.db.all("SELECT * FROM reviews ORDER BY id"), reviews);
  assert.deepEqual(await h.db.all("SELECT * FROM refs ORDER BY id"), refs);
  assert.deepEqual([...h.bytes.entries()], images);
  assert.deepEqual(h.json.get("chapters/001/storyboard.json"), { pages: [p1] });
  assert.equal((await h.db.get<Chapter>("SELECT * FROM chapters WHERE id = '001'"))!.status, "storyboarded");
});
