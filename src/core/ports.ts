export type SqlValue = string | number | bigint | null | Uint8Array;
export interface SqlStatement { sql: string; params?: SqlValue[] }

export interface Db {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  transaction(statements: SqlStatement[]): Promise<void>;
  close(): Promise<void>;
}

export interface BlobStore {
  writeImage(relPath: string, data: Uint8Array): Promise<{ sha256: string }>;
  replaceCopy(relPath: string, data: Uint8Array): Promise<void>;
  writeReadingCopy(relPath: string, data: Uint8Array, targetKb: number): Promise<Uint8Array>;
  readBytes(relPath: string): Promise<Uint8Array | null>;
  exists(relPath: string): Promise<boolean>;
  writeJson(relPath: string, value: unknown): Promise<void>;
  readText(relPath: string): Promise<string | null>;
  writeText(relPath: string, text: string): Promise<void>;
  writeBytes(relPath: string, data: Uint8Array): Promise<void>;
  writeNovel(data: Uint8Array, force: boolean, archiveStamp: string): Promise<void>;
}

export interface ProjectFs extends BlobStore {}

export interface ImageHostUploader {
  upload(relPath: string, data: Uint8Array, signal?: AbortSignal): Promise<string>;
}

export interface ProjectDefinition {
  id: string;
  title: string;
  created_at: string;
  style_desc?: string;
}

export interface ProjectHandle { db: Db; fs: ProjectFs }

export interface ProjectListItem {
  id: string;
  title: string;
  chapter_count: number;
  completed_chapters: number;
}

export interface ProjectStore {
  create(project: ProjectDefinition): Promise<ProjectHandle>;
  open(id: string): Promise<ProjectHandle>;
  list(): Promise<ProjectListItem[]>;
}

export type TemplateSource = "repository" | "workspace" | "project";
export interface Template { name: string; content: string; source: TemplateSource }
export interface TemplateStore {
  get(name: string): Promise<Template>;
  list(): Promise<Template[]>;
  put(name: string, content: string, layer: "workspace" | "project"): Promise<void>;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  text_input_tokens?: number;
  image_input_tokens?: number;
  image_count?: number;
  input_image_count?: number;
}

export interface ImageInput { data: Uint8Array; name: string; label: string }
export interface StructuredRequest {
  model: string;
  system: string;
  user: string;
  schema: unknown;
  schema_name: string;
  images?: ImageInput[];
  signal?: AbortSignal;
}

export interface ImageRequest {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  images: ImageInput[];
  signal?: AbortSignal;
}

export type AiKind = "text" | "vision" | "image";
export interface AiProvider {
  ready(kind?: AiKind): void;
  structured(request: StructuredRequest): Promise<{ text: string; usage?: TokenUsage }>;
  image(request: ImageRequest): Promise<{ data: Uint8Array; usage?: TokenUsage }>;
}

export type LogLevel = "info" | "warning" | "error";
export type Log = (level: LogLevel, message: string, details?: unknown) => void;
