import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceRuntime } from "../src/adapters/runtime.js";
import { decodeBase64 } from "../src/core/ai.js";
import type { AiProvider, ImageRequest, StructuredRequest } from "../src/core/ports.js";
import type { Extraction, Adaptation, PageStoryboard, VisualReview } from "../schemas/index.js";

export const repository = fileURLToPath(new URL("../", import.meta.url));
export const png = decodeBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4AWP4DwQACfsD/c8LaHIAAAAASUVORK5CYII=");
export const novel = "第一章 青岚峰\n\n林青推开柴门，看见师父站在崖边。\n\n师父说：你来了。\n\n林青答：弟子来了。";
export const extraction: Extraction = {
  characters: [{
    id: "lin_qing", name: "林青", aliases: [], role: "主角", gender: "男", age_look: "17岁", height_build: "清瘦", face: null,
    hair: "束发", hair_color: "墨黑 #1A1A1A", eye_color: "深褐 #4A3222", skin: "小麦色 #C99A6B", marks: null,
    outfits: [{ id: "lin_qing.daily", name: "日常短打", desc: "粗布短打", main_color: "青灰 #5B6B73", accent_color: null, chapters: [1] }], evidence: ["1:1"],
  }],
  locations: [{ id: "qinglan_peak", name: "青岚峰", desc: "晨雾中的山峰", palette: "青绿", chapters: [1] }],
};
export const adaptation: Adaptation = {
  suggested_pages: 1,
  scenes: [{ id: "s1", location_id: "qinglan_peak", time: "清晨", characters: [{ id: "lin_qing", outfit: "lin_qing.daily" }], beats: [
    { id: "b1", src_paras: [1], importance: 3, action: "林青推开柴门", dialogue: [] },
    { id: "b2", src_paras: [2], importance: 2, action: "林青看见师父", dialogue: [{ speaker: "lin_qing", type: "thought", text: "你来了。" }] },
    { id: "b3", src_paras: [3], importance: 2, action: "林青回应", dialogue: [{ speaker: "lin_qing", type: "speech", text: "弟子来了。" }] },
  ] }],
};
export const storyboard: PageStoryboard = {
  page_no: 1, layout: "1 wide | 2",
  panels: adaptation.scenes[0].beats.map((beat, index) => ({
    id: `p${index + 1}`, row: index === 0 ? 1 : 2, size: index === 0 ? "wide" : "medium", shot: "中景", angle: "平视", location_id: "qinglan_peak", time: "清晨",
    characters: [{ id: "lin_qing", outfit: "lin_qing.daily", pose: "站立", expression: "平静", position: "左" }], action: beat.action, dialogue: beat.dialogue, beat_ids: [beat.id],
  })),
};
export const visual: VisualReview = {
  panel_count: 3, characters: storyboard.panels.map((_, index) => ({ panel: index + 1, char_id: "lin_qing", identity_match: 0.95, color_match: 0.95, issue: null })),
  content: [], artifacts: [], fix_instructions: "",
};

export function mockOutput(request: StructuredRequest): unknown {
  switch (request.schema_name) {
    case "extract": case "merge": return structuredClone(extraction);
    case "summary": return { chapters: [{ chapter: 1, summary: "林青在青岚峰与师父相见。" }] };
    case "adapt": return structuredClone(adaptation);
    case "storyboard": return { pages: [structuredClone(storyboard)] };
    case "storyboard_review": return { pass: true, issues: [] };
    case "review_text": return { panels: storyboard.panels.map((panel, index) => ({ panel: index + 1, texts: panel.dialogue.map((line) => line.text) })) };
    case "review_visual": return structuredClone(visual);
    case "rewrite": return { panels: storyboard.panels.map((panel) => ({ id: panel.id, action: `${panel.action}，无血腥细节`, characters: panel.characters.map((character) => ({ id: character.id, pose: "自然站立" })) })) };
    default: throw new Error(`Unexpected mock schema ${request.schema_name}`);
  }
}

export class MockAi implements AiProvider {
  structuredCalls: StructuredRequest[] = [];
  imageCalls: ImageRequest[] = [];
  onStructured?: (request: StructuredRequest) => unknown | Promise<unknown>;
  onImage?: (request: ImageRequest) => void | Promise<void>;
  ready() {}
  async structured(request: StructuredRequest) {
    this.structuredCalls.push(request);
    const output = this.onStructured ? await this.onStructured(request) : mockOutput(request);
    return { text: typeof output === "string" ? output : JSON.stringify(output), usage: { input_tokens: 100, output_tokens: 50 } };
  }
  async image(request: ImageRequest) {
    this.imageCalls.push(request);
    await this.onImage?.(request);
    return { data: png, usage: { input_tokens: 120, output_tokens: 20, text_input_tokens: 80, image_input_tokens: 40 } };
  }
}

export async function fixture(provider?: AiProvider) {
  const root = await mkdtemp(join(process.env.COMIC_TEST_TEMP ?? tmpdir(), "comic-test-"));
  const workspace = await WorkspaceRuntime.create({ repository, workspace: root, provider });
  return { root, workspace, close: async () => { await workspace.close(); await rm(root, { recursive: true, force: true }); } };
}
