import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

async function sourceFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) result.push(path);
  }
  return result;
}

test("core stays portable: no Node imports, adapters, CLI, process or Buffer", async () => {
  const root = fileURLToPath(new URL("../src/core/", import.meta.url));
  for (const path of await sourceFiles(root)) {
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
    const inspect = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = node.moduleSpecifier.text;
        assert.ok(!module.startsWith("node:") && !/\/(adapters|cli)\//.test(module), `${path}: forbidden import ${module}`);
      }
      if (ts.isIdentifier(node)) assert.ok(node.text !== "Buffer" && node.text !== "process", `${path}: forbidden Node global ${node.text}`);
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
});
