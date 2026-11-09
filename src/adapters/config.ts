import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { configSchema, type Config } from "../../schemas/index.js";

export type ConfigObject = Record<string, unknown>;
const object = (value: unknown): value is ConfigObject => value !== null && typeof value === "object" && !Array.isArray(value);

export function mergeConfig(...layers: ConfigObject[]): ConfigObject {
  let result: ConfigObject = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error(`Unsupported configuration key: ${key}`);
      result[key] = object(value) && object(result[key]) ? mergeConfig(result[key] as ConfigObject, value) : value;
    }
  }
  return result;
}

export function configSources(layers: { name: string; value: ConfigObject }[]): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (value: ConfigObject, prefix: string, source: string) => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (object(child) && Object.keys(child).length) visit(child, path, source);
      else result[path] = source;
    }
  };
  for (const layer of layers) visit(layer.value, "", layer.name);
  return result;
}

export function parseConfigYaml(yaml: string): ConfigObject {
  const result: unknown = parse(yaml);
  if (!object(result)) throw new Error("Configuration YAML must contain a mapping");
  return result;
}

export async function readYaml(path: string): Promise<ConfigObject> {
  return parseConfigYaml(await readFile(path, "utf8"));
}

export async function initializeWorkspace(repository: string, workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true });
  await mkdir(join(workspace, "projects"), { recursive: true });
  await mkdir(join(workspace, "prompts"), { recursive: true });
  try { await copyFile(join(repository, "config.default.yaml"), join(workspace, "config.yaml"), constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  try { await writeFile(join(workspace, ".env"), "OPENAI_API_KEY=\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

export async function loadConfig(repository: string, workspace: string, projectId?: string) {
  const defaults = await readYaml(join(repository, "config.default.yaml"));
  const workspaceRaw = await readYaml(join(workspace, "config.yaml"));
  const projectRaw = projectId ? await readYaml(join(workspace, "projects", projectId, "project.yaml")) : {};
  const layers = [{ name: "repository", value: defaults }, { name: "workspace", value: workspaceRaw }, ...(projectId ? [{ name: "project", value: projectRaw }] : [])];
  const config = configSchema.parse(mergeConfig(...layers.map((layer) => layer.value)));
  const workspaceConfig = configSchema.parse(mergeConfig(defaults, workspaceRaw));
  validateConfig(config);
  validateConfig(workspaceConfig);
  return { config, workspaceConfig, projectRaw, workspaceRaw, defaults, sources: configSources(layers) };
}

export function validateConfig(config: Config): void {
  if (config.storyboard.min_panels > config.storyboard.max_panels) throw new Error("storyboard.min_panels must not exceed max_panels");
  if (config.budget.period === "week" && config.budget.cycle_start_day > 7) throw new Error("Weekly budget cycle_start_day must be 1 (Monday) through 7 (Sunday)");
  new Intl.DateTimeFormat("en", { timeZone: config.budget.timezone }).format(new Date());
  new RegExp(config.import.chapter_regex);
  for (const pattern of config.import.strip_patterns) new RegExp(pattern);
  new URL(config.openai.base_url);
}

export async function apiKey(workspace: string, config: Config): Promise<string | undefined> {
  const key = config.openai.api_key_env;
  if (process.env[key]) return process.env[key];
  let text: string;
  try { text = await readFile(join(workspace, ".env"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match?.[1] !== key) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    return value || undefined;
  }
  return undefined;
}

export { stringify as configYaml };
