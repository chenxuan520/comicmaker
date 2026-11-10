import type { ChapterSchedule } from '../../schemas/index.js';

export type { ChapterSchedule, ScheduleInput } from '../../schemas/index.js';

export type View = 'studio' | 'projects' | 'refs' | 'chapters' | 'budget' | 'config' | 'prompts';
export type RefKind = 'style' | 'outfit' | 'location';
export type ComicFormat = 'page' | 'strip';

export interface ApiProblem {
  message: string;
  code?: string | number;
  details?: unknown;
}

export interface ProjectSummary {
  id: string;
  title: string;
  chapter_count: number;
  completed_chapters: number;
  updated_at?: string;
}

export interface Job {
  id: string;
  project_id: string;
  action: string;
  source?: 'schedule';
  chapter?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  started_at: string;
  finished_at?: string;
  result?: unknown;
  error?: ApiProblem;
  events: { time: string; level: string; message: string; details?: unknown }[];
}

export interface Workspace {
  projects: ProjectSummary[];
  current_project: string | null;
  api_key_configured: boolean;
  api_keys?: { text: boolean; vision: boolean; image: boolean };
  review_required?: boolean;
  workspace_path: string;
  settings?: { poll_interval_ms?: number };
  job: Job | null;
}

export interface Chapter {
  id: string;
  idx: number;
  title: string;
  summary: string;
  status: string;
  page_count: number;
  flagged_count: number;
}

export interface ReviewRecord {
  id: string;
  attempt_id: string;
  score: number;
  passed: number;
  text_check: string;
  visual_check: string;
  fix_instructions: string;
}

export interface ComicPage {
  id: string;
  chapter_id: string;
  page_no: number;
  format: ComicFormat;
  status: string;
  final_attempt_id: string | null;
  image_url: string | null;
  original_image_url: string | null;
  storyboard: unknown;
  reviews?: ReviewRecord[];
}

export interface Reference {
  id: string;
  kind: RefKind;
  target_id: string;
  path: string;
  status: string;
  image_url: string | null;
}

export interface Entity {
  id: string;
  name?: string;
  character_id?: string;
  [key: string]: unknown;
}

export interface ProjectDetail {
  project: { id: string; title: string; style_desc: string };
  comic_format: ComicFormat;
  schedule?: ChapterSchedule | null;
  api_keys?: { text: boolean; vision: boolean; image: boolean };
  review_required?: boolean;
  chapters: Chapter[];
  pages: ComicPage[];
  refs: Reference[];
  characters: Entity[];
  outfits: Entity[];
  locations: Entity[];
  warnings: string[];
  export_options: { pdf: boolean; html: boolean };
}

export interface Budget {
  spent_usd: number;
  limit_usd: number | null;
  remaining_usd: number | null;
  period: string;
  reset_at: string | null;
  by_project: { project_id: string; cost_usd: number }[];
  by_step: { step: string; cost_usd: number }[];
  warnings?: string[];
}

export interface ActionInput {
  action: 'prepare' | 'refs' | 'lock' | 'adapt' | 'render' | 'run' | 'export' | 'redo';
  chapter?: number;
  kind?: RefKind;
  target?: string;
  ref_id?: string;
  page_id?: string;
  note?: string;
  force?: boolean;
  ignore_limit?: boolean;
}

export interface ActionProps {
  busy: boolean;
  canGenerate: (action: ActionInput['action']) => boolean;
  onAction: (input: ActionInput) => void;
}

export interface ConfigDocument {
  yaml: string;
  merged: unknown;
  sources: Record<string, string>;
  validation_error?: ApiProblem;
}

export interface PromptTemplate {
  name: string;
  source: 'repository' | 'workspace' | 'project';
  content: string;
}
