import Handlebars from "handlebars";
import type { TemplateSource, TemplateStore } from "./ports.js";

export interface RenderedPrompt { text: string; sources: Record<string, TemplateSource> }

export class PromptEngine {
  private readonly engine = Handlebars.create();
  private ready?: Promise<void>;
  private partialSources: Record<string, TemplateSource> = {};

  constructor(private readonly store: TemplateStore, private readonly globals: Record<string, unknown>) {
    this.engine.registerHelper("json", (value: unknown) => JSON.stringify(value, null, 2));
    this.engine.registerHelper("eq", (left: unknown, right: unknown) => left === right);
    this.engine.registerHelper("numbered", (value: string[]) => value.map((paragraph, index) => `[${index + 1}] ${paragraph}`).join("\n"));
    this.engine.registerHelper("join", (value: unknown[], separator: string) => value.join(separator));
  }

  private initialize(): Promise<void> {
    return this.ready ??= this.store.list().then((templates) => {
      for (const template of templates.filter((value) => value.name.startsWith("partials/"))) {
        const name = template.name.slice("partials/".length).replace(/\.md$/, "");
        this.engine.registerPartial(name, this.engine.compile(template.content, { strict: true, noEscape: true }));
        this.partialSources[template.name] = template.source;
      }
    });
  }

  async render(name: string, data: Record<string, unknown> = {}): Promise<RenderedPrompt> {
    await this.initialize();
    const template = await this.store.get(name.endsWith(".md") ? name : `${name}.md`);
    const text = this.engine.compile(template.content, { strict: true, noEscape: true })({ ...this.globals, ...data }).trim();
    const sources: Record<string, TemplateSource> = { [template.name]: template.source };
    if (/{{>/.test(template.content)) Object.assign(sources, this.partialSources);
    return { text, sources };
  }

  async pair(step: string, data: Record<string, unknown> = {}): Promise<{ system: string; user: string; sources: Record<string, TemplateSource> }> {
    const [system, user] = await Promise.all([this.render(`${step}/system.md`, data), this.render(`${step}/user.md`, data)]);
    return { system: system.text, user: user.text, sources: { ...system.sources, ...user.sources } };
  }
}
