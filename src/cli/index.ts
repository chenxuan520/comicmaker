#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { WorkspaceRuntime, exportFont } from "../adapters/runtime.js";
import { loadConfig } from "../adapters/config.js";
import { LocalTemplateStore } from "../adapters/templates.js";
import { budgetReport } from "../core/budget.js";
import { createProject, importNovel } from "../core/project.js";
import { addLocationChapter, addOutfitChapter, prepareBook } from "../core/steps/prepare.js";
import { generateRefs, lockRef } from "../core/steps/refs.js";
import { adaptChapter, patchStoryboard } from "../core/steps/adapt.js";
import { redoPage, renderChapter } from "../core/steps/render.js";
import { exportChapter } from "../core/steps/export.js";
import { dryRunChapter, renderStepPrompt, runChapter } from "../core/pipeline.js";
import { getStatus } from "../core/status.js";
import { errorInfo, PreconditionError } from "../core/errors.js";
import type { Context, Ref } from "../core/types.js";
import { serve } from "../adapters/server.js";

interface Flags {
  projectId?: string; json?: boolean; force?: boolean; ignoreLimit?: boolean;
  title?: string; style?: string; novel?: string; chapter?: string; page?: string;
  kind?: string; target?: string; status?: string; note?: string; workspace?: boolean;
  project?: boolean; dryRun?: boolean; host?: string; port?: string; file?: string; paragraph?: string;
}

const program = new Command().name("comic").description("Local AI novel-to-comic studio").version("0.1.0")
  .option("-p, --project-id <id>", "Project ID; defaults to comic use selection")
  .option("--json", "Machine-readable JSON output")
  .option("--force", "Rerun or replace derived outputs; immutable images are retained")
  .option("--ignore-limit", "Skip budget caps for this invocation")
  .exitOverride().configureOutput({ writeErr: () => {} });
let runtimePromise: Promise<WorkspaceRuntime> | undefined;
const runtime = () => runtimePromise ??= WorkspaceRuntime.create();
const controller = new AbortController();
const interrupt = () => controller.abort(new Error("Interrupted; progress saved. Rerun the command to resume."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

function action(command: Command, needsProject: boolean, handler: (args: string[], flags: Flags, workspace: WorkspaceRuntime, ctx?: Context) => Promise<unknown>) {
  command.action(async (...values: unknown[]) => {
    const cmd = values.at(-1) as Command;
    const flags = cmd.optsWithGlobals<Flags>();
    const workspace = await runtime();
    const handle = needsProject ? await workspace.context(await workspace.projectId(flags.projectId), {
      ignoreLimit: flags.ignoreLimit, signal: controller.signal,
      log: (level, message) => { if (!flags.json) process.stderr.write(`[${level}] ${message}\n`); },
    }) : undefined;
    try {
      const result = await handler(values.slice(0, -2) as string[], flags, workspace, handle?.ctx);
      if (result !== undefined) process.stdout.write(JSON.stringify(result, null, flags.json ? undefined : 2) + "\n");
    } finally { await handle?.close(); }
  });
}

action(program.command("new <project_id>").requiredOption("--title <title>").option("--style <description>"), false, async ([id], flags, workspace) => {
  const created = await createProject(workspace.store, id, flags.title!, flags.style);
  await workspace.selectProject(id);
  return created;
});
action(program.command("list"), false, async (_, __, workspace) => ({ projects: await workspace.store.list(), current_project: await workspace.currentProject() }));
action(program.command("use <project_id>"), false, async ([id], _, workspace) => { await workspace.selectProject(id); return { current_project: id }; });
action(program.command("import").requiredOption("--novel <path>"), true, async (_, flags, __, ctx) => importNovel(ctx!, new Uint8Array(await readFile(resolve(flags.novel!))), { force: flags.force }));
action(program.command("prepare"), true, async (_, flags, __, ctx) => prepareBook(ctx!, { force: flags.force }));
const outfits = program.command("outfits");
action(outfits.command("include <outfit_id>").requiredOption("--chapter <n>").requiredOption("--paragraph <n>"), true, async ([id], flags, __, ctx) => addOutfitChapter(ctx!, id, flags.chapter!, flags.paragraph!));
const locations = program.command("locations");
action(locations.command("include <location_id>").requiredOption("--chapter <n>").requiredOption("--paragraph <n>"), true, async ([id], flags, __, ctx) => addLocationChapter(ctx!, id, flags.chapter!, flags.paragraph!));

const refs = program.command("refs");
action(refs.command("gen").requiredOption("--kind <kind>").option("--target <id>"), true, async (_, flags, __, ctx) => {
  if (!["style", "outfit", "location"].includes(flags.kind!)) throw new PreconditionError("kind must be style, outfit or location");
  return generateRefs(ctx!, { kind: flags.kind as Ref["kind"], target: flags.target, force: flags.force });
});
action(refs.command("list").option("--status <status>"), true, async (_, flags, __, ctx) => ({ refs: await ctx!.db.all(`SELECT * FROM refs WHERE path IS NOT NULL ${flags.status ? "AND status = ?" : ""} ORDER BY kind, target_id, id`, flags.status ? [flags.status] : []) }));
action(program.command("lock <ref_id>"), true, async ([id], _, __, ctx) => lockRef(ctx!, id));
action(program.command("adapt").requiredOption("--chapter <n>"), true, async (_, flags, __, ctx) => adaptChapter(ctx!, flags.chapter!, { force: flags.force }));
const storyboard = program.command("storyboard");
action(storyboard.command("patch").requiredOption("--chapter <n>").requiredOption("--file <path>"), true, async (_, flags, __, ctx) => patchStoryboard(ctx!, flags.chapter!, JSON.parse(await readFile(resolve(flags.file!), "utf8")).pages));
action(program.command("render").requiredOption("--chapter <n>"), true, async (_, flags, __, ctx) => renderChapter(ctx!, flags.chapter!, { force: flags.force }));
action(program.command("redo").requiredOption("--page <id>").option("--note <text>"), true, async (_, flags, __, ctx) => redoPage(ctx!, flags.page!, flags.note));
action(program.command("export").requiredOption("--chapter <n>"), true, async (_, flags, workspace, ctx) => exportChapter(ctx!, flags.chapter!, { force: flags.force, font: await exportFont(ctx!, workspace.root) }));
action(program.command("run").requiredOption("--chapter <n>").option("--dry-run"), true, async (_, flags, workspace, ctx) => flags.dryRun ? dryRunChapter(ctx!, flags.chapter!) : runChapter(ctx!, flags.chapter!, { force: flags.force, font: await exportFont(ctx!, workspace.root) }));
action(program.command("status").option("--chapter <n>"), true, async (_, flags, __, ctx) => getStatus(ctx!, flags.chapter));
action(program.command("budget"), false, async (_, flags, workspace) => {
  const loaded = await loadConfig(workspace.repository, workspace.root);
  return budgetReport(workspace.ledger, loaded.config.budget, flags.projectId);
});
action(program.command("config").option("--project", "Include project-level YAML values"), true, async (_, flags, workspace, ctx) => {
  const loaded = await loadConfig(workspace.repository, workspace.root, ctx!.project.id);
  return { config: loaded.config, sources: loaded.sources, ...(flags.project ? { project: loaded.projectRaw } : {}) };
});

const prompts = program.command("prompts");
action(prompts.command("list"), true, async (_, __, workspace, ctx) => ({ templates: (await new LocalTemplateStore(workspace.repository, workspace.root, ctx!.project.id).list()).map(({ name, source }) => ({ name, source })) }));
action(prompts.command("eject <template>").option("--workspace"), true, async ([name], flags, workspace, ctx) => {
  const store = new LocalTemplateStore(workspace.repository, workspace.root, ctx!.project.id);
  const template = await store.get(name);
  const source = flags.workspace ? "workspace" : "project";
  await store.put(name, template.content, source);
  return { name: template.name, source };
});
action(prompts.command("render <step>").option("--chapter <n>").option("--page <id>").option("--target <id>"), true, async ([step], flags, _, ctx) => renderStepPrompt(ctx!, step, { chapter: flags.chapter, page: flags.page, target: flags.target }));
action(program.command("serve").option("--host <host>", "Loopback address").option("--port <port>", "Local HTTP port"), false, async (_, flags, workspace) => {
  const loaded = await loadConfig(workspace.repository, workspace.root);
  await serve(workspace, { host: flags.host ?? loaded.config.web.host, port: flags.port ? Number(flags.port) : loaded.config.web.port, signal: controller.signal, json: flags.json });
});

try {
  await program.parseAsync();
  if (!process.argv.slice(2).length) program.outputHelp();
} catch (error) {
  if (!(error instanceof CommanderError && error.exitCode === 0)) {
    const info = errorInfo(error);
    const json = process.argv.includes("--json");
    (json ? process.stdout : process.stderr).write(json ? JSON.stringify({ error: info }) + "\n" : `${info.message}${info.details ? "\n" + JSON.stringify(info.details, null, 2) : ""}\n`);
    process.exitCode = controller.signal.aborted ? 130 : info.code;
  }
} finally {
  if (runtimePromise) await (await runtimePromise).close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
