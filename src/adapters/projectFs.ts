import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
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

  async writeReadingCopy(relPath: string, data: Uint8Array, targetKb: number): Promise<Uint8Array> {
    const original = PNG.sync.read(Buffer.from(data));
    let width = Math.min(768, original.width);
    let encoded: Uint8Array;
    for (;;) {
      const height = Math.max(1, Math.round(original.height * width / original.width));
      const image = { width, height, data: Buffer.alloc(width * height * 4) };
      for (let y = 0; y < height; y++) {
        const sy = Math.max(0, (y + 0.5) * original.height / height - 0.5);
        const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, original.height - 1), fy = sy - y0;
        for (let x = 0; x < width; x++) {
          const sx = Math.max(0, (x + 0.5) * original.width / width - 0.5);
          const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, original.width - 1), fx = sx - x0;
          for (let channel = 0; channel < 4; channel++) {
            const top = original.data[(y0 * original.width + x0) * 4 + channel] * (1 - fx) + original.data[(y0 * original.width + x1) * 4 + channel] * fx;
            const bottom = original.data[(y1 * original.width + x0) * 4 + channel] * (1 - fx) + original.data[(y1 * original.width + x1) * 4 + channel] * fx;
            image.data[(y * width + x) * 4 + channel] = Math.round(top * (1 - fy) + bottom * fy);
          }
        }
      }
      let quality = 85;
      encoded = jpeg.encode(image, quality).data;
      while (encoded.length > targetKb * 1024 && quality > 25) {
        quality -= 10;
        encoded = jpeg.encode(image, quality).data;
      }
      if (encoded.length <= targetKb * 1024 || width === 1) break;
      width = Math.max(1, Math.floor(width * Math.sqrt(targetKb * 1024 / encoded.length) * 0.95));
    }
    const bytes = new Uint8Array(encoded);
    await this.writeBytes(relPath, bytes);
    return bytes;
  }

  async exists(relPath: string): Promise<boolean> {
    const filePath = await this.resolvePath(relPath);
    try { return (await lstat(filePath)).isFile(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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
