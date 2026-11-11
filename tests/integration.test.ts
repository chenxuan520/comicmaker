import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { zodResponseFormat } from "openai/helpers/zod";
import { PDFDocument } from "pdf-lib";
import { parse, stringify } from "yaml";
import type { ZodTypeAny } from "zod";
import { adaptationSchema, extractionSchema, rewriteSchema, storyboardReviewSchema, storyboardSchema, summarySchema, textReviewSchema, visualReviewSchema, type Config } from "../schemas/index.js";
import { mergeConfig } from "../src/adapters/config.js";
import { startServer, type Job } from "../src/adapters/server.js";
import { encodeBase64, OpenAiProvider } from "../src/core/ai.js";
import type { budgetReport } from "../src/core/budget.js";
import type { AiProvider, ProjectListItem, StructuredRequest } from "../src/core/ports.js";
import type { getStatus } from "../src/core/status.js";
import type { Attempt, Ref } from "../src/core/types.js";
import { extraction, fixture, MockAi, mockOutput, novel, png, repository, storyboard, visual } from "./helpers.js";
import { startMockOpenai } from "./mockOpenai.js";

type BudgetReport = Awaited<ReturnType<typeof budgetReport>>;
type Status = Awaited<ReturnType<typeof getStatus>>;
type ApiStatus = Omit<Status, "pages" | "refs"> & {
  pages: (Status["pages"][number] & { image_url: string | null })[];
  refs: (Ref & { image_url: string })[];
};
interface ConfigResponse { yaml: string; merged: Config; sources: Record<string, string> }
interface ErrorResponse { error: { message: string; code: number; details?: Record<string, unknown> } }
interface ExportResult { chapter: string; pdf: string | null; html: string | null; flagged: string[]; skipped: boolean }
interface RunResult {
  adaptation: { pages: number; passed: boolean; skipped: boolean };
  rendering: { pages: { id: string; status: string; skipped: boolean }[]; flagged: string[] };
  export: ExportResult;
}

const fontPath = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf";
const originalKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;
before(() => {
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "Integration tests must not contact external services");
    return originalFetch(input, options);
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

async function localFixture(t: TestContext, provider?: AiProvider) {
  const cleanup: (() => Promise<void>)[] = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  const mock = await startMockOpenai();
  cleanup.push(mock.close);
  const f = await fixture(provider);
  cleanup.push(f.close);
  let pdf = true;
  try { await access(fontPath); }
  catch { pdf = false; t.diagnostic("Arial Unicode is unavailable; PDF disabled for this fixture, HTML still verified"); }
  await writeFile(join(f.root, "config.yaml"), stringify(mergeConfig(
    { openai: { base_url: `${mock.url}/v1`, api_key_env: "OPENAI_API_KEY" } },
    { refs: { candidates: 1 }, budget: { limit_usd: 10, period: "none" },
      image: { timeout_sec: 5, retry_backoff_sec: [] }, llm: { timeout_sec: 5, retry_backoff_sec: [] },
      export: { pdf, font_path: pdf ? fontPath : null, reading_image_kb: null } },
  )));
  await writeFile(join(f.root, ".env"), "OPENAI_API_KEY=test-key\n");
  return { ...f, mock, pdf, cleanup };
}

async function configure(path: string, value: Record<string, unknown>) {
  await writeFile(path, stringify(mergeConfig(parse(await readFile(path, "utf8")), value)));
}

async function cli<T = Record<string, unknown>>(root: string, args: string[], expectedCode = 0): Promise<T> {
  const config = parse(await readFile(join(root, "config.yaml"), "utf8")) as { openai: { base_url: string } };
  assert.match(config.openai.base_url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  return new Promise<T>((resolveResult, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/index.ts", ...args], {
      cwd: repository, shell: false, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000, killSignal: "SIGKILL",
      env: { ...process.env, COMIC_WORKSPACE: root, OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: config.openai.base_url, NODE_NO_WARNINGS: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      try {
        const description = `${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`;
        assert.equal(signal, null, description);
        assert.equal(code, expectedCode, description);
        assert.match(stdout, /^\{[^\n]*\}\n$/, "--json must emit exactly one object and no logs");
        assert.equal(stderr, "", description);
        assert.ok(!stdout.includes("test-key"), "CLI output must not expose the API key");
        const result = JSON.parse(stdout);
        if (expectedCode !== 0) assert.equal((result as ErrorResponse).error.code, expectedCode);
        resolveResult(result as T);
      } catch (error) { reject(error); }
    });
  });
}

const json = (method: string, value: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });

async function api<T = Record<string, unknown>>(base: string, path: string, options: RequestInit = {}, status = 200): Promise<T> {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000), ...options });
  const text = await response.text();
  assert.equal(response.status, status, `${options.method ?? "GET"} ${path}: ${text}`);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(!text.includes("test-key"), "API responses must not expose the API key");
  const result = JSON.parse(text);
  if (status >= 400) {
    assert.equal(typeof (result as ErrorResponse).error.message, "string");
    assert.equal(typeof (result as ErrorResponse).error.code, "number");
  }
  return result as T;
}

async function waitJob(base: string, id: string, status: Job["status"] = "completed"): Promise<Job> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { job } = await api<{ job: Job | null }>(base, "/api/jobs/current");
    assert.ok(job);
    assert.equal(job.id, id);
    if (job.status !== "running" && job.finished_at) {
      assert.equal(job.status, status, JSON.stringify(job));
      if (status === "completed") assert.equal(job.error, undefined);
      return job;
    }
    await delay(5);
  }
  assert.fail(`Job ${id} did not finish within the deadline`);
}

async function runJob<T>(base: string, project: string, action: Record<string, unknown>): Promise<Job & { result: T }> {
  const { job } = await api<{ job: Job }>(base, `/api/projects/${project}/actions`, json("POST", action), 202);
  assert.equal(job.status, "running");
  return await waitJob(base, job.id) as Job & { result: T };
}

async function assertPdf(data: Uint8Array) {
  const document = await PDFDocument.load(data);
  assert.equal(document.getPageCount(), 2, "PDF must contain the image page and AI notice page");
  assert.deepEqual(document.getPage(0).getSize(), { width: 1, height: 1 });
  assert.deepEqual(document.getPage(1).getSize(), { width: 1024, height: 1536 });
}

test("official OpenAI SDK uses local structured-output and PNG generation/edit HTTP contracts", async (t) => {
  const mock = await startMockOpenai();
  t.after(mock.close);
  const ai = new OpenAiProvider({ apiKey: "test-key", baseURL: `${mock.url}/v1`, llmTimeout: 5_000, imageTimeout: 5_000 });
  const cases: [string, ZodTypeAny, string][] = [
    ["extract", extractionSchema, "gpt-6.1-sol"], ["summary", summarySchema, "gpt-6.1-sol"],
    ["adapt", adaptationSchema, "gpt-6.1-sol"], ["storyboard", storyboardSchema, "gpt-6.1-sol"],
    ["storyboard_review", storyboardReviewSchema, "gpt-6.1-terra"], ["review_text", textReviewSchema, "gpt-6.1-terra"],
    ["review_visual", visualReviewSchema, "gpt-6.1-terra"], ["rewrite", rewriteSchema, "gpt-6.1-sol"],
  ];
  for (const [name, schema, model] of cases) {
    const request: StructuredRequest = { model, system: "Contract system", user: "Contract user", schema: zodResponseFormat(schema, name), schema_name: name };
    const result = await ai.structured(request);
    assert.deepEqual(schema.parse(JSON.parse(result.text)), mockOutput(request));
    assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 50 });
  }
  const images = [{ data: png, name: "first.png", label: "First reference" }, { data: png, name: "second.png", label: "Second reference" }];
  for (const inputs of [[], images]) {
    const result = await ai.image({ model: "gpt-image-2.6-sunburst", prompt: "Contract image", size: "1024x1536", quality: "high", images: inputs });
    assert.deepEqual(result.data, png);
    assert.deepEqual(result.usage, { input_tokens: 120, output_tokens: 20, text_input_tokens: 80, image_input_tokens: 40 });
  }
  assert.equal(mock.requests.length, 10);
  assert.deepEqual(mock.requests.slice(0, 8).map((request) => request.response_name), cases.map(([name]) => name));
  for (const request of mock.requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer test-key");
    assert.equal(request.headers["x-stainless-lang"], "js");
  }
  for (const request of mock.requests.slice(0, 8)) {
    assert.equal(request.path, "/v1/chat/completions");
    const format = request.payload.response_format as { type: string; json_schema: { name: string; strict: boolean } };
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.name, request.response_name);
  }
  const [generation, edit] = mock.requests.slice(8);
  assert.equal(generation.path, "/v1/images/generations");
  assert.equal(generation.payload.output_format, "png");
  assert.equal(generation.payload.n, 1);
  assert.equal(edit.path, "/v1/images/edits");
  assert.match(edit.headers["content-type"]!, /^multipart\/form-data; boundary=/);
  assert.equal(edit.payload.output_format, "png");
  assert.deepEqual(edit.files.map((file) => file.name), ["first.png", "second.png"]);
  for (const file of edit.files) {
    assert.equal(file.field, "image[]");
    assert.equal(file.type, "image/png");
    assert.deepEqual(file.data, png);
  }
  assert.ok(edit.body.includes(Buffer.from(png)), "Image edits must upload binary PNG bytes");
});

test("CLI M0 persists positional arguments, global flags, config origins and exit codes without API calls", { timeout: 60_000 }, async (t) => {
  const f = await localFixture(t);
  const absent = await cli<ErrorResponse>(f.root, ["--json", "status"], 2);
  assert.match(absent.error.message, /Select a project/);
  await cli(f.root, ["status", "--json"], 2);
  assert.deepEqual(await cli(f.root, ["list", "--json"]), { projects: [], current_project: null });
  const empty = await cli<BudgetReport>(f.root, ["--json", "budget"]);
  assert.deepEqual([empty.spent_usd, empty.limit_usd, empty.remaining_usd, empty.by_project, empty.by_step], [0, 10, 10, [], []]);
  await cli(f.root, ["new", "missing-title", "--json"], 1);
  await cli(f.root, ["new", "../escape", "--title", "Invalid", "--json"], 2);
  await cli(f.root, ["unknown-command", "--json"], 1);
  assert.deepEqual(await cli(f.root, ["--json", "new", "first-book", "--title", " First Book ", "--style", "Test ink"]), { id: "first-book", title: "First Book" });
  const projectPath = join(f.root, "projects", "first-book", "project.yaml");
  assert.deepEqual(parse(await readFile(projectPath, "utf8")), { id: "first-book", title: "First Book", project: { style_desc: "Test ink" } });
  assert.equal((await cli<{ current_project: string }>(f.root, ["list", "--json"])).current_project, "first-book");
  await cli(f.root, ["new", "first-book", "--title", "Duplicate", "--json"], 1);
  await cli(f.root, ["new", "second-book", "--title", "Second Book", "--json"]);
  assert.equal((await cli<{ current_project: string }>(f.root, ["--json", "list"])).current_project, "second-book");
  assert.deepEqual(await cli(f.root, ["use", "first-book", "--json"]), { current_project: "first-book" });
  const listed = await cli<{ projects: ProjectListItem[]; current_project: string }>(f.root, ["--json", "list"]);
  assert.deepEqual(listed, { projects: [
    { id: "first-book", title: "First Book", chapter_count: 0, completed_chapters: 0 },
    { id: "second-book", title: "Second Book", chapter_count: 0, completed_chapters: 0 },
  ], current_project: "first-book" });

  await configure(join(f.root, "config.yaml"), { image: { quality: "medium" } });
  await configure(projectPath, { image: { quality: "high" } });
  const config = await cli<{ config: Config; sources: Record<string, string>; project: { id: string; title: string } }>(f.root, ["--json", "-p", "first-book", "config", "--project"]);
  assert.equal(config.config.openai.base_url, `${f.mock.url}/v1`);
  assert.equal(config.config.image.quality, "high");
  assert.equal(config.sources["image.quality"], "project");
  assert.equal(config.sources["openai.base_url"], "workspace");
  assert.equal(config.sources["storyboard.max_panels"], "repository");
  assert.equal(config.project.id, "first-book");
  assert.equal(config.project.title, "First Book");
  const second = await cli<{ config: Config; sources: Record<string, string> }>(f.root, ["config", "--project", "--project-id", "second-book", "--json"]);
  assert.equal(second.config.image.quality, "medium");
  assert.equal(second.sources["image.quality"], "workspace");
  const before = await cli<Status>(f.root, ["--json", "--force", "--ignore-limit", "-p", "first-book", "status"]);
  const after = await cli<Status>(f.root, ["status", "--json", "--force", "--ignore-limit", "-p", "first-book"]);
  assert.deepEqual(after, before);
  assert.deepEqual([before.chapters, before.pages, before.refs, before.flagged], [[], [], [], []]);
  assert.equal(before.project.id, "first-book");
  assert.equal((await cli<{ current_project: string }>(f.root, ["list", "--json"])).current_project, "first-book");

  assert.deepEqual(await cli(f.root, ["--json", "-p", "first-book", "prompts", "eject", "image/style.md"]), { name: "image/style.md", source: "project" });
  assert.equal(await readFile(join(f.root, "projects", "first-book", "prompts", "image", "style.md"), "utf8"), await readFile(join(repository, "prompts", "image", "style.md"), "utf8"));
  assert.deepEqual(await cli(f.root, ["prompts", "eject", "refs/style_sample.md", "--workspace", "--json", "-p", "first-book"]), { name: "refs/style_sample.md", source: "workspace" });
  const templates = await cli<{ templates: { name: string; source: string }[] }>(f.root, ["prompts", "list", "-p", "first-book", "--json"]);
  assert.equal(templates.templates.find((template) => template.name === "image/style.md")?.source, "project");
  assert.equal(templates.templates.find((template) => template.name === "refs/style_sample.md")?.source, "workspace");
  const rendered = await cli<{ text: string }>(f.root, ["prompts", "render", "refs/style_sample", "--target", "project", "-p", "first-book", "--json"]);
  assert.ok(rendered.text.includes("Test ink"));

  await configure(join(f.root, "config.yaml"), { budget: { limit_usd: 0.1 } });
  const blocked = await cli<ErrorResponse>(f.root, ["refs", "gen", "--kind", "style", "-p", "first-book", "--json"], 3);
  assert.equal(blocked.error.details?.scope, "workspace");
  assert.equal(blocked.error.details?.spent_usd, 0);
  assert.equal(blocked.error.details?.estimate_usd, 0.25);
  assert.equal(blocked.error.details?.limit_usd, 0.1);
  assert.equal((await f.workspace.ledger.get<{ count: number }>("SELECT COUNT(*) AS count FROM spend"))!.count, 0);
  assert.equal(f.mock.requests.length, 0);
});

test("CLI real-SDK workflow exports valid files, accounts exact usage, skips reruns and retains flagged redo history", { timeout: 90_000 }, async (t) => {
  const f = await localFixture(t);
  await cli(f.root, ["new", "book", "--title", "CLI Book", "--json"]);
  const projectRoot = join(f.root, "projects", "book");
  const config = await cli<{ config: Config }>(f.root, ["config", "--json"]);
  assert.equal(config.config.openai.base_url, `${f.mock.url}/v1`);
  const source = join(f.root, "novel-fixture.txt");
  await writeFile(source, novel);
  assert.deepEqual(await cli(f.root, ["--json", "import", "--novel", source]), { chapters: 1, encoding: "UTF-8" });
  const prepared = await cli<{ chapters: number; skipped: boolean }>(f.root, ["prepare", "--json"]);
  assert.equal(prepared.chapters, 1);
  assert.equal(prepared.skipped, false);
  assert.equal((await cli<{ skipped: boolean }>(f.root, ["--json", "prepare"])).skipped, true);
  assert.equal(f.mock.requests.length, 2);
  const prompt = await cli<{ text: string }>(f.root, ["prompts", "render", "refs/character_sheet", "--target", "lin_qing.daily", "--json"]);
  assert.ok(prompt.text.includes(extraction.characters[0].outfits[0].name));
  assert.ok(prompt.text.includes("lin_qing.daily"));
  const refs: Ref[] = [];
  for (const [kind, target] of [["style", "project"], ["outfit", "lin_qing.daily"], ["location", "qinglan_peak"]]) {
    const generated = await cli<{ refs: Ref[] }>(f.root, ["--json", "refs", "gen", "--kind", kind, "--target", target]);
    assert.equal(generated.refs.length, 1);
    const ref = generated.refs[0];
    assert.equal(ref.target_id, target);
    assert.deepEqual(new Uint8Array(await readFile(join(projectRoot, ref.path!))), png);
    const locked = await cli<{ ref: Ref; skipped: boolean }>(f.root, ["lock", ref.id, "--json"]);
    assert.equal(locked.ref.status, "locked");
    assert.equal(locked.skipped, false);
    assert.equal((await cli<{ skipped: boolean }>(f.root, ["--json", "lock", ref.id])).skipped, true);
    refs.push(locked.ref);
  }
  const result = await cli<RunResult>(f.root, ["run", "--chapter", "1", "--json", "-p", "book"]);
  assert.equal(result.adaptation.pages, 1);
  assert.equal(result.adaptation.passed, true);
  assert.equal(result.adaptation.skipped, false);
  assert.deepEqual(result.rendering.pages.map((page) => [page.id, page.status, page.skipped]), [["001-p01", "passed", false]]);
  assert.deepEqual(result.rendering.flagged, []);
  assert.deepEqual(result.export.flagged, []);
  assert.equal(result.export.html, "chapters/001/export/index.html");
  assert.equal(result.export.pdf, f.pdf ? "chapters/001/export/chapter.pdf" : null);
  const status = await cli<Status>(f.root, ["--json", "status", "--chapter", "1"]);
  assert.equal(status.chapters[0].status, "exported");
  assert.equal(status.chapters[0].page_count, 1);
  assert.deepEqual(status.flagged, []);
  assert.equal(status.refs.filter((ref) => ref.status === "locked").length, 3);
  assert.deepEqual(status.characters, extraction.characters);
  const htmlPath = join(projectRoot, result.export.html!);
  const html = await readFile(htmlPath, "utf8");
  const imageSource = html.match(/<img[^>]+src="([^"]+)"/)![1];
  assert.equal(imageSource, "../pages/p01.png");
  assert.deepEqual(new Uint8Array(await readFile(resolve(dirname(htmlPath), imageSource))), png);
  assert.ok(html.includes(config.config.export.ai_notice_text));
  assert.ok(!html.includes("flagged"));
  if (f.pdf) await assertPdf(await readFile(join(projectRoot, result.export.pdf!)));

  assert.equal(f.mock.requests.length, 11);
  assert.deepEqual(f.mock.requests.filter((request) => request.response_name).map((request) => request.response_name), ["extract", "summary", "adapt", "storyboard", "storyboard_review", "review_text", "review_visual"]);
  const edits = f.mock.requests.filter((request) => request.path === "/v1/images/edits");
  assert.equal(edits.length, 3);
  assert.deepEqual(edits.slice(0, 2).map((request) => request.files.map((file) => file.name)), [[`${refs[0].id}.png`], [`${refs[0].id}.png`]]);
  assert.deepEqual(edits[2].files.map((file) => file.name), ["project.png", "lin_qing.daily.png", "qinglan_peak.png"]);
  for (const request of edits) {
    assert.equal(request.method, "POST");
    assert.match(request.headers["content-type"]!, /^multipart\/form-data; boundary=/);
    assert.equal(request.payload.output_format, "png");
    assert.ok(request.body.includes(Buffer.from(png)));
    for (const file of request.files) assert.deepEqual(file.data, png);
  }
  for (const request of f.mock.requests) {
    assert.ok(!request.body.includes(f.root), "Local absolute workspace paths must not be sent to OpenAI");
    assert.ok(!request.body.includes(repository), "Local absolute repository paths must not be sent to OpenAI");
  }
  for (const [name, count] of [["review_text", 1], ["review_visual", 2]] as const) {
    const request = f.mock.requests.find((request) => request.response_name === name)!;
    const messages = request.payload.messages as { content: { type: string; image_url?: { url: string } }[] }[];
    const images = messages[1].content.filter((part) => part.type === "image_url");
    assert.equal(images.length, count);
    for (const image of images) assert.equal(image.image_url!.url, `data:image/png;base64,${encodeBase64(png)}`);
  }
  const budget = await cli<BudgetReport>(f.root, ["budget", "-p", "book", "--json"]);
  assert.ok(Math.abs(budget.spent_usd - 0.00913) < 1e-12);
  assert.equal(budget.by_project.length, 1);
  assert.equal(budget.by_project[0].project_id, "book");
  assert.equal((await f.workspace.ledger.get<{ count: number }>("SELECT COUNT(*) AS count FROM spend"))!.count, 11);
  const rerun = await cli<RunResult>(f.root, ["--json", "run", "--chapter", "1"]);
  assert.equal(rerun.adaptation.skipped, true);
  assert.equal(rerun.rendering.pages[0].skipped, true);
  assert.equal(rerun.export.skipped, true);
  assert.equal((await cli<ExportResult>(f.root, ["export", "--chapter", "1", "--json"])).skipped, true);
  assert.equal((await cli<ExportResult>(f.root, ["export", "--chapter", "1", "--force", "--json"])).skipped, false);
  assert.equal(f.mock.requests.length, 11);

  const original = await readFile(join(projectRoot, "chapters/001/attempts/p01-a1.png"));
  await configure(join(projectRoot, "project.yaml"), { review: { min_identity: 0.99, max_attempts: 1 } });
  const note = "Retain the original references and adjust the framing.";
  const redo = await cli<{ status: string; final_attempt_id: string }>(f.root, ["redo", "--page", "001-p01", "--note", note, "--json"]);
  assert.equal(redo.status, "flagged");
  assert.notEqual(redo.final_attempt_id, status.pages[0].final_attempt_id);
  assert.ok(String(f.mock.requests.filter((request) => request.path === "/v1/images/edits").at(-1)!.payload.prompt).includes(note));
  assert.deepEqual(await readFile(join(projectRoot, "chapters/001/attempts/p01-a1.png")), original);
  assert.deepEqual(new Uint8Array(await readFile(join(projectRoot, "chapters/001/attempts/p01-a2.png"))), png);
  const db = new DatabaseSync(join(projectRoot, "project.db"), { readOnly: true });
  try {
    const attempts = db.prepare("SELECT * FROM attempts WHERE page_id = '001-p01' ORDER BY seq").all() as unknown as Attempt[];
    assert.deepEqual(attempts.map((attempt) => [attempt.seq, attempt.path, attempt.status]), [[1, "chapters/001/attempts/p01-a1.png", "ok"], [2, "chapters/001/attempts/p01-a2.png", "ok"]]);
    assert.equal(attempts[0].id, status.pages[0].final_attempt_id);
    assert.equal(attempts[1].id, redo.final_attempt_id);
    assert.ok(attempts[1].prompt.includes(note));
    for (const attempt of attempts) assert.deepEqual(JSON.parse(attempt.ref_paths), refs.map((ref) => ref.path));
    assert.deepEqual(db.prepare("SELECT passed FROM reviews ORDER BY rowid").all().map((review) => review.passed), [1, 0]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM refs WHERE status = 'locked'").get()!.count, 3);
  } finally { db.close(); }
  for (const ref of refs) assert.deepEqual(new Uint8Array(await readFile(join(projectRoot, ref.path!))), png);
  const flagged = await cli<Status>(f.root, ["status", "--json"]);
  assert.deepEqual(flagged.flagged, ["001-p01"]);
  assert.equal(flagged.pages[0].status, "flagged");
  const exported = await cli<ExportResult>(f.root, ["--force", "--json", "export", "--chapter", "1"]);
  assert.equal(exported.skipped, false);
  assert.deepEqual(exported.flagged, ["001-p01"]);
  assert.ok((await readFile(htmlPath, "utf8")).includes("flagged"));
  if (f.pdf) await assertPdf(await readFile(join(projectRoot, exported.pdf!)));
  const finalRun = await cli<RunResult>(f.root, ["run", "--chapter", "1", "--json"]);
  assert.deepEqual(finalRun.rendering.flagged, ["001-p01"]);
  assert.deepEqual(finalRun.export.flagged, ["001-p01"]);
  assert.equal(finalRun.rendering.pages[0].skipped, true);
  assert.equal(finalRun.export.skipped, true);
  assert.equal(f.mock.requests.length, 14);
  const spend = await f.workspace.ledger.all<{ model: string; input_tokens: number; output_tokens: number; cost_usd: number; estimated: number }>("SELECT * FROM spend");
  assert.equal(spend.length, 14);
  const counts: Record<string, number> = {};
  const costs: Record<string, number> = { "gpt-6.1-sol": 0.0007, "gpt-6.1-terra": 0.00035, "gpt-image-2.6-sunburst": 0.00132 };
  for (const entry of spend) {
    counts[entry.model] = (counts[entry.model] ?? 0) + 1;
    assert.equal(entry.estimated, 0);
    assert.equal(entry.cost_usd, costs[entry.model]);
    assert.deepEqual([entry.input_tokens, entry.output_tokens], entry.model === "gpt-image-2.6-sunburst" ? [120, 20] : [100, 50]);
  }
  assert.deepEqual(counts, { "gpt-6.1-sol": 4, "gpt-6.1-terra": 5, "gpt-image-2.6-sunburst": 5 });
  assert.ok(Math.abs((await cli<BudgetReport>(f.root, ["--json", "budget"])).spent_usd - 0.01115) < 1e-12);

  const replacement = structuredClone(storyboard);
  replacement.panels[0].dialogue.push({ speaker: null, type: "narration", text: "林青：青岚峰弟子" });
  const patchFile = join(f.root, "storyboard-patch.json");
  await writeFile(patchFile, JSON.stringify({ pages: [{ ...replacement, page_no: 2 }] }));
  await cli(f.root, ["storyboard", "patch", "--chapter", "1", "--file", patchFile, "--json"], 2);
  await writeFile(patchFile, JSON.stringify({ pages: [replacement] }));
  assert.deepEqual(await cli(f.root, ["storyboard", "patch", "--chapter", "1", "--file", patchFile, "-p", "book", "--json"]), { chapter: "001", updated: ["001-p01"], review_required: true, skipped: false });
  assert.equal(f.mock.requests.length, 14);
  assert.deepEqual((await cli<Status>(f.root, ["status", "--chapter", "1", "--json"])).pages[0].storyboard, replacement);
  await cli(f.root, ["render", "--chapter", "1", "--json"], 2);
  assert.equal(f.mock.requests.length, 14);
  assert.deepEqual(await readFile(join(projectRoot, "chapters/001/attempts/p01-a1.png")), original);
  const preview = await cli<{ prompt: { text: string } }>(f.root, ["prompts", "render", "image", "--page", "001-p01", "--json"]);
  assert.ok(preview.prompt.text.includes("林青：青岚峰弟子"));
  const outfit = storyboard.panels[0].characters[0].outfit;
  const association = await cli<{ chapter: string; outfit: string; source: string }>(f.root, ["outfits", "include", outfit, "--chapter", "1", "--paragraph", "1", "-p", "book", "--json"]);
  assert.equal(association.chapter, "001");
  assert.equal(association.outfit, outfit);
  assert.equal(association.source, "1:1");
  const location = storyboard.panels[0].location_id;
  const locationAssociation = await cli<{ chapter: string; location: string; source: string }>(f.root, ["locations", "include", location, "--chapter", "1", "--paragraph", "1", "-p", "book", "--json"]);
  assert.equal(locationAssociation.location, location);
  assert.equal(locationAssociation.source, "1:1");
  await cli(f.root, ["outfits", "include", outfit, "--chapter", "1", "--paragraph", "999", "--json"], 2);
  assert.equal(f.mock.requests.length, 14);
});

test("CLI adds missing settings without re-extracting or replacing existing entities", { timeout: 30_000 }, async (t) => {
  const f = await localFixture(t);
  await cli(f.root, ["new", "book", "--title", "Book", "--json"]);
  const novelPath = join(f.root, "novel.txt");
  await writeFile(novelPath, novel);
  await cli(f.root, ["import", "--novel", novelPath, "--json"]);
  const character = { ...structuredClone(extraction.characters[0]), id: "teacher", name: "师父" };
  character.outfits[0].id = "teacher.daily";
  const location = { ...extraction.locations[0], id: "hut_gate", name: "柴门" };
  const file = join(f.root, "settings.json");
  await writeFile(file, JSON.stringify({ characters: [character], locations: [location] }));
  await cli(f.root, ["settings", "add", "--file", file, "--json"], 2);
  assert.equal(f.mock.requests.length, 0);
  await cli(f.root, ["prepare", "--json"]);
  const before = await cli<BudgetReport>(f.root, ["budget", "--json"]);
  assert.deepEqual(await cli(f.root, ["settings", "add", "--file", file, "-p", "book", "--json"]), { characters: ["teacher"], outfits: ["teacher.daily"], locations: ["hut_gate"] });
  const status = await cli<Status>(f.root, ["status", "--json"]);
  assert.ok(status.outfits.some((outfit) => outfit.id === "teacher.daily"));
  assert.ok(status.outfits.some((outfit) => outfit.id === "lin_qing.daily"));
  assert.ok(status.locations.some((item) => item.id === "hut_gate"));
  assert.deepEqual(await readFile(join(f.root, "projects/book/bible/characters.json"), "utf8").then(JSON.parse), [...extraction.characters, character]);
  await cli(f.root, ["settings", "add", "--file", file, "--force", "--json"], 2);
  assert.equal(f.mock.requests.length, 2);
  assert.deepEqual(await cli<BudgetReport>(f.root, ["budget", "--json"]), before);
});

test("backend project/config/prompt/import APIs validate before writing and reject rebinding and private paths", { timeout: 30_000 }, async (t) => {
  const f = await localFixture(t);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const workspace = await api<{ projects: ProjectListItem[]; current_project: string | null; api_key_configured: boolean; workspace_path: string; job: Job | null }>(server.url, "/api/workspace");
  assert.deepEqual(workspace.projects, []);
  assert.equal(workspace.current_project, null);
  assert.equal(workspace.api_key_configured, true);
  assert.equal(workspace.workspace_path, f.root);
  assert.equal(workspace.job, null);
  assert.deepEqual(await api(server.url, "/api/jobs/current"), { job: null });
  const config = await api<ConfigResponse>(server.url, "/api/config");
  assert.equal(config.merged.openai.base_url, `${f.mock.url}/v1`);
  assert.equal(config.sources["openai.base_url"], "workspace");
  assert.equal(config.sources["storyboard.max_panels"], "repository");
  assert.equal((await api<BudgetReport>(server.url, "/api/budget")).spent_usd, 0);
  assert.equal((await api<ErrorResponse>(server.url, "/api/projects", json("POST", { id: "bad_id", title: "Bad" }), 409)).error.code, 2);
  await api(server.url, "/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }, 400);
  assert.deepEqual(await api(server.url, "/api/projects", json("POST", { id: "studio", title: "Studio Book" }), 201), { id: "studio", title: "Studio Book" });
  const selected = await api<{ projects: ProjectListItem[]; current_project: string }>(server.url, "/api/workspace");
  assert.equal(selected.current_project, "studio");
  assert.deepEqual(selected.projects.map((project) => project.id), ["studio"]);
  const initialProject = await api<ConfigResponse>(server.url, "/api/config?project=studio");
  const projectYaml = stringify(mergeConfig(parse(initialProject.yaml), { title: "Updated Studio", image: { quality: "medium" }, project: { style_desc: "API ink" } }));
  const updated = await api<ConfigResponse>(server.url, "/api/config?project=studio", json("PUT", { yaml: projectYaml }));
  assert.equal(updated.merged.image.quality, "medium");
  assert.equal(updated.sources["image.quality"], "project");
  assert.equal(updated.merged.project.style_desc, "API ink");
  assert.equal((await api<ConfigResponse>(server.url, "/api/config?project=studio")).yaml, projectYaml);
  assert.equal((await api<{ projects: ProjectListItem[] }>(server.url, "/api/workspace")).projects[0].title, "Updated Studio");

  for (const yaml of ["image:\n  concurrency: 0\n", "storyboard:\n  min_panels: 6\n  max_panels: 3\n", "budget:\n  timezone: invalid/timezone\n", "import:\n  chapter_regex: '['\n"]) {
    assert.equal((await api<ErrorResponse>(server.url, "/api/config", json("PUT", { yaml }), 400)).error.code, 1);
    assert.equal(await readFile(join(f.root, "config.yaml"), "utf8"), config.yaml);
  }
  assert.equal((await api<ErrorResponse>(server.url, "/api/config?project=studio", json("PUT", { yaml: "id: other\ntitle: Other\n" }), 409)).error.code, 2);
  await api(server.url, "/api/config?project=studio", json("PUT", { yaml: "id: studio\nimage:\n  concurrency: 0\n" }), 400);
  assert.equal(await readFile(join(f.root, "projects", "studio", "project.yaml"), "utf8"), projectYaml);
  const templates = await api<{ templates: { name: string; source: string }[] }>(server.url, "/api/projects/studio/prompts");
  assert.equal(templates.templates.find((template) => template.name === "image/style.md")?.source, "repository");
  const content = "API style: {{project.style_desc}}\n";
  assert.deepEqual(await api(server.url, `/api/projects/studio/prompts/${encodeURIComponent("image/style.md")}`, json("PUT", { content })), { name: "image/style.md", content, source: "project" });
  const overridden = await api<{ templates: { name: string; content: string; source: string }[] }>(server.url, "/api/projects/studio/prompts");
  assert.deepEqual(overridden.templates.find((template) => template.name === "image/style.md"), { name: "image/style.md", content, source: "project" });
  assert.deepEqual(await api(server.url, "/api/projects/studio/import", { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: new TextEncoder().encode(novel) }), { chapters: 1, encoding: "UTF-8" });
  assert.equal(await readFile(join(f.root, "projects", "studio", "novel", "source.txt"), "utf8"), novel);
  assert.equal((await api<ApiStatus>(server.url, "/api/projects/studio")).chapters[0].status, "imported");

  for (const origin of ["http://evil.example", "null"]) {
    assert.equal((await api<ErrorResponse>(server.url, "/api/workspace", { headers: { Origin: origin } }, 403)).error.code, 1);
  }
  for (const host of ["evil.example", "127.0.0.1.evil.example"]) {
    const response = await new Promise<{ status: number; body: string }>((resolveResponse, reject) => {
      const request = httpGet(`${server.url}/api/workspace`, { headers: { Host: host }, agent: false, signal: AbortSignal.timeout(5_000) }, (response) => {
        let body = "";
        response.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
        response.once("error", reject);
        response.once("end", () => resolveResponse({ status: response.statusCode!, body }));
      });
      request.once("error", reject);
    });
    assert.equal(response.status, 403, response.body);
    assert.deepEqual(JSON.parse(response.body), { error: { message: "Only same-origin local access is allowed", code: 1 } });
    assert.ok(!response.body.includes("test-key"));
  }
  await api(server.url, "/api/workspace", { headers: { Origin: server.url } });
  for (const path of [".env", "project.db", "ledger.db", "project.yaml", "novel/source.txt", "bible/characters.json"]) {
    assert.equal((await api<ErrorResponse>(server.url, `/api/projects/studio/files/${path}`, {}, 409)).error.code, 2);
  }
  for (const path of ["refs/%2e%2e%2fsecret.png", "refs/%2f.env.png", "refs/%5c.env.png", "refs/%00.env.png"]) {
    assert.equal((await api<ErrorResponse>(server.url, `/api/projects/studio/files/${path}`, {}, 400)).error.code, 1);
  }
  await api(server.url, `/api/projects/studio/prompts/${encodeURIComponent("../escape.md")}`, json("PUT", { content: "escape" }), 400);
  for (const id of ["UPPER", "bad_id", encodeURIComponent("../outside")]) await api(server.url, `/api/projects/${id}`, {}, 409);
  await api(server.url, "/api/projects/studio/files/refs/missing.png", {}, 404);
  await api(server.url, "/api/missing", {}, 404);
  await api(server.url, "/api/projects/studio/actions", json("POST", { action: "run", chapter: 0 }), 400);
  assert.deepEqual(await api(server.url, "/api/jobs/current"), { job: null });
  assert.equal(f.mock.requests.length, 0);
});

test("backend real-SDK jobs share the generation pipeline and serve resolvable HTML images and valid PDFs", { timeout: 45_000 }, async (t) => {
  const f = await localFixture(t);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const config = await api<ConfigResponse>(server.url, "/api/config");
  assert.equal(config.merged.openai.base_url, `${f.mock.url}/v1`);
  await api(server.url, "/api/projects", json("POST", { id: "web-book", title: "Web Book" }), 201);
  await api(server.url, "/api/projects/web-book/import", { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: novel });
  const prepared = await runJob<{ chapters: number }>(server.url, "web-book", { action: "prepare" });
  assert.equal(prepared.result.chapters, 1);
  assert.ok(prepared.events.some((event) => event.level === "info"));
  const bible = await api<ApiStatus>(server.url, "/api/projects/web-book");
  assert.deepEqual(bible.characters, extraction.characters);
  assert.deepEqual(bible.locations, extraction.locations);
  assert.ok(bible.chapters[0].summary);
  for (const [kind, target] of [["style", "project"], ["outfit", "lin_qing.daily"], ["location", "qinglan_peak"]]) {
    const generated = await runJob<{ refs: Ref[] }>(server.url, "web-book", { action: "refs", kind, target });
    assert.equal(generated.result.refs.length, 1);
    const locked = await runJob<{ ref: Ref }>(server.url, "web-book", { action: "lock", ref_id: generated.result.refs[0].id });
    assert.equal(locked.result.ref.status, "locked");
  }
  const run = await runJob<RunResult>(server.url, "web-book", { action: "run", chapter: 1 });
  assert.deepEqual(run.result.rendering.flagged, []);
  assert.deepEqual(run.result.export.flagged, []);
  const status = await api<ApiStatus>(server.url, "/api/projects/web-book");
  assert.equal(status.chapters[0].status, "exported");
  assert.deepEqual(status.flagged, []);
  const image = await fetch(new URL(status.pages[0].image_url!, server.url));
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "no-store");
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  for (const ref of status.refs) {
    const response = await fetch(new URL(ref.image_url, server.url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /immutable/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), png);
  }
  const fileBase = `${server.url}/api/projects/web-book/files/`;
  const htmlUrl = new URL(run.result.export.html!, fileBase);
  const htmlResponse = await fetch(htmlUrl);
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(htmlResponse.headers.get("cache-control"), "no-store");
  const html = await htmlResponse.text();
  assert.ok(html.includes(config.merged.export.ai_notice_text));
  assert.ok(!html.includes("test-key"));
  const imageUrl = new URL(html.match(/<img[^>]+src="([^"]+)"/)![1], htmlUrl);
  assert.equal(imageUrl.pathname, "/api/projects/web-book/files/chapters/001/pages/p01.png");
  const exportedImage = await fetch(imageUrl);
  assert.equal(exportedImage.status, 200);
  assert.deepEqual(new Uint8Array(await exportedImage.arrayBuffer()), png);
  if (f.pdf) {
    const pdf = await fetch(new URL(run.result.export.pdf!, fileBase));
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    assert.equal(pdf.headers.get("cache-control"), "no-store");
    await assertPdf(new Uint8Array(await pdf.arrayBuffer()));
  }
  assert.equal(f.mock.requests.length, 11);
  const rerun = await runJob<RunResult>(server.url, "web-book", { action: "run", chapter: 1 });
  assert.equal(rerun.result.adaptation.skipped, true);
  assert.equal(rerun.result.rendering.pages[0].skipped, true);
  assert.equal(rerun.result.export.skipped, true);
  assert.equal(f.mock.requests.length, 11);
  const budget = await api<BudgetReport>(server.url, "/api/budget");
  assert.ok(Math.abs(budget.spent_usd - 0.00913) < 1e-12);
  assert.equal(budget.by_project[0].project_id, "web-book");
  const workspace = await api<{ projects: ProjectListItem[]; job: Job }>(server.url, "/api/workspace");
  assert.equal(workspace.projects[0].completed_chapters, 1);
  assert.equal(workspace.job.status, "completed");
});

test("project format switching generates scrolling four-panel strips and preserves their saved format", { timeout: 30_000 }, async (t) => {
  const ai = new MockAi();
  const strip = {
    ...structuredClone(storyboard), layout: "strip-4",
    panels: Array.from({ length: 4 }, (_, index) => ({
      ...structuredClone(storyboard.panels[index % 3]), id: `p${index + 1}`, row: index + 1, size: "wide" as const,
      dialogue: index < 3 ? storyboard.panels[index].dialogue : [], beat_ids: index < 3 ? storyboard.panels[index].beat_ids : [],
    })),
  };
  ai.onStructured = (request) => {
    if (request.schema_name === "storyboard") return { pages: [strip, { ...structuredClone(strip), page_no: 2 }] };
    if (request.schema_name === "review_text") return { panels: strip.panels.map((panel, index) => ({ panel: index + 1, texts: panel.dialogue.map((dialogue) => dialogue.text) })) };
    if (request.schema_name === "review_visual") return { ...visual, panel_count: 4, characters: strip.panels.map((_, index) => ({ ...visual.characters[0], panel: index + 1 })) };
    return mockOutput(request);
  };
  const f = await localFixture(t, ai);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  for (const id of ["strip-book", "page-book"]) await api(server.url, "/api/projects", json("POST", { id, title: id }), 201);
  const original = await api<ConfigResponse>(server.url, "/api/config?project=strip-book");
  assert.equal(original.merged.storyboard.format, "page");
  const stripYaml = stringify(mergeConfig(parse(original.yaml), { storyboard: { format: "strip", min_panels: 1, max_panels: 1 } }));
  const saved = await api<ConfigResponse>(server.url, "/api/config?project=strip-book", json("PUT", { yaml: stripYaml }));
  assert.equal(saved.merged.storyboard.format, "strip");
  assert.equal(saved.sources["storyboard.format"], "project");
  assert.equal((await api<ApiStatus>(server.url, "/api/projects/strip-book")).comic_format, "strip");
  assert.equal((await api<ApiStatus>(server.url, "/api/projects/page-book")).comic_format, "page");
  await api(server.url, "/api/config?project=strip-book", json("PUT", { yaml: stringify(mergeConfig(parse(stripYaml), { storyboard: { format: "horizontal" } })) }), 400);
  assert.equal((await api<ConfigResponse>(server.url, "/api/config?project=strip-book")).yaml, stripYaml);
  assert.equal(ai.structuredCalls.length + ai.imageCalls.length, 0);
  assert.equal((await api<BudgetReport>(server.url, "/api/budget")).spent_usd, 0);

  await api(server.url, "/api/projects/strip-book/import", { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: novel });
  await runJob(server.url, "strip-book", { action: "prepare" });
  for (const [kind, target] of [["style", "project"], ["outfit", "lin_qing.daily"], ["location", "qinglan_peak"]]) {
    const generated = await runJob<{ refs: Ref[] }>(server.url, "strip-book", { action: "refs", kind, target });
    await runJob(server.url, "strip-book", { action: "lock", ref_id: generated.result.refs[0].id });
  }
  const run = await runJob<RunResult>(server.url, "strip-book", { action: "run", chapter: 1 });
  assert.deepEqual(run.result.rendering.pages.map((page) => [page.id, page.status]), [["001-p01", "passed"], ["001-p02", "passed"]]);
  assert.deepEqual(run.result.rendering.flagged, []);
  const status = await api<ApiStatus>(server.url, "/api/projects/strip-book");
  assert.deepEqual(status.pages.map((page) => page.format), ["strip", "strip"]);
  for (const page of status.pages) {
    assert.equal(page.storyboard.layout, "strip-4");
    assert.deepEqual(page.storyboard.panels.map((panel: { row: number }) => panel.row), [1, 2, 3, 4]);
  }
  assert.match(ai.structuredCalls.find((request) => request.schema_name === "adapt")!.user, /每组四个全宽横向画格/);
  assert.match(ai.structuredCalls.find((request) => request.schema_name === "storyboard")!.system, /layout 必须为 strip-4/);
  assert.match(ai.structuredCalls.find((request) => request.schema_name === "review_visual")!.user, /四格数量正确不代表版式正确/);
  for (const request of ai.imageCalls.slice(3)) assert.match(request.prompt, /Exactly four landscape panels/);
  const fileBase = `${server.url}/api/projects/strip-book/files/`;
  const htmlUrl = new URL(run.result.export.html!, fileBase);
  const html = await (await fetch(htmlUrl)).text();
  assert.ok(html.includes('data-format="strip"'));
  assert.ok(html.includes("max-width:720px"));
  assert.ok(html.includes("手机条漫 · 单列四格"));
  const sources = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sources, ["../pages/p01.png", "../pages/p02.png"]);
  for (const source of sources) assert.deepEqual(new Uint8Array(await (await fetch(new URL(source, htmlUrl))).arrayBuffer()), png);
  if (f.pdf) assert.equal((await PDFDocument.load(await (await fetch(new URL(run.result.export.pdf!, fileBase))).arrayBuffer())).getPageCount(), 3);

  const calls = ai.imageCalls.length + ai.structuredCalls.length;
  const budget = await api<BudgetReport>(server.url, "/api/budget");
  await api(server.url, "/api/config?project=strip-book", json("PUT", { yaml: stringify(mergeConfig(parse(stripYaml), { storyboard: { format: "page" } })) }));
  const rerun = await runJob<RunResult>(server.url, "strip-book", { action: "run", chapter: 1 });
  assert.equal(rerun.result.adaptation.skipped, true);
  assert.ok(rerun.result.rendering.pages.every((page) => page.skipped));
  assert.equal(rerun.result.export.skipped, true);
  assert.equal(ai.imageCalls.length + ai.structuredCalls.length, calls);
  assert.deepEqual(await api(server.url, "/api/budget"), budget);
  const unchanged = await api<ApiStatus>(server.url, "/api/projects/strip-book");
  assert.equal(unchanged.comic_format, "page");
  assert.deepEqual(unchanged.pages.map((page) => [page.format, page.final_attempt_id]), status.pages.map((page) => [page.format, page.final_attempt_id]));
  await runJob(server.url, "strip-book", { action: "export", chapter: 1, force: true });
  assert.ok((await (await fetch(htmlUrl)).text()).includes('data-format="strip"'));
  await runJob(server.url, "strip-book", { action: "redo", page_id: "001-p01", note: "保留从上到下的四个横向画格。" });
  assert.match(ai.imageCalls.at(-1)!.prompt, /Exactly four landscape panels/);
  assert.match(ai.structuredCalls.at(-1)!.user, /手机条漫版式检查/);
  assert.deepEqual(new Uint8Array(await readFile(join(f.root, "projects/strip-book/chapters/001/attempts/p01-a1.png"))), png);
  assert.equal((await api<ApiStatus>(server.url, "/api/projects/strip-book")).refs.filter((ref) => ref.status === "locked").length, 3);
  assert.equal(f.mock.requests.length, 0);
});

test("backend permits only one generation, cancels the image signal and resumes with immutable saved progress", { timeout: 30_000 }, async (t) => {
  const ai = new MockAi();
  let aborted = false;
  ai.onImage = async (request) => {
    if (ai.imageCalls.length !== 2) return;
    assert.ok(request.signal);
    await new Promise<void>((_, reject) => {
      request.signal!.addEventListener("abort", () => { aborted = true; reject(request.signal!.reason); }, { once: true });
    });
  };
  const f = await localFixture(t, ai);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  await api(server.url, "/api/projects", json("POST", { id: "cancel-book", title: "Cancel Book" }), 201);
  await api(server.url, "/api/projects/cancel-book/import", { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: novel });
  await runJob(server.url, "cancel-book", { action: "prepare" });
  const config = await api<ConfigResponse>(server.url, "/api/config");
  await api(server.url, "/api/config", json("PUT", { yaml: stringify(mergeConfig(parse(config.yaml), { refs: { candidates: 2 } })) }));
  const { job } = await api<{ job: Job }>(server.url, "/api/projects/cancel-book/actions", json("POST", { action: "refs", kind: "style" }), 202);
  const deadline = Date.now() + 10_000;
  while (ai.imageCalls.length < 2 && Date.now() < deadline) await delay(5);
  assert.equal(ai.imageCalls.length, 2);
  const blocked = await api<ErrorResponse>(server.url, "/api/projects/cancel-book/actions", json("POST", { action: "run", chapter: 1 }), 409);
  assert.equal(blocked.error.code, 2);
  assert.equal(blocked.error.details?.job_id, job.id);
  await api(server.url, "/api/config", json("PUT", { yaml: config.yaml }), 409);
  await api(server.url, "/api/projects", json("POST", { id: "blocked-book", title: "Blocked" }), 409);
  assert.equal((await api<{ job: Job }>(server.url, "/api/jobs/current")).job.id, job.id);
  assert.equal((await api<{ job: Job }>(server.url, `/api/jobs/${job.id}/cancel`, { method: "POST" })).job.id, job.id);
  const cancelled = await waitJob(server.url, job.id, "cancelled");
  assert.equal(aborted, true);
  assert.match(cancelled.error!.message, /Cancelled; progress saved/);
  assert.ok(cancelled.events.some((event) => event.message.includes("attempt 1")));
  const saved = await api<ApiStatus>(server.url, "/api/projects/cancel-book");
  assert.equal(saved.chapters.length, 1);
  assert.deepEqual(saved.characters, extraction.characters);
  assert.equal(saved.refs.length, 1);
  const originalPath = saved.refs[0].path!;
  const original = await readFile(join(f.root, "projects", "cancel-book", originalPath));
  assert.deepEqual(new Uint8Array(original), png);
  const db = new DatabaseSync(join(f.root, "projects", "cancel-book", "project.db"), { readOnly: true });
  try {
    const attempts = db.prepare("SELECT status, cost_usd, error FROM attempts ORDER BY rowid").all();
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["ok", "error"]);
    assert.equal(attempts[1].cost_usd, 0.25);
    assert.equal(JSON.parse(String(attempts[1].error)).kind, "timeout");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM refs WHERE status = 'candidate' AND path IS NULL").get()!.count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM refs WHERE status = 'rejected'").get()!.count, 0);
  } finally { db.close(); }
  const budget = await api<BudgetReport>(server.url, "/api/budget");
  assert.ok(Math.abs(budget.spent_usd - 0.25272) < 1e-12);
  await api(server.url, `/api/jobs/${job.id}/cancel`, { method: "POST" }, 409);
  const resumed = await runJob<{ refs: Ref[] }>(server.url, "cancel-book", { action: "refs", kind: "style" });
  assert.equal(resumed.result.refs.length, 1);
  assert.equal(ai.imageCalls.length, 3);
  const final = await api<ApiStatus>(server.url, "/api/projects/cancel-book");
  assert.equal(final.refs.length, 2);
  assert.ok(final.refs.some((ref) => ref.id === saved.refs[0].id));
  assert.deepEqual(await readFile(join(f.root, "projects", "cancel-book", originalPath)), original);
  assert.equal(f.mock.requests.length, 0);
});

test("backend budget failures expose job code 3 without spending or losing prior settings and locked refs", { timeout: 30_000 }, async (t) => {
  const ai = new MockAi();
  const f = await localFixture(t, ai);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  await api(server.url, "/api/projects", json("POST", { id: "budget-book", title: "Budget Book" }), 201);
  await api(server.url, "/api/projects/budget-book/import", { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: novel });
  await runJob(server.url, "budget-book", { action: "prepare" });
  const style = await runJob<{ refs: Ref[] }>(server.url, "budget-book", { action: "refs", kind: "style" });
  await runJob(server.url, "budget-book", { action: "lock", ref_id: style.result.refs[0].id });
  const before = await api<BudgetReport>(server.url, "/api/budget");
  assert.ok(before.spent_usd < 0.1);
  const config = await api<ConfigResponse>(server.url, "/api/config?project=budget-book");
  await api(server.url, "/api/config?project=budget-book", json("PUT", { yaml: stringify(mergeConfig(parse(config.yaml), { budget: { limit_usd: 0.1, period: "none" } })) }));
  const { job } = await api<{ job: Job }>(server.url, "/api/projects/budget-book/actions", json("POST", { action: "refs", kind: "outfit", target: "lin_qing.daily" }), 202);
  const failed = await waitJob(server.url, job.id, "failed");
  assert.equal(failed.error!.code, 3);
  const details = failed.error!.details as Record<string, unknown>;
  assert.equal(details.scope, "project");
  assert.equal(details.limit_usd, 0.1);
  assert.equal(details.estimate_usd, 0.25);
  assert.equal(details.spent_usd, before.spent_usd);
  assert.equal(ai.structuredCalls.length, 2);
  assert.equal(ai.imageCalls.length, 1);
  assert.deepEqual(await api(server.url, "/api/budget"), before);
  const saved = await api<ApiStatus>(server.url, "/api/projects/budget-book");
  assert.deepEqual(saved.characters, extraction.characters);
  assert.ok(saved.chapters[0].summary);
  assert.equal(saved.chapters[0].status, "imported");
  assert.equal(saved.refs.length, 1);
  assert.equal(saved.refs[0].status, "locked");
  assert.equal(saved.refs[0].id, style.result.refs[0].id);
  assert.deepEqual(new Uint8Array(await readFile(join(f.root, "projects", "budget-book", saved.refs[0].path!))), png);
  assert.equal((await f.workspace.ledger.get<{ count: number }>("SELECT COUNT(*) AS count FROM spend"))!.count, 3);
  const missing = await api<{ job: Job }>(server.url, "/api/projects/missing/actions", json("POST", { action: "run", chapter: 1 }), 202);
  assert.equal((await waitJob(server.url, missing.job.id, "failed")).error!.code, 2);
  assert.equal(f.mock.requests.length, 0);
});
