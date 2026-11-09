import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { LocalProjectFs } from "../src/adapters/projectFs.js";
import { LocalTemplateStore } from "../src/adapters/templates.js";
import { createProject } from "../src/core/project.js";
import { PromptEngine } from "../src/core/prompts.js";
import { fixture, MockAi, png, repository } from "./helpers.js";

async function safetyFixture(t: TestContext) {
  const ai = new MockAi();
  const f = await fixture(ai);
  t.after(f.close);
  const outside = await mkdtemp(join(dirname(f.root), "comic-templates-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  return { ...f, ai, outside };
}

for (const layer of ["project", "workspace", "repository"] as const) {
  for (const link of ["file", "directory"] as const) {
    test(`${layer} template reads, lists, rendering, and eject reject a symlinked ${link}`, async (t) => {
      const f = await safetyFixture(t);
      await createProject(f.workspace.store, "book", "Book");
      const projectRoot = join(f.root, "projects", "book");
      const repositoryRoot = layer === "repository" ? join(f.root, "repository") : repository;
      const layerRoot = layer === "project" ? projectRoot : layer === "workspace" ? f.root : repositoryRoot;
      await mkdir(join(layerRoot, "prompts"), { recursive: true });
      const name = "extract/system.md";
      const outsideFile = join(f.outside, "system.md");
      await writeFile(outsideFile, "outside secret");
      if (link === "file") {
        await mkdir(join(layerRoot, "prompts", "extract"));
        await symlink(outsideFile, join(layerRoot, "prompts", name));
      } else {
        await symlink(f.outside, join(layerRoot, "prompts", "extract"));
      }
      const store = new LocalTemplateStore(repositoryRoot, f.root, "book");
      await assert.rejects(store.get(name), /symlink/i);
      await assert.rejects(store.list(), /symlink/i);
      await assert.rejects(new PromptEngine(store, {}).render(name), /symlink/i);
      for (const destination of ["workspace", "project"] as const) {
        await assert.rejects(async () => {
          const template = await store.get(name);
          await store.put(template.name, template.content, destination);
        }, /symlink/i);
      }
      for (const destination of [f.root, projectRoot]) {
        if (destination !== layerRoot) await assert.rejects(lstat(join(destination, "prompts", name)), { code: "ENOENT" });
      }
      assert.equal(await readFile(outsideFile, "utf8"), "outside secret");
      assert.deepEqual(f.ai.structuredCalls, []);
      assert.deepEqual(f.ai.imageCalls, []);
    });
  }
}

for (const alias of ["file", "dangling-file", "directory", "prompts-root"] as const) {
  test(`workspace writes and eject reject an outside ${alias} alias without modifying its target`, async (t) => {
    const f = await safetyFixture(t);
    await createProject(f.workspace.store, "book", "Book");
    const store = new LocalTemplateStore(repository, f.root, "book");
    const name = "refs/style_sample.md";
    await store.put(name, "effective project template", "project");
    const outsideFile = alias === "prompts-root" ? join(f.outside, "refs", "style_sample.md") : join(f.outside, "style_sample.md");
    await mkdir(dirname(outsideFile), { recursive: true });
    if (alias !== "dangling-file") await writeFile(outsideFile, "untouched");
    if (alias === "prompts-root") {
      await rm(join(f.root, "prompts"), { recursive: true });
      await symlink(f.outside, join(f.root, "prompts"));
    } else if (alias === "directory") {
      await symlink(f.outside, join(f.root, "prompts", "refs"));
    } else {
      await mkdir(join(f.root, "prompts", "refs"));
      await symlink(outsideFile, join(f.root, "prompts", name));
    }
    assert.equal((await store.get(name)).source, "project");
    await assert.rejects(store.put(name, "replacement", "workspace"), /symlink/i);
    await assert.rejects(async () => {
      const template = await store.get(name);
      await store.put(template.name, template.content, "workspace");
    }, /symlink/i);
    if (alias === "dangling-file") await assert.rejects(lstat(outsideFile), { code: "ENOENT" });
    else assert.equal(await readFile(outsideFile, "utf8"), "untouched");
    if (alias === "directory" || alias === "prompts-root") {
      await assert.rejects(store.put("refs/new.md", "new template", "workspace"), /symlink/i);
      const outsideNew = alias === "prompts-root" ? join(f.outside, "refs", "new.md") : join(f.outside, "new.md");
      await assert.rejects(lstat(outsideNew), { code: "ENOENT" });
    }
  });
}

test("workspace eject cannot overwrite a locked project reference through a template alias", async (t) => {
  const f = await safetyFixture(t);
  await createProject(f.workspace.store, "book", "Book");
  const handle = await f.workspace.store.open("book");
  try {
    const refPath = "refs/style/locked.png";
    await handle.fs.writeImage(refPath, png);
    await handle.db.run("INSERT INTO refs (id, kind, target_id, path, status) VALUES (?, ?, ?, ?, 'locked')", ["locked", "style", "project", refPath]);
    const store = new LocalTemplateStore(repository, f.root, "book");
    const name = "refs/style_sample.md";
    await store.put(name, "effective project template", "project");
    await mkdir(join(f.root, "prompts", "refs"));
    const lockedFile = join(f.root, "projects", "book", refPath);
    await symlink(lockedFile, join(f.root, "prompts", name));
    await assert.rejects(async () => {
      const template = await store.get(name);
      await store.put(template.name, template.content, "workspace");
    }, /symlink/i);
    assert.deepEqual(new Uint8Array(await readFile(lockedFile)), png);
    assert.equal((await handle.db.get<{ status: string }>("SELECT status FROM refs WHERE id = 'locked'"))?.status, "locked");
  } finally { await handle.db.close(); }
});

for (const [source, parts] of [
  ["workspace", []],
  ["workspace", ["prompts"]],
  ["project", []],
  ["project", ["projects"]],
  ["project", ["projects", "book"]],
  ["project", ["projects", "book", "prompts"]],
  ["repository", []],
  ["repository", ["prompts"]],
] as const) {
  test(`${source} layer rejects a symlinked ${parts.join("/") || "root"} path`, async (t) => {
    const f = await safetyFixture(t);
    const workspaceRoot = join(f.root, "test-workspace");
    const repositoryRoot = join(f.root, "test-repository");
    await mkdir(join(workspaceRoot, "projects", "book", "prompts"), { recursive: true });
    await mkdir(join(workspaceRoot, "prompts"));
    await mkdir(join(repositoryRoot, "prompts"), { recursive: true });
    const templateParts = source === "project" ? ["projects", "book", "prompts", "extract", "system.md"] : ["prompts", "extract", "system.md"];
    const outsideFile = join(f.outside, ...templateParts.slice(parts.length));
    await mkdir(dirname(outsideFile), { recursive: true });
    await writeFile(outsideFile, "outside template");
    const linkPath = join(source === "repository" ? repositoryRoot : workspaceRoot, ...parts);
    await rm(linkPath, { recursive: true });
    await symlink(f.outside, linkPath);
    const stores = ["", "/"].map((suffix) => new LocalTemplateStore(`${repositoryRoot}${suffix}`, `${workspaceRoot}${suffix}`, source === "project" ? "book" : undefined));
    for (const store of stores) {
      await assert.rejects(store.get("extract/system"), /symlink/i);
      await assert.rejects(store.list(), /symlink/i);
      if (source !== "repository") await assert.rejects(store.put("extract/system", "replacement", source), /symlink/i);
    }
    assert.equal(await readFile(outsideFile, "utf8"), "outside template");
    await rm(outsideFile);
    for (const store of stores) await assert.rejects(store.list(), /symlink/i);
  });
}

test("template stores validate explicitly supplied project IDs before resolving paths", async (t) => {
  const f = await fixture(new MockAi());
  t.after(f.close);
  for (const id of ["", "../outside", "../../outside", "book/../../outside", "/absolute", "C:/absolute", "back\\slash", "nul\0id", "UPPER", "bad_id", "-start", "end-", "two--hyphens", "book\n"]) {
    assert.throws(() => new LocalTemplateStore(repository, f.root, id), /project id/i);
  }
  for (const id of ["book", "book-2", "2"]) assert.doesNotThrow(() => new LocalTemplateStore(repository, f.root, id));
});

test("missing optional template layers fall back without creating workspace or project roots", async (t) => {
  const f = await fixture(new MockAi());
  t.after(f.close);
  const baseline = new LocalTemplateStore(repository, f.root);
  const expectedList = await baseline.list();
  const expectedTemplate = await baseline.get("extract/system");
  assert.ok(expectedList.length > 0);
  assert.ok(expectedList.every((template) => template.source === "repository"));
  await rm(join(f.root, "prompts"), { recursive: true });
  await mkdir(join(f.root, "projects", "book"));
  const missingWorkspace = join(f.root, "missing-workspace");
  for (const [workspace, id] of [[f.root, undefined], [f.root, "book"], [f.root, "missing"], [missingWorkspace, undefined], [missingWorkspace, "missing"]] as const) {
    const store = new LocalTemplateStore(repository, workspace, id);
    assert.deepEqual(await store.list(), expectedList);
    assert.deepEqual(await store.get("extract/system"), expectedTemplate);
  }
  await assert.rejects(baseline.put("sample", "template", "project"), /Select a project first/);
  await assert.rejects(new LocalTemplateStore(repository, missingWorkspace).put("sample", "template", "workspace"), { code: "ENOENT" });
  await assert.rejects(lstat(missingWorkspace), { code: "ENOENT" });
  await assert.rejects(lstat(join(f.root, "projects", "missing")), { code: "ENOENT" });
  const empty = new LocalTemplateStore(join(f.root, "missing-repository"), missingWorkspace, "missing");
  assert.deepEqual(await empty.list(), []);
  await assert.rejects(empty.get("sample"), /Template not found: sample.md/);
});

test("non-directory template layers are errors rather than optional fallbacks", async (t) => {
  const f = await fixture(new MockAi());
  t.after(f.close);
  await rm(join(f.root, "prompts"), { recursive: true });
  await writeFile(join(f.root, "prompts"), "not a directory");
  const store = new LocalTemplateStore(repository, f.root);
  await assert.rejects(store.get("extract/system"), /director(?:y|ies)|ENOTDIR/i);
  await assert.rejects(store.list(), /director(?:y|ies)|ENOTDIR/i);
  await assert.rejects(store.put("nested/sample", "template", "workspace"), /director(?:y|ies)|ENOTDIR/i);
});

test("safe nested partials preserve three-layer precedence, provenance, empty overrides, and effective eject", async (t) => {
  const f = await fixture(new MockAi());
  t.after(f.close);
  await createProject(f.workspace.store, "book-2", "Book");
  const repositoryRoot = join(f.root, "repository");
  await mkdir(repositoryRoot);
  const repositoryFs = new LocalProjectFs(repositoryRoot);
  await repositoryFs.writeText("prompts/sample.md", "repository sample");
  await repositoryFs.writeText("prompts/empty.md", "repository empty");
  await repositoryFs.writeText("prompts/partials/nested/shared.md", "repository shared");
  await repositoryFs.writeText("prompts/partials/nested/rules.md", "repository {{vars.label}}");
  await rm(join(f.root, "prompts"), { recursive: true });
  await rm(join(f.root, "projects", "book-2", "prompts"), { recursive: true });
  const store = new LocalTemplateStore(repositoryRoot, f.root, "book-2");
  await store.put("partials/nested/shared", "workspace {{> nested/rules}}", "workspace");
  await store.put("sample", "workspace sample", "workspace");
  await store.put("sample", "project {{> nested/shared}}", "project");
  await store.put("empty", "", "workspace");
  assert.deepEqual(await store.list(), [
    { name: "empty.md", content: "", source: "workspace" },
    { name: "partials/nested/rules.md", content: "repository {{vars.label}}", source: "repository" },
    { name: "partials/nested/shared.md", content: "workspace {{> nested/rules}}", source: "workspace" },
    { name: "sample.md", content: "project {{> nested/shared}}", source: "project" },
  ]);
  const engine = new PromptEngine(store, { vars: { label: "A&B" } });
  assert.deepEqual(await engine.render("sample"), {
    text: "project workspace repository A&B",
    sources: { "sample.md": "project", "partials/nested/rules.md": "repository", "partials/nested/shared.md": "workspace" },
  });
  const effective = await store.get("sample");
  await store.put(effective.name, effective.content, "workspace");
  await rm(join(f.root, "projects", "book-2", "prompts", "sample.md"));
  assert.deepEqual(await store.get("sample"), { ...effective, source: "workspace" });
  assert.equal(await repositoryFs.readText("prompts/sample.md"), "repository sample");
});
