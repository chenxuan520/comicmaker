import type { Config, Character, Outfit, Location, PageStoryboard } from "../../schemas/index.js";
import type { AiProvider, Db, ImageHostUploader, Log, ProjectFs } from "./ports.js";
import type { Budget } from "./budget.js";
import type { PromptEngine } from "./prompts.js";

export type { Config, Character, Outfit, Location, PageStoryboard };

export const STRIP_LAYOUT = "strip-4";

export interface ReadingImages { target_kb: number | null; attempts: Record<string, string> }
export interface UploadedImage { attempt_id: string; sha256: string; url: string }
export interface UploadedImages { base_url: string; target_kb: number | null; pages: Record<string, UploadedImage> }

export interface Context {
  project: { id: string; title: string; style_desc: string };
  config: Config;
  db: Db;
  fs: ProjectFs;
  budget: Budget;
  prompts: PromptEngine;
  ai: AiProvider;
  imageHost?: ImageHostUploader;
  log: Log;
  signal?: AbortSignal;
}

export interface Chapter {
  id: string;
  idx: number;
  title: string;
  text: string;
  summary: string | null;
  status: "imported" | "adapted" | "storyboarded" | "rendered" | "exported";
}

export interface Ref {
  id: string;
  kind: "style" | "outfit" | "location";
  target_id: string;
  path: string | null;
  sha256: string | null;
  prompt: string;
  status: "candidate" | "locked" | "rejected";
}

export interface Page {
  id: string;
  chapter_id: string;
  page_no: number;
  storyboard: string;
  status: "planned" | "generating" | "passed" | "flagged" | "exported";
  final_attempt_id: string | null;
}

export interface Attempt {
  id: string;
  page_id: string | null;
  ref_id: string | null;
  seq: number;
  model: string;
  quality: string;
  prompt: string;
  ref_paths: string;
  status: "pending" | "ok" | "refused" | "error";
  path: string | null;
  sha256: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error: string | null;
  created_at: string;
}

export interface Bible { characters: Character[]; outfits: Outfit[]; locations: Location[] }

export function chapterId(value: number | string): string {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Chapter must be a positive integer");
  return String(number).padStart(3, "0");
}

export function pageFile(pageNo: number): string {
  return `p${String(pageNo).padStart(2, "0")}.png`;
}

export function readingFile(pageNo: number): string {
  return `p${String(pageNo).padStart(2, "0")}.jpg`;
}

export function paragraphs(text: string): string[] {
  return text.split(/\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
}
