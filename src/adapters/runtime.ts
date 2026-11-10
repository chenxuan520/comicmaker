import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ulid } from "ulid";
import { Budget, type BudgetPolicy } from "../core/budget.js";
import { PreconditionError } from "../core/errors.js";
import { PromptEngine } from "../core/prompts.js";
import type { AiProvider, Db, Log } from "../core/ports.js";
import type { Context } from "../core/types.js";
import { ConfiguredAiProvider, aiKeys } from "./ai.js";
import { initializeWorkspace, loadConfig } from "./config.js";
import { ImgBedUploader, imgBedCredentials } from "./imgbed.js";
import { LocalProjectStore } from "./projects.js";
import { openLedgerDb } from "./sqlite.js";
import { LocalTemplateStore } from "./templates.js";

async function repositoryRoot(): Promise<string> {
  const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
  try { await access(join(sourceRoot, "config.default.yaml")); return sourceRoot; }
  catch { return dirname(sourceRoot); }
}

export class WorkspaceRuntime {
  readonly store: LocalProjectStore;

  private constructor(public readonly repository: string, public readonly root: string, public readonly ledger: Db, private readonly provider?: AiProvider) {
    this.store = new LocalProjectStore(root);
  }

  static async create(options: { repository?: string; workspace?: string; provider?: AiProvider } = {}) {
    const repository = options.repository ?? await repositoryRoot();
    const root = resolve(options.workspace ?? process.env.COMIC_WORKSPACE ?? "./workspace");
    await initializeWorkspace(repository, root);
    return new WorkspaceRuntime(repository, root, await openLedgerDb(join(root, "ledger.db")), options.provider);
  }

  async currentProject(): Promise<string | null> {
    const row = await this.ledger.get<{ value: string }>("SELECT value FROM meta WHERE key = 'current_project'");
    return row?.value ?? null;
  }

  async selectProject(id: string): Promise<void> {
    const handle = await this.store.open(id);
    await handle.db.close();
    await this.ledger.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('current_project', ?)", [id]);
  }

  async projectId(explicit?: string): Promise<string> {
    const id = explicit ?? await this.currentProject();
    if (!id) throw new PreconditionError("Select a project with -p <id> or comic use <id>");
    return id;
  }

  async context(id: string, options: { ignoreLimit?: boolean; signal?: AbortSignal; log?: Log } = {}) {
    const handle = await this.store.open(id);
    try {
      const loaded = await loadConfig(this.repository, this.root, id);
      const config = loaded.config;
      const events: { time: string; level: string; message: string; details?: unknown }[] = [];
      const log: Log = (level, message, details) => {
        events.push({ time: new Date().toISOString(), level, message, details });
        options.log?.(level, message, details);
      };
      const meta = await handle.db.all<{ key: string; value: string }>("SELECT * FROM meta WHERE key IN ('project_id', 'title')");
      const project = { id, title: typeof loaded.projectRaw.title === "string" ? loaded.projectRaw.title : meta.find((row) => row.key === "title")?.value ?? id, style_desc: config.project.style_desc };
      const rawBudget = loaded.projectRaw.budget as Partial<BudgetPolicy> | undefined;
      const projectPolicy = rawBudget && Object.hasOwn(rawBudget, "limit_usd") && rawBudget.limit_usd !== null ? config.budget : null;
      const ctx: Context = {
        ...handle, config, project, signal: options.signal, log,
        budget: new Budget(this.ledger, id, loaded.workspaceConfig.budget, projectPolicy, options.ignoreLimit),
        prompts: new PromptEngine(new LocalTemplateStore(this.repository, this.root, id), { config, project, vars: config.prompts.vars }),
        ai: this.provider ?? new ConfiguredAiProvider(config, await aiKeys(this.root, config)),
        imageHost: config.export.imgbed.enabled ? new ImgBedUploader({ baseURL: config.export.imgbed.base_url, ...await imgBedCredentials(this.root) }) : undefined,
      };
      for (const model of new Set([...Object.values(config.models), config.image.model])) if (!config.pricing[model]) log("warning", `Pricing is not configured for ${model}; estimates will be used`);
      return {
        ctx, loaded, events,
        close: async () => {
          try { if (events.length) await handle.fs.writeText(`logs/run-${ulid()}.log`, events.map((event) => JSON.stringify(event)).join("\n") + "\n"); }
          finally { await handle.db.close(); }
        },
      };
    } catch (error) {
      await handle.db.close();
      throw error;
    }
  }

  async close(): Promise<void> { await this.ledger.close(); }
}

export async function exportFont(ctx: Context, workspaceRoot: string): Promise<Uint8Array | undefined> {
  const configured = ctx.config.export.font_path;
  const candidates = typeof configured === "string" ? [resolve(workspaceRoot, configured)] : [
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
  ];
  for (const path of candidates) {
    try { return new Uint8Array(await readFile(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return undefined;
}
