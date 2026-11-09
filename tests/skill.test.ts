import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

test("operator skill metadata, safety rules and three evaluation cases are valid", async () => {
  const text = await readFile(new URL("../skills/comic/SKILL.md", import.meta.url), "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatter);
  const metadata = parse(frontmatter[1]);
  assert.equal(metadata.name, "comic");
  assert.equal(typeof metadata.description, "string");
  assert.ok(metadata.description.length > 0 && metadata.description.length <= 1024);
  assert.ok(text.split("\n").length < 500);
  assert.match(text, /pnpm --silent comic/);
  assert.match(text, /budget/);
  assert.match(text, /--ignore-limit/);
  assert.match(text, /project\.db/);
  const evaluations = JSON.parse(await readFile(new URL("../skills/comic/evals/evals.json", import.meta.url), "utf8"));
  assert.equal(evaluations.skill_name, "comic");
  assert.equal(evaluations.evals.length, 3);
  assert.equal(new Set(evaluations.evals.map((entry: { id: number }) => entry.id)).size, 3);
  for (const entry of evaluations.evals) {
    assert.equal(typeof entry.prompt, "string");
    assert.equal(typeof entry.expected_output, "string");
    assert.ok(Array.isArray(entry.files));
  }
});
