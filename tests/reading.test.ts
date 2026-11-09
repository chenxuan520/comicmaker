import assert from "node:assert/strict";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import jpeg from "jpeg-js";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { PNG } from "pngjs";
import { configSchema } from "../schemas/index.js";
import { LocalProjectFs } from "../src/adapters/projectFs.js";
import { startServer } from "../src/adapters/server.js";
import { createProject, importNovel } from "../src/core/project.js";
import { getStatus } from "../src/core/status.js";
import { adaptChapter } from "../src/core/steps/adapt.js";
import { exportChapter } from "../src/core/steps/export.js";
import { prepareBook } from "../src/core/steps/prepare.js";
import { generateRefs, lockRef } from "../src/core/steps/refs.js";
import { renderChapter } from "../src/core/steps/render.js";
import type { Context, ReadingImages } from "../src/core/types.js";
import { fixture, MockAi, mockOutput, novel } from "./helpers.js";

const originalPath = "chapters/001/pages/p01.png";
const readingPath = "chapters/001/export/p01.jpg";
const markerKey = "export.reading.001";
const originalFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.hostname, "127.0.0.1", "Reading tests must not contact external services");
    return originalFetch(input, options);
  };
});
after(() => { globalThis.fetch = originalFetch; });

function patternedPng(width: number, height: number, seed = 0x12345678): Uint8Array {
  const image = new PNG({ width, height });
  const colors = [[224, 32, 48], [32, 192, 64]];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const color = y < height / 8 ? x < width / 8 ? colors[0] : x >= width * 7 / 8 ? colors[1] : undefined : undefined;
      const offset = (y * width + x) * 4;
      image.data[offset] = color?.[0] ?? (seed & 255);
      image.data[offset + 1] = color?.[1] ?? ((seed >>> 8) & 255);
      image.data[offset + 2] = color?.[2] ?? ((seed >>> 16) & 255);
      image.data[offset + 3] = 255;
    }
  }
  return new Uint8Array(PNG.sync.write(image));
}

const source = patternedPng(1024, 1536);

function pdfPdfBytesContainsPng(data: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index + signature.length <= data.length; index++) {
    if (signature.every((value, offset) => data[index + offset] === value)) return true;
  }
  return false;
}

async function book(t: TestContext) {
  const ai = new MockAi();
  const image = ai.image.bind(ai);
  ai.image = async (request) => ({ ...await image(request), data: source });
  const f = await fixture(ai);
  const cleanup = [f.close];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); });
  await createProject(f.workspace.store, "book", "Reading");
  const handle = await f.workspace.context("book");
  cleanup.push(handle.close);
  handle.ctx.config.export.ai_notice_page = false;
  return { ...f, ...handle, ai, cleanup, projectRoot: join(f.root, "projects", "book") };
}

async function rendered(t: TestContext, flagged = false) {
  const f = await book(t);
  f.ctx.config.refs.candidates = 1;
  f.ctx.config.image.retry_backoff_sec = [];
  f.ctx.config.review.max_attempts = 1;
  if (flagged) f.ai.onStructured = (request) => request.schema_name === "review_text" ? { panels: [] } : mockOutput(request);
  await importNovel(f.ctx, new TextEncoder().encode(novel));
  await prepareBook(f.ctx);
  for (const kind of ["style", "outfit", "location"] as const) await lockRef(f.ctx, (await generateRefs(f.ctx, { kind })).refs[0].id);
  await adaptChapter(f.ctx, 1);
  const result = await renderChapter(f.ctx, 1);
  assert.deepEqual(result.flagged, flagged ? ["001-p01"] : []);
  assert.equal(f.ai.imageCalls.length, 4);
  return f;
}

async function spending(f: Awaited<ReturnType<typeof book>>) {
  return { structured: f.ai.structuredCalls.length, images: f.ai.imageCalls.length, ledger: await f.workspace.ledger.all("SELECT * FROM spend ORDER BY id") };
}

async function readingMarker(ctx: Context) {
  const row = await ctx.db.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", [markerKey]);
  return row ? JSON.parse(row.value) as ReadingImages : undefined;
}

async function apiStatus(server: { url: string }) {
  const response = await fetch(`${server.url}/api/projects/book`);
  assert.equal(response.status, 200);
  type Status = Awaited<ReturnType<typeof getStatus>>;
  return await response.json() as Omit<Status, "pages"> & {
    pages: (Status["pages"][number] & { image_url: string | null; original_image_url: string | null })[];
  };
}

test("reading targets validate and PNG copies become near-target JPEGs without upscaling or mutation", async (t) => {
  const f = await book(t);
  assert.equal(f.ctx.config.export.reading_image_kb, 200);
  for (const target of [undefined, null, 1]) {
    const parsed = configSchema.parse({ ...f.ctx.config, export: { ...f.ctx.config.export, reading_image_kb: target } });
    assert.equal(parsed.export.reading_image_kb, target === undefined ? 200 : target);
  }
  for (const target of [0, -1, 1.5, "200", Infinity]) {
    assert.equal(configSchema.safeParse({ ...f.ctx.config, export: { ...f.ctx.config.export, reading_image_kb: target } }).success, false);
  }
  const before = await spending(f);
  const paths = ["refs/style/original.png", "chapters/001/attempts/p01-a1.png", originalPath];
  await f.ctx.fs.writeImage(paths[0], source);
  await f.ctx.fs.writeImage(paths[1], source);
  await f.ctx.fs.replaceCopy(originalPath, source);
  for (const [index, data] of [source, patternedPng(137, 205)].entries()) {
    const original = data.slice();
    const input = PNG.sync.read(Buffer.from(data));
    const path = `chapters/001/export/p0${index + 1}.jpg`;
    const bytes = await f.ctx.fs.writeReadingCopy(path, data, 200);
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual(await f.ctx.fs.readBytes(path), bytes);
    assert.deepEqual(Array.from(bytes.subarray(0, 2)), [255, 216]);
    assert.deepEqual(Array.from(bytes.subarray(-2)), [255, 217]);
    const decoded = jpeg.decode(bytes, { useTArray: true });
    assert.ok(decoded.width > 0 && decoded.width <= Math.min(768, input.width));
    assert.equal(decoded.height, Math.round(input.height * decoded.width / input.width));
    assert.equal(decoded.data.length, decoded.width * decoded.height * 4);
    const y = Math.floor(decoded.height / 16), left = Math.floor(decoded.width / 16);
    for (const [x, expected] of [[left, [224, 32, 48]], [decoded.width - 1 - left, [32, 192, 64]]] as const) {
      const offset = (y * decoded.width + x) * 4;
      expected.forEach((value, channel) => assert.ok(Math.abs(decoded.data[offset + channel] - value) <= 12));
      assert.equal(decoded.data[offset + 3], 255);
    }
    assert.deepEqual(data, original);
    if (index === 0) {
      assert.ok(bytes.length >= 150 * 1024 && bytes.length <= 220 * 1024, `Expected roughly 200 KB, got ${bytes.length} bytes`);
      t.diagnostic(`1024x1536 PNG -> ${decoded.width}x${decoded.height} JPEG: ${(bytes.length / 1024).toFixed(1)} KB`);
    }
  }
  for (const path of paths) assert.deepEqual(await f.ctx.fs.readBytes(path), source);
  assert.deepEqual(await spending(f), before);
});

test("strip HTML joins image groups without gutters and keeps original PNGs available", async (t) => {
  const f = await book(t);
  f.ctx.config.refs.candidates = 1;
  f.ctx.config.image.retry_backoff_sec = [];
  f.ctx.config.review.enabled = false;
  f.ctx.config.storyboard.format = "strip";
  f.ctx.config.storyboard.max_revisions = 8;
  f.ai.onStructured = (request) => {
    if (request.schema_name === "storyboard") {
      const storyboardPage = structuredClone((mockOutput(request) as { pages: { layout: string; panels: Record<string, unknown>[] }[] }).pages[0]);
      storyboardPage.layout = "strip-4";
      storyboardPage.panels = [...storyboardPage.panels, { ...structuredClone(storyboardPage.panels[0]), id: "p4", row: 4, size: "wide", dialogue: [], beat_ids: [] }];
      storyboardPage.panels = storyboardPage.panels.map((panel, index) => ({ ...panel, id: `p${index + 1}`, row: index + 1, size: "wide" }));
      return { pages: [storyboardPage] };
    }
    return mockOutput(request);
  };
  await importNovel(f.ctx, new TextEncoder().encode(novel));
  await prepareBook(f.ctx);
  for (const kind of ["style", "outfit", "location"] as const) await lockRef(f.ctx, (await generateRefs(f.ctx, { kind })).refs[0].id);
  await adaptChapter(f.ctx, 1);
  await renderChapter(f.ctx, 1);
  const exported = await exportChapter(f.ctx, 1);
  const html = (await f.ctx.fs.readText(exported.html!))!;
  assert.match(html, /<img src="p01\.jpg" width="1024" height="1536"/);
  assert.ok(!html.includes("<figcaption>") && !html.includes("<figure>"));
  const pdf = (await f.ctx.fs.readBytes(exported.pdf!))!;
  assert.ok(!pdfPdfBytesContainsPng(pdf));
  const status = await getStatus(f.ctx);
  assert.equal(status.pages[0].format, "strip");
  assert.equal(status.pages[0].status, "passed");
  for (const path of ["chapters/001/attempts/p01-a1.png", originalPath]) assert.deepEqual(await f.ctx.fs.readBytes(path), source);
});

test("default export and API serve JPEGs while flagged pages, PDF dimensions and original PNGs remain intact", async (t) => {
  const f = await rendered(t, true);
  const before = await spending(f);
  const initial = await getStatus(f.ctx);
  assert.equal(initial.pages[0].reading_image_path, null);
  const exported = await exportChapter(f.ctx, 1);
  assert.equal(exported.skipped, false);
  assert.deepEqual(exported.flagged, ["001-p01"]);
  const bytes = (await f.ctx.fs.readBytes(readingPath))!;
  assert.ok(jpeg.decode(bytes).width <= 768);
  const html = (await f.ctx.fs.readText(exported.html!))!;
  assert.match(html, /<img src="p01\.jpg" width="1024" height="1536"/);
  assert.match(html, /<figcaption>1[^<]*flagged<\/figcaption>/);
  assert.ok(!html.includes("../pages/"));
  const originalPdf = await f.ctx.fs.readBytes(exported.pdf!);
  assert.ok(originalPdf);
  const pdf = await PDFDocument.load(originalPdf);
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 1024, height: 1536 });
  assert.ok(!pdfPdfBytesContainsPng(originalPdf));
  const embedded = pdf.context.enumerateIndirectObjects().find(([, object]) => object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))?.[1];
  assert.ok(embedded instanceof PDFRawStream);
  assert.equal(embedded.dict.get(PDFName.of("Filter"))?.toString(), "/DCTDecode");
  assert.deepEqual(embedded.getContents(), bytes);
  assert.deepEqual(await readingMarker(f.ctx), { target_kb: 200, attempts: { "001-p01": initial.pages[0].final_attempt_id } });
  const status = await getStatus(f.ctx);
  assert.equal(status.pages[0].image_path, originalPath);
  assert.equal(status.pages[0].reading_image_path, readingPath);
  assert.equal(status.pages[0].status, "flagged");
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const remote = await apiStatus(server);
  assert.deepEqual(remote.flagged, ["001-p01"]);
  assert.equal(remote.pages[0].status, "flagged");
  for (const [url, type, expected] of [[remote.pages[0].image_url, "image/jpeg", bytes], [remote.pages[0].original_image_url, "image/png", source]] as const) {
    assert.ok(url);
    const response = await fetch(`${server.url}${url}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), type);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
  }
  const exportedHtml = await fetch(`${server.url}/api/projects/book/files/${exported.html}`);
  assert.equal(exportedHtml.status, 200);
  assert.equal(await exportedHtml.text(), html);
  for (const path of ["project.db", "project.yaml", "novel/source.txt", "logs/run.log", "chapters/001/export/secret.jpg"]) {
    const response = await fetch(`${server.url}/api/projects/book/files/${path}`);
    assert.equal(response.status, 409, path);
    assert.match((await response.json() as { error: { message: string } }).error.message, /not public/);
  }
  for (const path of [...initial.refs.map((ref) => ref.path!), "chapters/001/attempts/p01-a1.png", originalPath]) assert.deepEqual(await f.ctx.fs.readBytes(path), source);
  assert.deepEqual(await spending(f), before);
});

test("legacy exports migrate for free and caches track KB, missing copies and committed final attempts; null restores PNG", async (t) => {
  const f = await rendered(t);
  const before = await spending(f);
  const initial = await getStatus(f.ctx);
  const copies = t.mock.method(f.ctx.fs, "writeReadingCopy");
  f.ctx.config.export.reading_image_kb = null;
  await exportChapter(f.ctx, 1);
  await f.ctx.db.run("DELETE FROM meta WHERE key = ?", [markerKey]);
  assert.equal(await f.ctx.fs.readBytes(readingPath), null);
  assert.equal((await getStatus(f.ctx)).chapters[0].status, "exported");
  f.ctx.config.export.reading_image_kb = 200;
  assert.equal((await exportChapter(f.ctx, 1)).skipped, false);
  assert.equal(copies.mock.callCount(), 1);
  const first = await f.ctx.fs.readBytes(readingPath);
  assert.equal((await exportChapter(f.ctx, 1)).skipped, true);
  assert.equal(copies.mock.callCount(), 1);
  assert.deepEqual(await f.ctx.fs.readBytes(readingPath), first);
  f.ctx.config.export.reading_image_kb = 320;
  assert.equal((await getStatus(f.ctx)).pages[0].reading_image_path, null);
  assert.equal((await exportChapter(f.ctx, 1)).skipped, false);
  assert.equal(copies.mock.callCount(), 2);
  assert.equal(copies.mock.calls[1].arguments[2], 320);
  assert.deepEqual(await readingMarker(f.ctx), { target_kb: 320, attempts: { "001-p01": initial.pages[0].final_attempt_id } });
  await rm(join(f.projectRoot, readingPath));
  assert.equal((await exportChapter(f.ctx, 1)).skipped, false);
  assert.equal(copies.mock.callCount(), 3);
  assert.ok(await f.ctx.fs.readBytes(readingPath));
  assert.equal((await exportChapter(f.ctx, 1)).skipped, true);
  const replacement = patternedPng(512, 768, 0x87654321);
  const attemptPath = "chapters/001/attempts/p01-a2.png";
  const { sha256 } = await f.ctx.fs.writeImage(attemptPath, replacement);
  await f.ctx.fs.replaceCopy(originalPath, replacement);
  await f.ctx.db.transaction([
    { sql: "INSERT INTO attempts (id, page_id, seq, status, path, sha256, prompt, ref_paths, cost_usd) VALUES ('committed-reading-attempt', '001-p01', 2, 'ok', ?, ?, 'Mock committed attempt', '[]', 0)", params: [attemptPath, sha256] },
    { sql: "UPDATE pages SET final_attempt_id = 'committed-reading-attempt' WHERE id = '001-p01'" },
  ]);
  const changed = await getStatus(f.ctx);
  assert.equal(changed.chapters[0].status, "exported");
  assert.equal(changed.pages[0].reading_image_path, null);
  assert.equal((await exportChapter(f.ctx, 1)).skipped, false);
  assert.equal(copies.mock.callCount(), 4);
  const decoded = jpeg.decode((await f.ctx.fs.readBytes(readingPath))!);
  assert.deepEqual([decoded.width, decoded.height], [512, 768]);
  assert.deepEqual(await readingMarker(f.ctx), { target_kb: 320, attempts: { "001-p01": "committed-reading-attempt" } });
  assert.equal((await getStatus(f.ctx)).pages[0].reading_image_path, readingPath);
  f.ctx.config.export.reading_image_kb = null;
  await f.ctx.fs.writeText("project.yaml", "id: book\nexport:\n  reading_image_kb: null\n  ai_notice_page: false\n");
  assert.equal((await exportChapter(f.ctx, 1)).skipped, false);
  assert.equal(copies.mock.callCount(), 4);
  assert.match((await f.ctx.fs.readText("chapters/001/export/index.html"))!, /src="\.\.\/pages\/p01\.png"/);
  const pdf = await PDFDocument.load((await f.ctx.fs.readBytes("chapters/001/export/chapter.pdf"))!);
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 512, height: 768 });
  assert.deepEqual(await readingMarker(f.ctx), { target_kb: null, attempts: {} });
  assert.equal((await getStatus(f.ctx)).pages[0].reading_image_path, null);
  assert.ok(await f.ctx.fs.readBytes(readingPath), "Old JPEG files must not override disabled reading copies");
  assert.equal((await exportChapter(f.ctx, 1)).skipped, true);
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const remote = (await apiStatus(server)).pages[0];
  assert.equal(remote.reading_image_path, null);
  assert.equal(remote.image_url, remote.original_image_url);
  const response = await fetch(`${server.url}${remote.image_url}`);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), replacement);
  for (const path of [...initial.refs.map((ref) => ref.path!), "chapters/001/attempts/p01-a1.png"]) assert.deepEqual(await f.ctx.fs.readBytes(path), source);
  for (const path of [attemptPath, originalPath]) assert.deepEqual(await f.ctx.fs.readBytes(path), replacement);
  assert.deepEqual(await spending(f), before);
});

test("a deleted JPEG invalidates status and API reading links before a local re-export", async (t) => {
  const f = await rendered(t);
  await exportChapter(f.ctx, 1);
  const before = await spending(f);
  await rm(join(f.projectRoot, readingPath));
  const local = (await getStatus(f.ctx)).pages[0];
  const server = await startServer(f.workspace, { host: "127.0.0.1", port: 0 });
  f.cleanup.push(server.close);
  const remote = (await apiStatus(server)).pages[0];
  const response = await fetch(`${server.url}${remote.image_url}`);
  const data = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(await spending(f), before);
  assert.deepEqual([local.reading_image_path, remote.reading_image_path, remote.image_url, response.status], [null, null, remote.original_image_url, 200], "Missing JPEGs must fall back to the intact PNG, not produce broken reading links");
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(data, source);
});

test("reading copy writes preserve refs, attempts and pages and reject symlink escapes", async (t) => {
  const f = await book(t);
  const before = await spending(f);
  const data = patternedPng(32, 48);
  const original = data.slice();
  const paths = ["refs/style/original.png", "chapters/001/attempts/p01-a1.png", originalPath];
  await f.ctx.fs.writeImage(paths[0], data);
  await f.ctx.fs.writeImage(paths[1], data);
  await f.ctx.fs.replaceCopy(originalPath, data);
  for (const path of [...paths, "refs/style/new.jpg", "chapters/001/attempts/new.jpg", "chapters/001/pages/p01.jpg", "REFS/style/original.png"]) {
    await assert.rejects(f.ctx.fs.writeReadingCopy(path, data, 200), `Reading copy must not write ${path}`);
  }
  for (const path of ["../escape.jpg", "chapters/001/export/../escape.jpg", "/escape.jpg", "chapters\\001\\export\\p01.jpg"]) {
    await assert.rejects(f.ctx.fs.writeReadingCopy(path, data, 200), /Invalid project-relative path/);
  }
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const outsideFs = new LocalProjectFs(outside);
  const sentinel = new Uint8Array([1, 2, 3]);
  await outsideFs.writeBytes("p01.jpg", sentinel);
  const directory = join(f.projectRoot, "chapters", "001", "export");
  await symlink(outside, directory);
  await assert.rejects(f.ctx.fs.writeReadingCopy(readingPath, data, 200), /symlink/i);
  await rm(directory);
  await f.ctx.fs.writeReadingCopy("chapters/001/export/p02.jpg", data, 200);
  await symlink(join(outside, "p01.jpg"), join(directory, "p01.jpg"));
  await assert.rejects(f.ctx.fs.writeReadingCopy(readingPath, data, 200), /symlink/i);
  const alias = join(f.root, "project-alias");
  await symlink(f.projectRoot, alias);
  await assert.rejects(new LocalProjectFs(alias).writeReadingCopy("chapters/001/export/p03.jpg", data, 200), /symlink/i);
  assert.deepEqual(await outsideFs.readBytes("p01.jpg"), sentinel);
  assert.equal(await outsideFs.readBytes("p03.jpg"), null);
  for (const path of paths) assert.deepEqual(await f.ctx.fs.readBytes(path), original);
  assert.deepEqual(data, original);
  assert.deepEqual(await spending(f), before);
});
