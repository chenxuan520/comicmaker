import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import type { ProjectFs } from "../core/ports.js";

export class LocalProjectFs implements ProjectFs {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  private parts(relPath: string): string[] {
    const parts = relPath.split("/");
    if (
      isAbsolute(relPath) || win32.isAbsolute(relPath) || relPath.includes("\\") || relPath.includes("\0") ||
      parts.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`Invalid project-relative path: ${relPath}`);
    }
    return parts;
  }

  private async resolvePath(relPath: string, createParents = false): Promise<string> {
    const parts = this.parts(relPath);
    const root = await lstat(this.rootPath);
    if (root.isSymbolicLink()) throw new Error("Project root cannot be a symlink");
    if (!root.isDirectory()) throw new Error("Project root must be a directory");
    let filePath = this.rootPath;
    for (let index = 0; index < parts.length; index += 1) {
      filePath = join(filePath, parts[index]);
      let info;
      try {
        info = await lstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (createParents && index < parts.length - 1) {
          await mkdir(filePath, { recursive: true });
          info = await lstat(filePath);
        }
      }
      if (info?.isSymbolicLink()) throw new Error(`Symlinks are not permitted in project paths: ${relPath}`);
      if (info && index < parts.length - 1 && !info.isDirectory()) {
        throw new Error(`Project path component must be a directory: ${relPath}`);
      }
    }
    return filePath;
  }

  async writeImage(relPath: string, data: Uint8Array): Promise<{ sha256: string }> {
    const parts = this.parts(relPath);
    if (!(
      (parts[0] === "refs" && parts.length > 1) ||
      (parts[0] === "chapters" && parts[2] === "attempts" && parts.length > 3)
    )) {
      throw new Error("Images can only be written to immutable refs or chapter attempts paths");
    }
    const filePath = await this.resolvePath(relPath, true);
    const bytes = new Uint8Array(data);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    await writeFile(filePath, bytes, { flag: "wx" });
    return {
      sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  }

  async replaceCopy(relPath: string, data: Uint8Array): Promise<void> {
    const parts = this.parts(relPath);
    if (!(parts[0] === "chapters" && parts[2] === "pages" && parts.length > 3 && relPath.endsWith(".png"))) {
      throw new Error("Final copies can only be replaced in chapters/<id>/pages/*.png");
    }
    await writeFile(await this.resolvePath(relPath, true), data);
  }

  async readBytes(relPath: string): Promise<Uint8Array | null> {
    const filePath = await this.resolvePath(relPath);
    try {
      return new Uint8Array(await readFile(filePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async readText(relPath: string): Promise<string | null> {
    const bytes = await this.readBytes(relPath);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  async writeBytes(relPath: string, data: Uint8Array): Promise<void> {
    const parts = this.parts(relPath).map((part) => part.toLowerCase());
    if (
      parts[0] === "refs" ||
      (parts[0] === "chapters" && (parts[2] === "attempts" || parts[2] === "pages")) ||
      (parts[0] === "novel" && parts[1] === "source.txt")
    ) {
      throw new Error("General writes cannot modify image namespaces or novel/source.txt");
    }
    await writeFile(await this.resolvePath(relPath, true), data);
  }

  async writeText(relPath: string, text: string): Promise<void> {
    await this.writeBytes(relPath, new TextEncoder().encode(text));
  }

  async writeJson(relPath: string, value: unknown): Promise<void> {
    await this.writeText(relPath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async writeNovel(data: Uint8Array, force: boolean, archiveStamp: string): Promise<void> {
    const sourcePath = await this.resolvePath("novel/source.txt", true);
    try {
      await writeFile(sourcePath, data, { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !force) throw error;
    }
    if (!archiveStamp || /[\/\\\0]/.test(archiveStamp) || archiveStamp === "." || archiveStamp === "..") {
      throw new Error("Invalid novel archive stamp");
    }
    const archivePath = await this.resolvePath(`novel/source.${archiveStamp}.txt`, true);
    await copyFile(sourcePath, archivePath, constants.COPYFILE_EXCL);
    await writeFile(sourcePath, data);
  }
}
