import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";

interface Migration {
  version: string;
  filename: string;
  checksum: string;
  sql: string;
}

interface AppliedMigration {
  version: string;
  filename: string;
  checksum: string;
}

type MigrationState = "applied" | "pending" | "partial";

const migrationDirectory = fileURLToPath(
  new URL("../../../infra/migrations/", import.meta.url),
);
const trackedTables = [
  "workspaces",
  "projects",
  "project_sources",
  "documents",
  "document_chunks",
  "incidents",
  "investigations",
  "evidence_records",
];
const migrationLockId = "731029482765013";

function getTransactionalSql(sql: string, filename: string): string {
  const match = sql.match(/^\s*BEGIN\s*;\s*([\s\S]*?)\s*COMMIT\s*;\s*$/iu);

  if (!match?.[1]) {
    throw new Error(
      `${filename} must contain one transaction bounded by BEGIN and COMMIT.`,
    );
  }

  return match[1];
}

async function loadMigrations(): Promise<Migration[]> {
  const entries = await readdir(migrationDirectory, {
    withFileTypes: true,
  });
  const filenames = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^\d{3}_[a-z0-9_-]+\.sql$/iu.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  const migrations: Migration[] = [];

  for (const filename of filenames) {
    const sql = await readFile(join(migrationDirectory, filename), "utf8");
    const version = filename.slice(0, 3);

    migrations.push({
      version,
      filename,
      checksum: createHash("sha256").update(sql).digest("hex"),
      sql: getTransactionalSql(sql, filename),
    });
  }

  return migrations;
}

async function detectMigrationState(
  client: PoolClient,
  migration: Migration,
): Promise<MigrationState> {
  if (migration.version === "001") {
    const result = await client.query<{ applied: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS applied",
    );
    return result.rows[0]?.applied ? "applied" : "pending";
  }

  if (migration.version === "002") {
    const result = await client.query<{ existing: number }>(
      `
        SELECT count(*)::integer AS existing
        FROM unnest($1::text[]) AS expected(table_name)
        WHERE to_regclass('public.' || expected.table_name) IS NOT NULL
      `,
      [trackedTables],
    );
    const existing = result.rows[0]?.existing ?? 0;

    if (existing === trackedTables.length) {
      return "applied";
    }

    return existing === 0 ? "pending" : "partial";
  }

  if (migration.version === "003" || migration.version === "004") {
    const result = await client.query<{
      embeddingType: string | null;
      hasIndex: boolean;
    }>(
      `
        SELECT
          (
            SELECT format_type(attribute.atttypid, attribute.atttypmod)
            FROM pg_attribute AS attribute
            WHERE attribute.attrelid = to_regclass('public.document_chunks')
              AND attribute.attname = 'embedding'
              AND NOT attribute.attisdropped
            LIMIT 1
          ) AS "embeddingType",
          to_regclass('public.idx_document_chunks_embedding_hnsw') IS NOT NULL
            AS "hasIndex"
      `,
    );
    const embeddingType = result.rows[0]?.embeddingType ?? null;
    const hasIndex = result.rows[0]?.hasIndex ?? false;

    if (migration.version === "003") {
      if (
        (embeddingType === "vector(1536)" ||
          embeddingType === "vector(1024)") &&
        hasIndex
      ) {
        return "applied";
      }

      return embeddingType === null && !hasIndex ? "pending" : "partial";
    }

    if (embeddingType === "vector(1024)" && hasIndex) {
      return "applied";
    }

    if (embeddingType === "vector(1536)" && hasIndex) {
      return "pending";
    }

    return embeddingType === null && !hasIndex ? "pending" : "partial";
  }

  if (migration.version === "005") {
    const result = await client.query<{ applied: boolean }>(
      "SELECT to_regclass('public.uq_documents_project_content_sha256') IS NOT NULL AS applied",
    );
    return result.rows[0]?.applied ? "applied" : "pending";
  }

  if (migration.version === "006") {
    const result = await client.query<{ applied: boolean }>(
      "SELECT to_regclass('public.uq_incidents_project_external_reference') IS NOT NULL AS applied",
    );
    return result.rows[0]?.applied ? "applied" : "pending";
  }

  return "pending";
}

function assertAppliedPrefix(
  migrations: Migration[],
  states: MigrationState[],
): void {
  let pendingSeen = false;

  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    const state = states[index]!;

    if (state === "partial") {
      throw new Error(
        `Migration ${migration.filename} has a partial schema signature; inspect the database before proceeding.`,
      );
    }

    if (state === "pending") {
      pendingSeen = true;
      continue;
    }

    if (pendingSeen) {
      throw new Error(
        `Migration ${migration.filename} appears applied after an earlier migration is pending.`,
      );
    }
  }
}

async function runMigrations(client: PoolClient): Promise<void> {
  const migrations = await loadMigrations();

  if (migrations.length === 0) {
    throw new Error(`No SQL migrations found in ${migrationDirectory}.`);
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query("SELECT pg_advisory_lock($1::bigint)", [
    migrationLockId,
  ]);

  try {
    const history = await client.query<AppliedMigration>(
      `
        SELECT version, filename, checksum
        FROM public.schema_migrations
        ORDER BY version
      `,
    );
    const migrationByVersion = new Map(
      migrations.map((migration) => [migration.version, migration]),
    );
    const historyByVersion = new Map<string, AppliedMigration>();

    for (const applied of history.rows) {
      const migration = migrationByVersion.get(applied.version);

      if (
        !migration ||
        migration.filename !== applied.filename ||
        migration.checksum !== applied.checksum
      ) {
        throw new Error(
          `Migration history does not match the repository at version ${applied.version}.`,
        );
      }

      historyByVersion.set(applied.version, applied);
    }

    const states: MigrationState[] = [];
    for (const migration of migrations) {
      states.push(await detectMigrationState(client, migration));
    }
    assertAppliedPrefix(migrations, states);

    for (let index = 0; index < migrations.length; index += 1) {
      const migration = migrations[index]!;
      const state = states[index]!;
      const recorded = historyByVersion.get(migration.version);

      if (recorded && state !== "applied") {
        throw new Error(
          `Migration ${migration.filename} is recorded as applied but its schema signature is missing.`,
        );
      }

      if (recorded || state === "applied") {
        if (!recorded) {
          await client.query(
            `
              INSERT INTO public.schema_migrations (
                version,
                filename,
                checksum
              )
              VALUES ($1, $2, $3)
            `,
            [migration.version, migration.filename, migration.checksum],
          );
          console.log(`Recorded verified legacy migration ${migration.filename}`);
        }

        continue;
      }

      await client.query("BEGIN");

      try {
        await client.query(migration.sql);

        const verifiedState = await detectMigrationState(client, migration);
        if (verifiedState !== "applied") {
          throw new Error(
            `Migration ${migration.filename} completed without creating its expected schema objects.`,
          );
        }

        await client.query(
          `
            INSERT INTO public.schema_migrations (
              version,
              filename,
              checksum
            )
            VALUES ($1, $2, $3)
          `,
          [migration.version, migration.filename, migration.checksum],
        );
        await client.query("COMMIT");
        console.log(`Applied ${migration.filename}`);
      } catch (error: unknown) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log("Database migrations are up to date.");
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [
      migrationLockId,
    ]);
  }
}

async function main(): Promise<void> {
  const database = process.env.POSTGRES_DB;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const port = Number(process.env.POSTGRES_PORT ?? "5432");

  if (
    !database ||
    !user ||
    !password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      "Database configuration is incomplete or invalid; check the required POSTGRES settings.",
    );
  }

  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port,
    database,
    user,
    password,
    max: 1,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 5000,
  });

  try {
    const client = await pool.connect();

    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    "Database migration failed:",
    error instanceof Error ? error.message : "Unknown migration error.",
  );
  process.exitCode = 1;
});
