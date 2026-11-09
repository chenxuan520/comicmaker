import { lstat, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { PreconditionError } from "../core/errors.js";
import type { ProjectDefinition, ProjectHandle, ProjectListItem, ProjectStore } from "../core/ports.js";
import { LocalProjectFs } from "./projectFs.js";
import { openProjectDb } from "./sqlite.js";

const projectIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class LocalProjectStore implements ProjectStore {
  private readonly projectsPath: string;

  constructor(workspaceRoot: string) {
    this.projectsPath = resolve(workspaceRoot, "projects");
  }

  private projectPath(id: string): string {
    if (projectIdPattern.exec(id)?.[0] !== id) {
      throw new PreconditionError("Project ID must contain lowercase letters or digits separated by single hyphens");
    }
    return join(this.projectsPath, id);
  }

  async create(project: ProjectDefinition): Promise<ProjectHandle> {
    const rootPath = this.projectPath(project.id);
    await mkdir(this.projectsPath, { recursive: true });
    if (!(await lstat(this.projectsPath)).isDirectory()) {
      throw new PreconditionError("Workspace projects directory cannot be a symlink");
    }
    await mkdir(rootPath);
    for (const directory of [
      "refs/style", "refs/characters", "refs/locations", "bible", "novel", "chapters", "logs", "prompts",
    ]) {
      await mkdir(join(rootPath, directory), { recursive: true });
    }
    const fs = new LocalProjectFs(rootPath);
    await fs.writeText("project.yaml", stringify({
      id: project.id,
      title: project.title,
      ...(project.style_desc === undefined ? {} : { project: { style_desc: project.style_desc } }),
    }));
    const db = await openProjectDb(join(rootPath, "project.db"));
    try {
      await db.run(
        "INSERT INTO meta (key, value) VALUES ('project_id', ?), ('title', ?), ('created_at', ?)",
        [project.id, project.title, project.created_at],
      );
      return { db, fs };
    } catch (error) {
      await db.close();
      throw error;
    }
  }

  async open(id: string): Promise<ProjectHandle> {
    const rootPath = this.projectPath(id);
    try {
      for (const directory of [this.projectsPath, rootPath]) {
        if (!(await lstat(directory)).isDirectory()) {
          throw new PreconditionError(`Project ${id} has missing or symlinked directories`);
        }
      }
      for (const file of ["project.yaml", "project.db"]) {
        if (!(await lstat(join(rootPath, file))).isFile()) {
          throw new PreconditionError(`Project ${id} has missing or symlinked storage files`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PreconditionError(`Project ${id} does not exist or is incomplete`);
      }
      throw error;
    }
    return { db: await openProjectDb(join(rootPath, "project.db")), fs: new LocalProjectFs(rootPath) };
  }

  async list(): Promise<ProjectListItem[]> {
    let entries;
    try {
      if (!(await lstat(this.projectsPath)).isDirectory()) {
        throw new PreconditionError("Workspace projects directory cannot be a symlink");
      }
      entries = await readdir(this.projectsPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const projects: ProjectListItem[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || projectIdPattern.exec(entry.name)?.[0] !== entry.name) continue;
      let handle;
      try {
        handle = await this.open(entry.name);
      } catch (error) {
        if (error instanceof PreconditionError) continue;
        throw error;
      }
      try {
        const [progress] = await handle.db.all<{
          title: string;
          chapter_count: number;
          completed_chapters: number;
        }>(`SELECT (SELECT value FROM meta WHERE key = 'title') AS title,
          COUNT(*) AS chapter_count,
          COALESCE(SUM(status = 'exported'), 0) AS completed_chapters FROM chapters`);
        projects.push({ id: entry.name, ...progress });
      } finally {
        await handle.db.close();
      }
    }
    return projects;
  }
}
