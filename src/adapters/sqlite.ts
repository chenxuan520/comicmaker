import { DatabaseSync } from "node:sqlite";
import type { Db, SqlStatement, SqlValue } from "../core/ports.js";

const projectMigrations = [
  `CREATE TABLE chapters (
    id TEXT PRIMARY KEY, idx INTEGER, title TEXT, text TEXT, summary TEXT, status TEXT
  );
  CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT, aliases TEXT, spec TEXT);
  CREATE TABLE outfits (id TEXT PRIMARY KEY, character_id TEXT, name TEXT, spec TEXT, chapters TEXT);
  CREATE TABLE locations (id TEXT PRIMARY KEY, name TEXT, spec TEXT);
  CREATE TABLE refs (
    id TEXT PRIMARY KEY, kind TEXT, target_id TEXT, path TEXT, sha256 TEXT, prompt TEXT, status TEXT
  );
  CREATE TABLE adaptations (chapter_id TEXT PRIMARY KEY, scenes TEXT, version INTEGER);
  CREATE TABLE pages (
    id TEXT PRIMARY KEY, chapter_id TEXT, page_no INTEGER, storyboard TEXT, status TEXT,
    final_attempt_id TEXT
  );
  CREATE TABLE attempts (
    id TEXT PRIMARY KEY, page_id TEXT, ref_id TEXT, seq INTEGER, model TEXT, quality TEXT,
    prompt TEXT, ref_paths TEXT, status TEXT, path TEXT, sha256 TEXT, input_tokens INTEGER,
    output_tokens INTEGER, cost_usd REAL, error TEXT, created_at TEXT
  );
  CREATE TABLE reviews (
    id TEXT PRIMARY KEY, attempt_id TEXT, text_check TEXT, visual_check TEXT,
    score REAL, passed INTEGER, fix_instructions TEXT
  );`,
  `ALTER TABLE attempts ADD COLUMN template_sources TEXT;
  CREATE TABLE llm_calls (
    id TEXT PRIMARY KEY, step TEXT, model TEXT, prompt TEXT, template_sources TEXT,
    status TEXT, output TEXT, error TEXT, created_at TEXT
  );
  CREATE UNIQUE INDEX refs_one_locked_per_target
    ON refs(kind, target_id) WHERE status = 'locked';`,
];

const ledgerMigrations = [
  `CREATE TABLE spend (
    id TEXT PRIMARY KEY, project_id TEXT, step TEXT, model TEXT, input_tokens INTEGER,
    output_tokens INTEGER, cost_usd REAL, estimated INTEGER, ref TEXT, created_at TEXT
  );`,
];

export class SqliteDb implements Db {
  private readonly database: DatabaseSync;

  constructor(filePath: string, kind: "project" | "ledger" = "project") {
    this.database = new DatabaseSync(filePath);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
        const stored = this.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        const version = stored ? Number(stored.value) : 0;
        const migrations = kind === "project" ? projectMigrations : ledgerMigrations;
        if (!Number.isSafeInteger(version) || version < 0) {
          throw new Error(`Invalid ${kind} schema_version: ${stored?.value}`);
        }
        if (version > migrations.length) {
          throw new Error(`Unsupported ${kind} schema_version ${version}; supported version is ${migrations.length}`);
        }
        for (let index = version; index < migrations.length; index += 1) {
          this.database.exec(migrations[index]);
          this.database.prepare(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          ).run(String(index + 1));
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return this.database.prepare(sql).get(...params) as T | undefined;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const result = this.database.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  async transaction(statements: SqlStatement[]): Promise<void> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        this.database.prepare(statement.sql).run(...(statement.params ?? []));
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.database.close();
  }
}

export async function openProjectDb(filePath: string): Promise<SqliteDb> {
  return new SqliteDb(filePath, "project");
}

export async function openLedgerDb(filePath: string): Promise<SqliteDb> {
  return new SqliteDb(filePath, "ledger");
}
