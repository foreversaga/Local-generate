import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function parsePayload(row) {
  return row ? JSON.parse(row.payload) : null;
}

export function createSqliteJobRepository({ databasePath, namespace }) {
  const resolvedPath = path.resolve(databasePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const database = new DatabaseSync(resolvedPath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec("PRAGMA busy_timeout = 10000;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS job_records (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0,
      recoverable INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      PRIMARY KEY (namespace, id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS job_records_updated_idx
      ON job_records (namespace, updated_at DESC);
    CREATE TABLE IF NOT EXISTS persistence_migrations (
      namespace TEXT NOT NULL,
      migration_key TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (namespace, migration_key)
    ) WITHOUT ROWID;
  `);

  const upsertStatement = database.prepare(`
    INSERT INTO job_records (namespace, id, status, created_at, updated_at, terminal, recoverable, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(namespace, id) DO UPDATE SET
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      terminal = excluded.terminal,
      recoverable = excluded.recoverable,
      payload = excluded.payload
  `);
  const readStatement = database.prepare("SELECT payload FROM job_records WHERE namespace = ? AND id = ?");
  const listStatement = database.prepare("SELECT payload FROM job_records WHERE namespace = ? ORDER BY updated_at DESC, id ASC");
  const deleteStatement = database.prepare("DELETE FROM job_records WHERE namespace = ? AND id = ?");
  const migrationStatement = database.prepare("SELECT 1 AS present FROM persistence_migrations WHERE namespace = ? AND migration_key = ?");
  const markMigrationStatement = database.prepare(`
    INSERT INTO persistence_migrations (namespace, migration_key, completed_at, details)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(namespace, migration_key) DO NOTHING
  `);

  function upsert(record, { terminal = false } = {}) {
    upsertStatement.run(
      namespace,
      record.id,
      String(record.status || "queued"),
      String(record.createdAt || record.updatedAt || new Date().toISOString()),
      String(record.updatedAt || record.createdAt || new Date().toISOString()),
      terminal ? 1 : 0,
      record.recoverable ? 1 : 0,
      JSON.stringify(record),
    );
    return record;
  }

  function importOnce(migrationKey, records, { completedAt = new Date().toISOString() } = {}) {
    if (migrationStatement.get(namespace, migrationKey)) return { imported: 0, alreadyCompleted: true };
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const entry of records) upsert(entry.record, { terminal: entry.terminal });
      markMigrationStatement.run(namespace, migrationKey, completedAt, JSON.stringify({ imported: records.length }));
      database.exec("COMMIT;");
      return { imported: records.length, alreadyCompleted: false };
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  return Object.freeze({
    databasePath: resolvedPath,
    hasMigration(migrationKey) { return Boolean(migrationStatement.get(namespace, migrationKey)); },
    upsert,
    read(id) { return parsePayload(readStatement.get(namespace, id)); },
    list() { return listStatement.all(namespace).map(parsePayload); },
    remove(id) { return Number(deleteStatement.run(namespace, id).changes) > 0; },
    importOnce,
    close() { database.close(); },
  });
}
