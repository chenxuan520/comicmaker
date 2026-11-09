import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { parse } from "yaml";
import { LocalProjectFs } from "../src/adapters/projectFs.js";
import { LocalProjectStore } from "../src/adapters/projects.js";
import { openLedgerDb, openProjectDb, SqliteDb } from "../src/adapters/sqlite.js";
import { PreconditionError } from "../src/core/errors.js";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(
    process.env.COMIC_TEST_TEMP ?? tmpdir(), "comic-storage-",
  ));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const projectSchema: Record<string, string[]> = {
  meta: ["key:TEXT", "value:TEXT"],
  chapters: ["id:TEXT", "idx:INTEGER", "title:TEXT", "text:TEXT", "summary:TEXT", "status:TEXT"],
  characters: ["id:TEXT", "name:TEXT", "aliases:TEXT", "spec:TEXT"],
  outfits: ["id:TEXT", "character_id:TEXT", "name:TEXT", "spec:TEXT", "chapters:TEXT"],
  locations: ["id:TEXT", "name:TEXT", "spec:TEXT"],
  refs: ["id:TEXT", "kind:TEXT", "target_id:TEXT", "path:TEXT", "sha256:TEXT", "prompt:TEXT", "status:TEXT"],
  adaptations: ["chapter_id:TEXT", "scenes:TEXT", "version:INTEGER"],
  pages: ["id:TEXT", "chapter_id:TEXT", "page_no:INTEGER", "storyboard:TEXT", "status:TEXT", "final_attempt_id:TEXT"],
  attempts: [
    "id:TEXT", "page_id:TEXT", "ref_id:TEXT", "seq:INTEGER", "model:TEXT", "quality:TEXT", "prompt:TEXT",
    "ref_paths:TEXT", "status:TEXT", "path:TEXT", "sha256:TEXT", "input_tokens:INTEGER", "output_tokens:INTEGER",
    "cost_usd:REAL", "error:TEXT", "created_at:TEXT", "template_sources:TEXT",
  ],
  reviews: ["id:TEXT", "attempt_id:TEXT", "text_check:TEXT", "visual_check:TEXT", "score:REAL", "passed:INTEGER", "fix_instructions:TEXT"],
  llm_calls: ["id:TEXT", "step:TEXT", "model:TEXT", "prompt:TEXT", "template_sources:TEXT", "status:TEXT", "output:TEXT", "error:TEXT", "created_at:TEXT"],
};

test("project schema matches the PRD and persistent-call extensions", async (t) => {
  const root = await temporary(t);
  const db = await openProjectDb(join(root, "project.db"));
  try {
    assert.ok(db instanceof SqliteDb);
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    assert.deepEqual(tables.map((table) => table.name).sort(), Object.keys(projectSchema).sort());
    for (const [table, expected] of Object.entries(projectSchema)) {
      const columns = await db.all<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${table})`);
      assert.deepEqual(columns.map((column) => `${column.name}:${column.type}`), expected, table);
      assert.equal(columns[0].pk, 1, table);
      assert.deepEqual(await db.all(`PRAGMA foreign_key_list(${table})`), []);
    }
    assert.equal((await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'"))?.value, "2");
    assert.equal((await db.get<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode, "wal");
    assert.ok((await db.get<{ timeout: number }>("PRAGMA busy_timeout"))!.timeout > 0);
    const index = await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'refs_one_locked_per_target'");
    assert.match(index!.sql, /CREATE UNIQUE INDEX[\s\S]*refs\(kind, target_id\) WHERE status = 'locked'/);
  } finally {
    await db.close();
  }
});

test("ledger has the exact spend fields plus version metadata", async (t) => {
  const root = await temporary(t);
  const filePath = join(root, "ledger.db");
  const db = await openLedgerDb(filePath);
  try {
    const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    assert.deepEqual(tables.map((table) => table.name), ["meta", "spend"]);
    const columns = await db.all<{ name: string; type: string }>("PRAGMA table_info(spend)");
    assert.deepEqual(columns.map((column) => `${column.name}:${column.type}`), [
      "id:TEXT", "project_id:TEXT", "step:TEXT", "model:TEXT", "input_tokens:INTEGER", "output_tokens:INTEGER",
      "cost_usd:REAL", "estimated:INTEGER", "ref:TEXT", "created_at:TEXT",
    ]);
    assert.equal((await db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'"))?.value, "1");
    await db.run("INSERT INTO spend VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-1", "qinglan", "image", "test-model", 10, 20, 0.25, 1, "attempt-1", "2026-11-09T00:00:00Z"]);
  } finally {
    await db.close();
  }
  const reopened = await openLedgerDb(filePath);
  try {
    assert.equal((await reopened.get<{ total: number }>("SELECT SUM(cost_usd) AS total FROM spend"))?.total, 0.25);
    assert.equal((await reopened.get<{ estimated: number }>("SELECT estimated FROM spend WHERE id = ?", ["call-1"]))?.estimated, 1);
    assert.equal((await reopened.get<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode, "wal");
  } finally {
    await reopened.close();
  }
});

test("version 1 project migration preserves history and call progress persists across reopen", async (t) => {
  const root = await temporary(t);
  const filePath = join(root, "project.db");
  const legacy = await openProjectDb(filePath);
  try {
    await legacy.transaction([
      { sql: "INSERT INTO attempts (id, prompt, status, path) VALUES (?, ?, ?, ?)", params: ["old-attempt", "original prompt", "ok", "chapters/001/attempts/p01-a1.png"] },
      { sql: "INSERT INTO reviews (id, attempt_id, score) VALUES ('old-review', 'old-attempt', 80)" },
      { sql: "DROP INDEX refs_one_locked_per_target" },
      { sql: "DROP TABLE llm_calls" },
      { sql: "ALTER TABLE attempts DROP COLUMN template_sources" },
      { sql: "UPDATE meta SET value = '1' WHERE key = 'schema_version'" },
    ]);
  } finally {
    await legacy.close();
  }
  const migrated = await openProjectDb(filePath);
  try {
    const attempt = await migrated.get<{ prompt: string; template_sources: null }>("SELECT prompt, template_sources FROM attempts WHERE id = 'old-attempt'");
    assert.deepEqual({ ...attempt }, { prompt: "original prompt", template_sources: null });
    assert.equal((await migrated.get<{ score: number }>("SELECT score FROM reviews WHERE id = 'old-review'"))?.score, 80);
    assert.equal((await migrated.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'"))?.value, "2");
    await migrated.run("INSERT INTO llm_calls (id, step, model, prompt, template_sources, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["llm-1", "extract", "test-model", "rendered prompt", '{"system":"project"}', "pending", "2026-11-09T00:00:00Z"]);
  } finally {
    await migrated.close();
  }
  const reopened = await openProjectDb(filePath);
  try {
    const call = await reopened.get<{ status: string; prompt: string; template_sources: string }>("SELECT status, prompt, template_sources FROM llm_calls WHERE id = 'llm-1'");
    assert.deepEqual({ ...call }, { status: "pending", prompt: "rendered prompt", template_sources: '{"system":"project"}' });
    await reopened.run("UPDATE llm_calls SET status = 'ok', output = ? WHERE id = ?", ['{"characters":[]}', "llm-1"]);
    assert.equal((await reopened.get<{ output: string }>("SELECT output FROM llm_calls WHERE id = 'llm-1'"))?.output, '{"characters":[]}');
  } finally {
    await reopened.close();
  }
});

test("project and ledger reject unsupported newer schema versions without changing metadata", async (t) => {
  const root = await temporary(t);
  for (const [name, open] of [["project", openProjectDb], ["ledger", openLedgerDb]] as const) {
    const filePath = join(root, `${name}.db`);
    const db = await open(filePath);
    try {
      await db.run("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    } finally {
      await db.close();
    }
    await assert.rejects(open(filePath), /Unsupported .* schema_version 999/);
    const raw = new DatabaseSync(filePath, { readOnly: true });
    try {
      assert.equal(raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value, "999");
    } finally {
      raw.close();
    }
  }
});

test("only one ref per kind and target can be locked", async (t) => {
  const root = await temporary(t);
  const db = await openProjectDb(join(root, "project.db"));
  try {
    await db.transaction([
      { sql: "INSERT INTO refs (id, kind, target_id, status) VALUES ('style-1', 'style', 'project', 'locked')" },
      { sql: "INSERT INTO refs (id, kind, target_id, status) VALUES ('style-2', 'style', 'project', 'candidate')" },
      { sql: "INSERT INTO refs (id, kind, target_id, status) VALUES ('style-3', 'style', 'project', 'rejected')" },
      { sql: "INSERT INTO refs (id, kind, target_id, status) VALUES ('outfit-1', 'outfit', 'project', 'locked')" },
      { sql: "INSERT INTO refs (id, kind, target_id, status) VALUES ('style-other', 'style', 'other', 'locked')" },
    ]);
    await assert.rejects(db.run("INSERT INTO refs (id, kind, target_id, status) VALUES ('duplicate', 'style', 'project', 'locked')"), /UNIQUE/);
    await assert.rejects(db.run("UPDATE refs SET status = 'locked' WHERE id = 'style-2'"), /UNIQUE/);
    await db.transaction([
      { sql: "UPDATE refs SET status = 'rejected' WHERE id = 'style-1'" },
      { sql: "UPDATE refs SET status = 'locked' WHERE id = 'style-2'" },
    ]);
    assert.equal((await db.get<{ id: string }>("SELECT id FROM refs WHERE kind = 'style' AND target_id = 'project' AND status = 'locked'"))?.id, "style-2");
    assert.equal((await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM refs"))?.count, 5);
  } finally {
    await db.close();
  }
});

test("Db binds all SqlValue types, rolls back failures, and transactions do not interleave", async (t) => {
  const root = await temporary(t);
  const db = await openProjectDb(join(root, "project.db"));
  try {
    const bytes = new Uint8Array([0, 1, 255]);
    const row = await db.get<{ bytes: Uint8Array; integer: number; text: string; absent: null; cost: number }>(
      "SELECT ? AS bytes, ? AS integer, ? AS text, ? AS absent, ? AS cost", [bytes, 7n, "text", null, 0.5],
    );
    assert.deepEqual(row!.bytes, bytes);
    assert.equal(row!.bytes.constructor, Uint8Array);
    assert.deepEqual([row!.integer, row!.text, row!.absent, row!.cost], [7, "text", null, 0.5]);
    const result = await db.run("INSERT INTO meta (key, value) VALUES ('binary', ?)", [bytes]);
    assert.equal(result.changes, 1);
    assert.ok(Number(result.lastInsertRowid) > 0);
    await db.transaction([{ sql: "INSERT INTO meta (key, value) VALUES (?, ?)", params: ["binary-txn", bytes] }]);
    const values = await db.all<{ value: Uint8Array }>("SELECT value FROM meta WHERE key LIKE 'binary%' ORDER BY key");
    assert.deepEqual(values.map((value) => value.value), [bytes, bytes]);
    await assert.rejects(db.transaction([
      { sql: "INSERT INTO meta (key, value) VALUES ('rollback', 'not committed')" },
      { sql: "INSERT INTO meta (key, value) VALUES ('schema_version', 'duplicate')" },
    ]), /UNIQUE/);
    assert.equal(await db.get("SELECT value FROM meta WHERE key = 'rollback'"), undefined);
    const transaction = db.transaction([
      { sql: "INSERT INTO meta (key, value) VALUES ('synchronous', 'first')" },
      { sql: "UPDATE meta SET value = 'complete' WHERE key = 'synchronous'" },
    ]);
    const observed = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'synchronous'");
    await transaction;
    assert.equal((await observed)?.value, "complete");
    await db.transaction([]);
  } finally {
    await db.close();
  }
});

test("chapter export leaves flagged pages intact and deleting working state does not cascade into history", async (t) => {
  const root = await temporary(t);
  const db = await openProjectDb(join(root, "project.db"));
  try {
    await db.transaction([
      { sql: "INSERT INTO chapters (id, status) VALUES ('001', 'rendered')" },
      { sql: "INSERT INTO pages (id, chapter_id, status, final_attempt_id) VALUES ('001-p01', '001', 'flagged', 'attempt-1')" },
      { sql: "INSERT INTO refs (id, kind, target_id, status) VALUES ('ref-1', 'style', 'project', 'locked')" },
      { sql: "INSERT INTO attempts (id, page_id, ref_id, status, path) VALUES ('attempt-1', '001-p01', 'ref-1', 'ok', 'chapters/001/attempts/p01-a1.png')" },
      { sql: "INSERT INTO reviews (id, attempt_id, passed) VALUES ('review-1', 'attempt-1', 0)" },
      { sql: "UPDATE chapters SET status = 'exported' WHERE id = '001'" },
    ]);
    assert.equal((await db.get<{ status: string }>("SELECT status FROM pages WHERE id = '001-p01'"))?.status, "flagged");
    await db.transaction([
      { sql: "DELETE FROM pages WHERE id = '001-p01'" },
      { sql: "DELETE FROM chapters WHERE id = '001'" },
      { sql: "DELETE FROM refs WHERE id = 'ref-1'" },
    ]);
    assert.equal((await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM attempts"))?.count, 1);
    assert.equal((await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM reviews"))?.count, 1);
  } finally {
    await db.close();
  }
});

test("image writes are exclusive, hashed with SHA-256, and nested directories are created on demand", async (t) => {
  const root = await temporary(t);
  const fs = new LocalProjectFs(root);
  const original = encode("abc");
  assert.deepEqual(await fs.writeImage("refs/style/ref-1.png", original), {
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  await assert.rejects(fs.writeImage("refs/style/ref-1.png", encode("replacement")), { code: "EEXIST" });
  const bytes = await fs.readBytes("refs/style/ref-1.png");
  assert.deepEqual(bytes, original);
  assert.equal(bytes!.constructor, Uint8Array);
  await Promise.all([
    fs.writeImage("chapters/001/attempts/nested/p01-a1.png", original),
    fs.writeImage("chapters/001/attempts/nested/p02-a1.png", original),
  ]);
  await assert.rejects(fs.writeImage("chapters/001/attempts/nested/p01-a1.png", encode("changed")), { code: "EEXIST" });
  for (const path of ["logs/image.png", "chapters/001/pages/p01.png", "attempts/image.png", "refs", "chapters/001/attempts"]) {
    await assert.rejects(fs.writeImage(path, original), /immutable refs or chapter attempts/);
  }
  assert.equal(await fs.readBytes("missing/directory/file"), null);
  assert.equal(await fs.readText("missing/directory/file"), null);
});

test("general writes cannot bypass image or source immutability, including case-insensitive aliases", async (t) => {
  const root = await temporary(t);
  const fs = new LocalProjectFs(root);
  const original = encode("original");
  await fs.writeImage("refs/style/ref.png", original);
  await fs.writeImage("chapters/001/attempts/a.png", original);
  await fs.replaceCopy("chapters/001/pages/p01.png", original);
  await fs.writeNovel(original, false, "unused");
  for (const path of [
    "refs/style/ref.png", "refs/new.png", "refs", "chapters/001/attempts/a.png", "chapters/001/attempts",
    "chapters/001/pages/p01.png", "chapters/001/pages", "novel/source.txt", "novel/source.txt/nested",
    "REFS/style/ref.png", "Chapters/001/ATTEMPTS/a.png", "chapters/001/PAGES/p01.png", "NOVEL/SOURCE.TXT",
  ]) {
    await assert.rejects(fs.writeBytes(path, encode("changed")), /General writes/);
    await assert.rejects(fs.writeText(path, "changed"), /General writes/);
    await assert.rejects(fs.writeJson(path, { changed: true }), /General writes/);
  }
  for (const path of ["refs/style/ref.png", "chapters/001/attempts/a.png", "chapters/001/pages/p01.png", "novel/source.txt"]) {
    assert.deepEqual(await fs.readBytes(path), original);
  }
  await fs.writeJson("bible/characters.json", { version: 1 });
  await fs.writeJson("bible/characters.json", { version: 2 });
  assert.deepEqual(JSON.parse((await fs.readText("bible/characters.json"))!), { version: 2 });
  await fs.writeBytes("chapters/001/export/chapter.pdf", new Uint8Array([1, 2, 3]));
  assert.deepEqual(await fs.readBytes("chapters/001/export/chapter.pdf"), new Uint8Array([1, 2, 3]));
  await fs.writeText("logs/run.log", "log");
  await fs.writeText("prompts/refs/style_sample.md", "overridden template");
  assert.equal(await fs.readText("prompts/refs/style_sample.md"), "overridden template");
});

test("replaceCopy only replaces PNG copies inside chapter pages", async (t) => {
  const root = await temporary(t);
  const fs = new LocalProjectFs(root);
  const path = "chapters/001/pages/nested/p01.png";
  await fs.replaceCopy(path, encode("first"));
  await fs.replaceCopy(path, encode("second"));
  assert.equal(await fs.readText(path), "second");
  for (const invalid of ["refs/style/ref.png", "chapters/001/attempts/a.png", "pages/p01.png", "chapters/001/export/p01.png", "chapters/001/pages/p01.txt"]) {
    await assert.rejects(fs.replaceCopy(invalid, encode("changed")), /Final copies/);
  }
});

test("all filesystem read and write entry points reject traversal, absolute paths, backslashes, and NUL", async (t) => {
  const fs = new LocalProjectFs(await temporary(t));
  const operations = [
    (path: string) => fs.readBytes(path),
    (path: string) => fs.readText(path),
    (path: string) => fs.writeBytes(path, encode("data")),
    (path: string) => fs.writeText(path, "data"),
    (path: string) => fs.writeJson(path, {}),
    (path: string) => fs.writeImage(path, encode("data")),
    (path: string) => fs.replaceCopy(path, encode("data")),
  ];
  for (const path of ["", ".", "/tmp/escape.png", "C:/escape.png", "../escape.png", "refs/../escape.png", "chapters/001/pages/../../escape.png", "logs\\escape", "logs/\0escape", "logs//file"]) {
    for (const operation of operations) await assert.rejects(operation(path), /Invalid project-relative path/);
  }
});

test("symlinked directories, files, roots, and in-project aliases cannot escape or bypass protections", async (t) => {
  const temporaryRoot = await temporary(t);
  const root = join(temporaryRoot, "project");
  const outside = join(temporaryRoot, "outside");
  await mkdir(root);
  await mkdir(outside);
  const sentinel = join(outside, "sentinel.png");
  await writeFile(sentinel, "untouched");
  const fs = new LocalProjectFs(root);
  await symlink(outside, join(root, "escape"));
  await assert.rejects(fs.readBytes("escape/sentinel.png"), /symlink/i);
  await assert.rejects(fs.readText("escape/sentinel.png"), /symlink/i);
  await assert.rejects(fs.writeText("escape/new.txt", "changed"), /symlink/i);
  await fs.writeText("logs/run.log", "log");
  await symlink(sentinel, join(root, "logs", "link.log"));
  await assert.rejects(fs.readText("logs/link.log"), /symlink/i);
  await assert.rejects(fs.writeBytes("logs/link.log", encode("changed")), /symlink/i);
  await mkdir(join(root, "refs"));
  await symlink(outside, join(root, "refs", "style"));
  await assert.rejects(fs.writeImage("refs/style/new.png", encode("changed")), /symlink/i);
  await symlink(sentinel, join(root, "refs", "linked.png"));
  await assert.rejects(fs.writeImage("refs/linked.png", encode("changed")), /symlink/i);
  await mkdir(join(root, "chapters", "001"), { recursive: true });
  await symlink(outside, join(root, "chapters", "001", "attempts"));
  await symlink(outside, join(root, "chapters", "001", "pages"));
  await assert.rejects(fs.writeImage("chapters/001/attempts/new.png", encode("changed")), /symlink/i);
  await assert.rejects(fs.replaceCopy("chapters/001/pages/sentinel.png", encode("changed")), /symlink/i);
  await symlink(join(root, "refs"), join(root, "logs", "images"));
  await assert.rejects(fs.writeJson("logs/images/new.png", {}), /symlink/i);
  await mkdir(join(root, "novel"));
  await symlink(sentinel, join(root, "novel", "source.txt"));
  await assert.rejects(fs.writeNovel(encode("changed"), true, "stamp"), /symlink/i);
  const rootAlias = join(temporaryRoot, "root-alias");
  await symlink(root, rootAlias);
  await assert.rejects(new LocalProjectFs(rootAlias).readText("logs/run.log"), /symlink/i);
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
  await assert.rejects(lstat(join(outside, "new.txt")), { code: "ENOENT" });
  await assert.rejects(lstat(join(outside, "new.png")), { code: "ENOENT" });
});

test("novel import is exclusive and forced replacements archive without overwriting", async (t) => {
  const fs = new LocalProjectFs(await temporary(t));
  await fs.writeNovel(encode("original"), false, "unused");
  await assert.rejects(fs.writeNovel(encode("unforced"), false, "unused"), { code: "EEXIST" });
  assert.equal(await fs.readText("novel/source.txt"), "original");
  assert.equal(await fs.readText("novel/source.unused.txt"), null);
  await fs.writeNovel(encode("second"), true, "20261109-120000");
  assert.equal(await fs.readText("novel/source.20261109-120000.txt"), "original");
  assert.equal(await fs.readText("novel/source.txt"), "second");
  await assert.rejects(fs.writeNovel(encode("collision"), true, "20261109-120000"), { code: "EEXIST" });
  assert.equal(await fs.readText("novel/source.txt"), "second");
  assert.equal(await fs.readText("novel/source.20261109-120000.txt"), "original");
  for (const stamp of ["", ".", "..", "../escape", "nested/stamp", "back\\slash", "nul\0stamp"]) {
    await assert.rejects(fs.writeNovel(encode("changed"), true, stamp), /Invalid novel archive stamp/);
  }
  await fs.writeNovel(encode("third"), true, "20261109-120001");
  assert.equal(await fs.readText("novel/source.20261109-120001.txt"), "second");
  assert.equal(await fs.readText("novel/source.txt"), "third");
});

test("project create, list, and open preserve metadata and count only exported chapters", async (t) => {
  const root = await temporary(t);
  const store = new LocalProjectStore(root);
  const definition = { id: "qinglan-2", title: "Qinglan", created_at: "2026-11-09T00:00:00Z", style_desc: "bright colors" };
  const handle = await store.create(definition);
  try {
    assert.deepEqual(parse((await handle.fs.readText("project.yaml"))!), {
      id: definition.id, title: definition.title, project: { style_desc: definition.style_desc },
    });
    const metadata = await handle.db.all<{ key: string; value: string }>("SELECT key, value FROM meta");
    assert.deepEqual(Object.fromEntries(metadata.map((row) => [row.key, row.value])), {
      project_id: definition.id, title: definition.title, created_at: definition.created_at, schema_version: "2",
    });
    for (const directory of ["refs/style", "refs/characters", "refs/locations", "bible", "novel", "chapters", "logs", "prompts"]) {
      assert.ok((await lstat(join(root, "projects", definition.id, directory))).isDirectory(), directory);
    }
    await handle.db.transaction([
      { sql: "INSERT INTO chapters (id, status) VALUES ('001', 'exported')" },
      { sql: "INSERT INTO chapters (id, status) VALUES ('002', 'rendered')" },
      { sql: "INSERT INTO chapters (id, status) VALUES ('003', 'imported')" },
      { sql: "INSERT INTO pages (id, chapter_id, status) VALUES ('001-p01', '001', 'flagged')" },
    ]);
    await assert.rejects(store.create({ ...definition, title: "must not replace" }), { code: "EEXIST" });
  } finally {
    await handle.db.close();
  }
  const noStyle = await store.create({ id: "2", title: "No Style", created_at: definition.created_at });
  try {
    assert.deepEqual(parse((await noStyle.fs.readText("project.yaml"))!), { id: "2", title: "No Style" });
  } finally {
    await noStyle.db.close();
  }
  assert.deepEqual(await store.list(), [
    { id: "2", title: "No Style", chapter_count: 0, completed_chapters: 0 },
    { id: "qinglan-2", title: "Qinglan", chapter_count: 3, completed_chapters: 1 },
  ]);
  const reopened = await store.open(definition.id);
  try {
    assert.equal((await reopened.db.get<{ status: string }>("SELECT status FROM pages WHERE id = '001-p01'"))?.status, "flagged");
    await reopened.fs.writeText("logs/reopened.log", "persistent project");
    assert.equal(await reopened.fs.readText("logs/reopened.log"), "persistent project");
  } finally {
    await reopened.db.close();
  }
  await store.list();
  for (const id of ["2", "qinglan-2"]) {
    await assert.rejects(lstat(join(root, "projects", id, "project.db-wal")), { code: "ENOENT" });
  }
});

test("project discovery validates IDs, ignores incomplete or symlinked projects, and never creates bogus state", async (t) => {
  const root = await temporary(t);
  const workspace = join(root, "workspace");
  const store = new LocalProjectStore(workspace);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.open("missing"), PreconditionError);
  for (const id of ["", "UPPER", "bad_id", "-start", "end-", "two--hyphens", "../escape", "/absolute", "back\\slash", "nul\0id", "newline\n"]) {
    await assert.rejects(store.create({ id, title: "Invalid", created_at: "now" }), PreconditionError);
    await assert.rejects(store.open(id), PreconditionError);
  }
  await assert.rejects(lstat(workspace), { code: "ENOENT" });
  const valid = await store.create({ id: "valid", title: "Valid", created_at: "now", style_desc: "" });
  try {
    assert.deepEqual(parse((await valid.fs.readText("project.yaml"))!).project, { style_desc: "" });
  } finally {
    await valid.db.close();
  }
  const projects = join(workspace, "projects");
  for (const id of ["yaml-only", "database-only", "empty", "Bad_Id", "linked-db", "linked-yaml"]) {
    await mkdir(join(projects, id));
  }
  await writeFile(join(projects, "yaml-only", "project.yaml"), "id: yaml-only\ntitle: Incomplete\n");
  await writeFile(join(projects, "database-only", "project.db"), new Uint8Array());
  await writeFile(join(projects, "Bad_Id", "project.yaml"), "id: Bad_Id\n");
  await writeFile(join(projects, "Bad_Id", "project.db"), new Uint8Array());
  await writeFile(join(projects, "linked-db", "project.yaml"), "id: linked-db\n");
  await symlink(join(projects, "valid", "project.db"), join(projects, "linked-db", "project.db"));
  await symlink(join(projects, "valid", "project.yaml"), join(projects, "linked-yaml", "project.yaml"));
  await writeFile(join(projects, "linked-yaml", "project.db"), new Uint8Array());
  await symlink(join(projects, "valid"), join(projects, "alias"));
  for (const id of ["yaml-only", "database-only", "empty", "linked-db", "linked-yaml", "alias"]) {
    await assert.rejects(store.open(id), PreconditionError);
  }
  assert.deepEqual(await store.list(), [{ id: "valid", title: "Valid", chapter_count: 0, completed_chapters: 0 }]);
  await assert.rejects(lstat(join(projects, "yaml-only", "project.db")), { code: "ENOENT" });
  assert.equal((await lstat(join(projects, "database-only", "project.db"))).size, 0);
  assert.equal((await lstat(join(projects, "linked-yaml", "project.db"))).size, 0);
});
