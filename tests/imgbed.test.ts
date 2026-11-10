import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import jpeg from "jpeg-js";
import { parseDocument, stringify } from "yaml";
import { configSchema } from "../schemas/index.js";
import { loadConfig } from "../src/adapters/config.js";
import { exportFont } from "../src/adapters/runtime.js";
import { startServer, type Job } from "../src/adapters/server.js";
import { createProject, importNovel } from "../src/core/project.js";
import { getStatus } from "../src/core/status.js";
import { adaptChapter } from "../src/core/steps/adapt.js";
import { exportChapter } from "../src/core/steps/export.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { renderChapter } from "../src/core/steps/render.js";
import type { Context, Page, UploadedImages } from "../src/core/types.js";
import { fixture, MockAi, mockOutput, novel, png } from "./helpers.js";

const originalFetch = globalThis.fetch;
const credentialNames = ["IMG_BED_TOKEN", "IMG_BED_AUTH_CODE", "CLOUDFLARE_API_TOKEN"];
const originalCredentials = credentialNames.map((name) => process.env[name]);
before(() => {
  delete process.env.IMG_BED_TOKEN;
  delete process.env.IMG_BED_AUTH_CODE;
  process.env.CLOUDFLARE_API_TOKEN = "cloudflare-test-management-token";
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "ImgBed tests must not contact external services");
    return originalFetch(input, options);
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  credentialNames.forEach((name, index) => {
    if (originalCredentials[index] === undefined) delete process.env[name];
    else process.env[name] = originalCredentials[index];
  });
});

interface UploadedFile { path: string; name: string; type: string; data: Uint8Array }
interface MockReply { status?: number; body: unknown; before?: () => Promise<void> }

async function book(t: TestContext, flagged = false, enabled = true) {
  const requests: UploadedFile[] = [];
  const replies: MockReply[] = [];
  let url: string;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers["content-type"]! } }).formData();
    const file = form.get("file") as File;
    requests.push({ path: request.url!, name: file.name, type: file.type, data: new Uint8Array(await file.arrayBuffer()) });
    const reply: MockReply = replies.shift() ?? { body: { src: `/file/reading-${requests.length}`, publicUrl: `${url}/public/reading-${requests.length}` } };
    await reply.before?.();
    response.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
    response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ai = new MockAi();
  if (flagged) ai.onStructured = (request) => request.schema_name === "review_text" ? { panels: [] } : mockOutput(request);
  const f = await fixture(ai);
  const cleanup: (() => Promise<void>)[] = [async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, f.close];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  await writeFile(join(f.root, "config.yaml"), stringify({
    refs: { candidates: 1 }, review: { max_attempts: 1 }, image: { retry_backoff_sec: [] },
    export: { ai_notice_page: false, imgbed: { enabled, base_url: url } },
  }));
  await writeFile(join(f.root, ".env"), "IMG_BED_TOKEN=imgbed-test-token\n");
  await createProject(f.workspace.store, "book", "Hosted Reading");
  const handle = await f.workspace.context("book");
  cleanup.push(handle.close);
  await importNovel(handle.ctx, new TextEncoder().encode(novel));
  await prepareBook(handle.ctx);
  for (const kind of ["style", "outfit", "location"] as const) await lockRef(handle.ctx, (await generateRefs(handle.ctx, { kind })).refs[0].id);
  await adaptChapter(handle.ctx, 1);
  await renderChapter(handle.ctx, 1);
  return { ...f, ...handle, ai, url, requests, replies, cleanup };
}

async function uploadMarker(ctx: Context): Promise<UploadedImages | undefined> {
  const row = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'export.upload.001'");
  return row ? JSON.parse(row.value) as UploadedImages : undefined;
}

type Server = Awaited<ReturnType<typeof startServer>>;
async function api(server: Server, path: string, input?: unknown, method = "PUT") {
  const response = await fetch(`${server.url}${path}`, input === undefined ? undefined : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  return { status: response.status, data: await response.json() };
}

async function finished(server: Server): Promise<Job> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const { data } = await api(server, "/api/jobs/current");
    if (data.job && data.job.status !== "running") return data.job;
    await delay(5);
  }
  throw new Error("ImgBed export job did not settle");
}

test("ImgBed configuration defaults off, validates URLs and supports inherited project opt-out", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await createProject(f.workspace.store, "book", "Book");
  const loaded = await loadConfig(f.workspace.repository, f.root, "book");
  const defaults = { enabled: false, base_url: "https://img.011203.xyz" };
  assert.deepEqual(loaded.config.export.imgbed, defaults);
  const without = { ...loaded.config, export: { ...loaded.config.export, imgbed: undefined } };
  assert.deepEqual(configSchema.parse(without).export.imgbed, defaults);
  for (const imgbed of [{}, { enabled: true }, { enabled: false }]) {
    const parsed = configSchema.parse({ ...loaded.config, export: { ...loaded.config.export, imgbed } });
    assert.equal(parsed.export.imgbed.enabled, "enabled" in imgbed ? imgbed.enabled : false);
    assert.equal(parsed.export.imgbed.base_url, defaults.base_url);
  }
  for (const imgbed of [{ enabled: "true" }, { base_url: "ftp://127.0.0.1" }, { base_url: "https://user:dummy@img.011203.xyz" }, { base_url: "https://img.011203.xyz?authCode=dummy" }, { base_url: "https://img.011203.xyz/#dummy" }, { base_url: "https://img.011203.xyz?" }, { base_url: "https://img.011203.xyz/#" }, { base_url: "not-a-url" }, { token: "not-for-yaml" }]) {
    assert.equal(configSchema.safeParse({ ...loaded.config, export: { ...loaded.config.export, imgbed } }).success, false);
  }
  assert.match(await readFile(join(f.root, ".env"), "utf8"), /^IMG_BED_TOKEN=\nIMG_BED_AUTH_CODE=\n/m);
  await writeFile(join(f.root, "config.yaml"), stringify({ export: { imgbed: { enabled: true } } }));
  await writeFile(join(f.root, "projects/book/project.yaml"), stringify({ id: "book", export: { imgbed: { enabled: false, base_url: "http://127.0.0.1:43210/" } } }));
  const overridden = await loadConfig(f.workspace.repository, f.root, "book");
  assert.equal(overridden.workspaceConfig.export.imgbed.enabled, true);
  assert.deepEqual(overridden.config.export.imgbed, { enabled: false, base_url: "http://127.0.0.1:43210" });
  assert.equal(overridden.sources["export.imgbed.enabled"], "project");
  assert.equal(overridden.sources["export.imgbed.base_url"], "project");
});

test("enabled export uploads only selected reading JPEGs, preserving local readers, originals and spending", async (t) => {
  const f = await book(t, true);
  const before = { images: f.ai.imageCalls.length, text: f.ai.structuredCalls.length, spend: await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id") };
  const originalPaths = [...(await getStatus(f.ctx)).refs.map((ref) => ref.path!), "chapters/001/attempts/p01-a1.png", "chapters/001/pages/p01.png"];
  const result = await exportChapter(f.ctx, 1);
  assert.equal(f.requests.length, 1);
  const reading = (await f.ctx.fs.readBytes("chapters/001/export/p01.jpg"))!;
  assert.equal(f.requests[0].type, "image/jpeg");
  assert.deepEqual(f.requests[0].data, reading);
  assert.match(f.requests[0].name, /^[A-Za-z0-9_.-]+\.jpg$/);
  assert.deepEqual(result.flagged, ["001-p01"]);
  assert.deepEqual(result.image_urls, { "001-p01": `${f.url}/public/reading-1` });
  const status = await getStatus(f.ctx);
  assert.equal(status.pages[0].hosted_image_url, `${f.url}/public/reading-1`);
  assert.equal(status.pages[0].reading_image_path, "chapters/001/export/p01.jpg");
  assert.equal(status.pages[0].status, "flagged");
  assert.match((await f.ctx.fs.readText(result.html!))!, /src="p01\.jpg"/);
  assert.ok(!(await f.ctx.fs.readText(result.html!))!.includes("/public/"));
  for (const path of originalPaths) assert.deepEqual(await f.ctx.fs.readBytes(path), png);
  assert.deepEqual({ images: f.ai.imageCalls.length, text: f.ai.structuredCalls.length, spend: await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id") }, before);
  assert.equal((await exportChapter(f.ctx, 1)).skipped, true);
  assert.equal(f.requests.length, 1);
});

test("disabled uploads remain local even with credentials, and enabling backfills a legacy export without generation", async (t) => {
  const f = await book(t, false, false);
  assert.equal(f.ctx.imageHost, undefined);
  const before = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  assert.deepEqual((await exportChapter(f.ctx, 1)).image_urls, {});
  assert.equal(f.requests.length, 0);
  assert.equal(await uploadMarker(f.ctx), undefined);
  await f.ctx.fs.writeText("project.yaml", "id: book\nexport:\n  imgbed:\n    enabled: true\n");
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  assert.equal((await exportChapter(handle.ctx, 1)).skipped, false);
  assert.equal(f.requests.length, 1);
  handle.ctx.config.export.imgbed.enabled = false;
  assert.equal((await exportChapter(handle.ctx, 1)).skipped, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, before);
});

test("cloud-only backfill preserves existing PDF, HTML and JPEG artifacts without requiring a Chinese font again", async (t) => {
  const f = await book(t);
  f.ctx.config.export.imgbed.enabled = false;
  f.ctx.config.export.ai_notice_page = true;
  const font = await exportFont(f.ctx, f.root);
  if (!font) { t.skip("An existing Chinese font is needed to create the backed-up PDF fixture"); return; }
  await exportChapter(f.ctx, 1, { font });
  const paths = ["chapters/001/export/chapter.pdf", "chapters/001/export/index.html", "chapters/001/export/p01.jpg"];
  const artifacts = await Promise.all(paths.map((path) => f.ctx.fs.readBytes(path)));
  const readingWrites = t.mock.method(f.ctx.fs, "writeReadingCopy");
  f.ctx.config.export.imgbed.enabled = true;
  const result = await exportChapter(f.ctx, 1);
  assert.equal(result.skipped, false);
  assert.equal(f.requests.length, 1);
  assert.equal(readingWrites.mock.callCount(), 0);
  for (const [index, path] of paths.entries()) assert.deepEqual(await f.ctx.fs.readBytes(path), artifacts[index]);
  assert.equal((await exportChapter(f.ctx, 1)).skipped, true);
  assert.equal(f.requests.length, 1);
});

test("a forced cached PNG export reads and hashes each final image only once", async (t) => {
  const f = await book(t);
  f.ctx.config.export.reading_image_kb = null;
  await exportChapter(f.ctx, 1);
  const reads = t.mock.method(f.ctx.fs, "readBytes");
  const hashes = t.mock.method(crypto.subtle, "digest");
  await exportChapter(f.ctx, 1, { force: true });
  assert.equal(reads.mock.calls.filter((call) => call.arguments[0] === "chapters/001/pages/p01.png").length, 1);
  assert.equal(hashes.mock.callCount(), 1);
  assert.equal(f.requests.length, 1);
});

test("upload caches track reading size, content and committed attempts, but not forced export or recreated identical JPEGs", async (t) => {
  const f = await book(t);
  const before = await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id");
  const path = "chapters/001/export/p01.jpg";
  await exportChapter(f.ctx, 1);
  const first = await f.ctx.fs.readBytes(path);
  await rm(join(f.root, "projects/book", path));
  assert.equal((await exportChapter(f.ctx, 1)).skipped, false);
  assert.deepEqual(await f.ctx.fs.readBytes(path), first);
  assert.equal(f.requests.length, 1);
  await exportChapter(f.ctx, 1, { force: true });
  assert.equal(f.requests.length, 1);
  f.ctx.config.export.reading_image_kb = 320;
  assert.equal((await getStatus(f.ctx)).pages[0].hosted_image_url, null);
  await exportChapter(f.ctx, 1);
  assert.equal(f.requests.length, 2);
  const changed = new Uint8Array(jpeg.encode({ width: 1, height: 1, data: new Uint8Array([255, 0, 0, 255]) }, 85).data);
  await f.ctx.fs.writeBytes(path, changed);
  await exportChapter(f.ctx, 1);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(f.requests[2].data, changed);
  const attemptPath = "chapters/001/attempts/p01-a2.png";
  const hash = await f.ctx.fs.writeImage(attemptPath, png);
  await f.ctx.db.transaction([
    { sql: "INSERT INTO attempts (id, page_id, seq, status, path, sha256, prompt, ref_paths, cost_usd) VALUES ('replacement-reading-attempt', '001-p01', 2, 'ok', ?, ?, 'Mock selected attempt', '[]', 0)", params: [attemptPath, hash.sha256] },
    { sql: "UPDATE pages SET final_attempt_id = 'replacement-reading-attempt' WHERE id = '001-p01'" },
  ]);
  assert.equal((await getStatus(f.ctx)).pages[0].hosted_image_url, null);
  await exportChapter(f.ctx, 1);
  assert.equal(f.requests.length, 4);
  assert.equal((await uploadMarker(f.ctx))!.pages["001-p01"].attempt_id, "replacement-reading-attempt");
  for (const original of ["chapters/001/attempts/p01-a1.png", attemptPath, "chapters/001/pages/p01.png"]) assert.deepEqual(await f.ctx.fs.readBytes(original), png);
  assert.deepEqual(await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id"), before);
});

test("changing the destination invalidates cached links and null compression uploads PNG without touching old JPEGs", async (t) => {
  const f = await book(t);
  await exportChapter(f.ctx, 1);
  const jpegCopy = await f.ctx.fs.readBytes("chapters/001/export/p01.jpg");
  await f.ctx.fs.writeText("project.yaml", stringify({ id: "book", export: { imgbed: { enabled: true, base_url: `${f.url}/another/` } } }));
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  assert.equal((await getStatus(handle.ctx)).pages[0].hosted_image_url, null);
  await exportChapter(handle.ctx, 1);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].path, /^\/another\/upload\?/);
  assert.equal((await uploadMarker(handle.ctx))!.base_url, `${f.url}/another`);
  handle.ctx.config.export.reading_image_kb = null;
  await exportChapter(handle.ctx, 1);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].type, "image/png");
  assert.deepEqual(f.requests[2].data, png);
  assert.match(f.requests[2].name, /\.png$/);
  assert.deepEqual(await f.ctx.fs.readBytes("chapters/001/export/p01.jpg"), jpegCopy);
  assert.match((await handle.ctx.fs.readText("chapters/001/export/index.html"))!, /src="\.\.\/pages\/p01\.png"/);
});

test("partial failures keep successful URLs and resume only remaining pages without marking a new chapter exported", async (t) => {
  const f = await book(t);
  const first = (await f.ctx.db.get<Page>("SELECT * FROM pages WHERE id = '001-p01'"))!;
  const storyboard = { ...JSON.parse(first.storyboard), page_no: 2 };
  const path = "chapters/001/attempts/p02-a1.png";
  const hash = await f.ctx.fs.writeImage(path, png);
  await f.ctx.fs.replaceCopy("chapters/001/pages/p02.png", png);
  await f.ctx.db.transaction([
    { sql: "INSERT INTO pages (id, chapter_id, page_no, storyboard, status, final_attempt_id) VALUES ('001-p02', '001', 2, ?, 'passed', 'second-reading-attempt')", params: [JSON.stringify(storyboard)] },
    { sql: "INSERT INTO attempts (id, page_id, seq, status, path, sha256, prompt, ref_paths, cost_usd) VALUES ('second-reading-attempt', '001-p02', 1, 'ok', ?, ?, 'Mock selected attempt', '[]', 0)", params: [path, hash.sha256] },
  ]);
  const before = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  f.replies.push({ body: { publicUrl: `${f.url}/public/first` } }, { status: 503, body: { message: "imgbed-test-token private error" } });
  await assert.rejects(exportChapter(f.ctx, 1), /HTTP 503/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(Object.keys((await uploadMarker(f.ctx))!.pages), ["001-p01"]);
  const status = await getStatus(f.ctx);
  assert.equal(status.chapters[0].status, "rendered");
  assert.equal(status.pages[0].hosted_image_url, `${f.url}/public/first`);
  assert.equal(status.pages[1].hosted_image_url, null);
  assert.ok(!JSON.stringify(f.events).includes("imgbed-test-token"));
  const resumed = await exportChapter(f.ctx, 1);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(resumed.image_urls, { "001-p01": `${f.url}/public/first`, "001-p02": `${f.url}/public/reading-3` });
  assert.equal((await getStatus(f.ctx)).chapters[0].status, "exported");
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, before);
});

test("cancellation after a successful upload checkpoints its URL before stopping export", async (t) => {
  const f = await book(t);
  const controller = new AbortController();
  f.ctx.signal = controller.signal;
  const upload = t.mock.method(f.ctx.imageHost!, "upload", async (_path: string, _data: Uint8Array, signal?: AbortSignal) => {
    assert.equal(signal, controller.signal);
    controller.abort(new Error("Cancelled mock export"));
    return `${f.url}/public/checkpointed`;
  });
  await assert.rejects(exportChapter(f.ctx, 1), /Cancelled mock export/);
  assert.equal((await uploadMarker(f.ctx))!.pages["001-p01"].url, `${f.url}/public/checkpointed`);
  assert.equal((await getStatus(f.ctx)).chapters[0].status, "rendered");
  f.ctx.signal = undefined;
  await exportChapter(f.ctx, 1);
  assert.equal(upload.mock.callCount(), 1);
  assert.equal(f.requests.length, 0);
});

test("missing business credentials fail only uploads, while opt-out and text-only pages still export locally", async (t) => {
  const f = await book(t);
  await writeFile(join(f.root, ".env"), "CLOUDFLARE_API_TOKEN=cloudflare-test-management-token\n");
  const handle = await f.workspace.context("book");
  f.cleanup.push(handle.close);
  await assert.rejects(exportChapter(handle.ctx, 1), /IMG_BED_TOKEN.*IMG_BED_AUTH_CODE/);
  assert.equal(f.requests.length, 0);
  handle.ctx.config.export.imgbed.enabled = false;
  await exportChapter(handle.ctx, 1);
  handle.ctx.config.export.imgbed.enabled = true;
  handle.ctx.config.export.pdf = false;
  await handle.ctx.db.run("UPDATE pages SET final_attempt_id = NULL, status = 'flagged' WHERE id = '001-p01'");
  const result = await exportChapter(handle.ctx, 1, { force: true });
  assert.deepEqual(result.image_urls, {});
  assert.match((await handle.ctx.fs.readText(result.html!))!, /class="text-page"/);
  assert.equal(f.requests.length, 0);
});

test("Web configuration saves never upload, and public links stay separate from local image URLs and CSP", async (t) => {
  const f = await book(t, false, false);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const current = await api(server, "/api/config?project=book");
  const document = parseDocument(current.data.yaml);
  document.setIn(["export", "imgbed", "enabled"], true);
  const saved = await api(server, "/api/config?project=book", { yaml: document.toString() });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.merged.export.imgbed.enabled, true);
  assert.ok(!JSON.stringify(saved.data).includes("imgbed-test-token"));
  assert.equal(f.requests.length, 0);
  assert.equal((await api(server, "/api/jobs/current")).data.job, null);
  const started = await api(server, "/api/projects/book/actions", { action: "export", chapter: 1 }, "POST");
  assert.equal(started.status, 202);
  assert.equal((await finished(server)).status, "completed");
  const status = await api(server, "/api/projects/book");
  assert.equal(status.data.pages[0].hosted_image_url, `${f.url}/public/reading-1`);
  assert.match(status.data.pages[0].image_url, /^\/api\/projects\/book\/files\/chapters\/001\/export\/p01\.jpg\?/);
  assert.match(status.data.pages[0].original_image_url, /^\/api\/projects\/book\/files\/chapters\/001\/pages\/p01\.png\?/);
  assert.ok(!JSON.stringify(status.data).includes("imgbed-test-token"));
  const html = await fetch(`${server.url}/api/projects/book/files/chapters/001/export/index.html`);
  assert.match(html.headers.get("content-security-policy")!, /img-src 'self' data:/);
  assert.match(await html.text(), /src="p01\.jpg"/);
  const image = await fetch(`${server.url}${status.data.pages[0].image_url}`);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), f.requests[0].data);
});

test("Web uploads hold the workspace gate, and cancellation does not leave a hung job or modify originals", async (t) => {
  const f = await book(t);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close, async () => release());
  f.replies.push({ body: { src: "/file/held" }, before: async () => { enter(); await held; } });
  const started = await api(server, "/api/projects/book/actions", { action: "export", chapter: 1 }, "POST");
  await entered;
  assert.equal((await api(server, "/api/config?project=book", { yaml: "id: book\n" })).status, 409);
  assert.equal((await api(server, "/api/projects/book/actions", { action: "render", chapter: 1 }, "POST")).status, 409);
  assert.equal((await api(server, `/api/jobs/${started.data.job.id}/cancel`, {}, "POST")).status, 200);
  const job = await finished(server);
  assert.equal(job.status, "cancelled");
  assert.equal(f.requests.length, 1);
  assert.equal(await uploadMarker(f.ctx), undefined);
  assert.deepEqual(await f.ctx.fs.readBytes("chapters/001/pages/p01.png"), png);
  assert.equal((await api(server, "/api/config?project=book", { yaml: "id: book\nexport:\n  imgbed:\n    enabled: false\n" })).status, 200);
});

test("a scheduled upload failure pauses the same unfinished chapter instead of generating or retrying later chapters", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.parse("2030-11-10T14:59:00Z") });
  const f = await book(t);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const before = f.ai.imageCalls.length + f.ai.structuredCalls.length;
  f.replies.push({ status: 500, body: { message: "private upload failure" } });
  const saved = await api(server, "/api/projects/book/schedule", { mode: "daily", time: "23:00", timezone: "Asia/Shanghai", confirm_cost: true });
  assert.equal(saved.status, 200);
  t.mock.timers.tick(61_000);
  const job = await finished(server);
  assert.equal(job.source, "schedule");
  assert.equal(job.chapter, 1);
  assert.equal(job.status, "failed");
  const status = await api(server, "/api/projects/book");
  assert.equal(status.data.chapters[0].status, "rendered");
  assert.equal(status.data.schedule.status, "paused");
  t.mock.timers.tick(86_400_000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.ai.imageCalls.length + f.ai.structuredCalls.length, before);
});

test("forced novel import clears this feature's cached links without removing remote or immutable local images", async (t) => {
  const f = await book(t);
  await exportChapter(f.ctx, 1);
  assert.ok(await uploadMarker(f.ctx));
  await importNovel(f.ctx, new TextEncoder().encode(novel), { force: true });
  assert.equal(await uploadMarker(f.ctx), undefined);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.ctx.fs.readBytes("chapters/001/attempts/p01-a1.png"), png);
  assert.deepEqual(await f.ctx.fs.readBytes("chapters/001/pages/p01.png"), png);
});
