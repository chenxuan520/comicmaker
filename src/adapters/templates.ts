import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Template, TemplateSource, TemplateStore } from "../core/ports.js";
import { LocalProjectFs } from "./projectFs.js";

export function templateName(value: string): string {
  const name = value.endsWith(".md") ? value : `${value}.md`;
  if (name.split("/").some((part) => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) || part === "..")) throw new Error("Invalid template name");
  return name;
}

export class LocalTemplateStore implements TemplateStore {
  private readonly layers: { root: string; source: TemplateSource }[];
  constructor(repository: string, private readonly workspace: string, private readonly projectId?: string) {
    if (projectId !== undefined && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(projectId)?.[0] !== projectId) throw new Error("Invalid project ID");
    this.layers = [
      ...(projectId ? [{ root: join(workspace, "projects", projectId), source: "project" as const }] : []),
      { root: workspace, source: "workspace" },
      { root: repository, source: "repository" },
    ];
  }

  private async checkLayerRoot(layer: { root: string; source: TemplateSource }): Promise<void> {
    const directories = layer.source === "project" ? [this.workspace, join(this.workspace, "projects"), layer.root] : [layer.root];
    for (const directory of directories) {
      const info = await lstat(resolve(directory));
      if (info.isSymbolicLink()) throw new Error("Template layer roots cannot be symlinks");
      if (!info.isDirectory()) throw new Error("Template layer roots must be directories");
    }
  }

  async get(value: string): Promise<Template> {
    const name = templateName(value);
    for (const layer of this.layers) {
      try {
        await this.checkLayerRoot(layer);
        const content = await new LocalProjectFs(layer.root).readText(`prompts/${name}`);
        if (content !== null) return { name, content, source: layer.source };
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    throw new Error(`Template not found: ${name}`);
  }

  async list(): Promise<Template[]> {
    const names = new Set<string>();
    const walk = async (root: string, prefix = "") => {
      let entries;
      try {
        const info = await lstat(root);
        if (info.isSymbolicLink()) throw new Error("Template directories cannot be symlinks");
        if (!info.isDirectory()) throw new Error("Template paths must be directories");
        entries = await readdir(root, { withFileTypes: true });
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error(`Symlinks are not permitted in template paths: ${name}`);
        if (entry.isDirectory()) await walk(join(root, entry.name), name);
        else if (entry.isFile() && entry.name.endsWith(".md")) names.add(name);
      }
    };
    for (const layer of this.layers) {
      try { await this.checkLayerRoot(layer); await walk(join(layer.root, "prompts")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return Promise.all([...names].sort().map((name) => this.get(name)));
  }

  async put(value: string, content: string, layer: "workspace" | "project"): Promise<void> {
    const name = templateName(value);
    if (layer === "project") {
      if (!this.projectId) throw new Error("Select a project first");
      await this.checkLayerRoot({ root: join(this.workspace, "projects", this.projectId), source: "project" });
      await new LocalProjectFs(join(this.workspace, "projects", this.projectId)).writeText(`prompts/${name}`, content);
    } else {
      await new LocalProjectFs(this.workspace).writeText(`prompts/${name}`, content);
    }
  }
}
