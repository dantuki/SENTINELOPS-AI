import { randomBytes } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import {
  POSTGRES_IMAGE,
  parseDockerPort,
  redactSecrets,
} from "./inc001-isolated-lib.js";
import {
  assertPostgresContainerIdentity,
  buildPostgresContainerArgs,
  cleanupTemporaryPostgresContainer,
} from "./postgres-integration-lifecycle.js";
import {
  registerTerminationHandlers,
  TerminationController,
  type CommandResult,
} from "./inc001-runner-lifecycle.js";

const image = POSTGRES_IMAGE;
const database = `sentinelops_phase31_isolation_${Date.now()}`;
const user = "sentinelops_test";
const password = randomBytes(32).toString("base64url");
const runId = randomBytes(16).toString("hex");
const containerName = `sentinelops-postgres-integration-${runId}`;
const cidfilePath = resolve(tmpdir(), `${containerName}.cid`);
const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const migrations = ["001", "002", "003", "004", "005", "006", "007", "008"];
const termination = new TerminationController();

function throwIfTerminated(): void {
  termination.throwIfTerminated("PostgreSQL integration");
}

function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    printOutput?: boolean;
  } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() || result.error?.message || "",
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    timedOut:
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    printOutput?: boolean;
  } = {},
): string {
  throwIfTerminated();
  const result = runCommand(command, args, options);
  throwIfTerminated();
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  if (options.printOutput && result.stdout) {
    console.log(result.stdout);
  }
  return result.stdout;
}

function docker(args: string[]): string {
  return run("docker", args);
}

function runDocker(args: string[]): CommandResult {
  return runCommand("docker", args);
}

async function waitForPostgres(port: number): Promise<void> {
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    database,
    user,
    password,
    max: 1,
    connectionTimeoutMillis: 1_000,
    statement_timeout: 2_000,
    query_timeout: 2_500,
  });
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      throwIfTerminated();
      try {
        const result = await pool.query<{ name: string }>(
          "SELECT current_database() AS name",
        );
        throwIfTerminated();
        if (result.rows[0]?.name !== database) {
          throw new Error("Temporary database identity check failed.");
        }
        return;
      } catch (error: unknown) {
        if (termination.reason !== null) {
          throw error;
        }
        await delay(1_000);
      }
    }
    throw new Error("Temporary PostgreSQL did not become ready in 60 seconds.");
  } finally {
    await pool.end();
  }
}

function migrationEnvironment(port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "test",
    POSTGRES_HOST: "127.0.0.1",
    POSTGRES_PORT: String(port),
    POSTGRES_DB: database,
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: password,
  };
}

async function verifyMigrations(port: number): Promise<void> {
  const pool = new Pool({
    host: "127.0.0.1",
    port,
    database,
    user,
    password,
    max: 1,
  });
  try {
    const identity = await pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    if (identity.rows[0]?.name !== database) {
      throw new Error("Refusing to inspect a database other than the temporary test DB.");
    }
    const applied = await pool.query<{ version: string }>(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    if (
      applied.rows.map((row) => row.version).join(",") !==
      migrations.join(",")
    ) {
      throw new Error("Expected migration versions 001 through 008.");
    }
    const tables = await pool.query<{ missing: string[] }>(
      `
        SELECT array_agg(expected.name ORDER BY expected.name) AS missing
        FROM unnest($1::text[]) AS expected(name)
        WHERE to_regclass('public.' || expected.name) IS NULL
      `,
      [[
        "workspaces",
        "projects",
        "project_sources",
        "documents",
        "document_chunks",
        "incidents",
        "investigations",
        "evidence_records",
        "users",
        "sessions",
        "workspace_memberships",
        "project_memberships",
        "security_audit_events",
        "auth_login_rate_limits",
        "retrieval_events",
        "retrieval_event_items",
      ]],
    );
    if (tables.rows[0]?.missing?.length) {
      throw new Error(`Missing expected tables: ${tables.rows[0].missing.join(", ")}.`);
    }
    const indexes = await pool.query<{ count: number }>(
      `
        SELECT count(*)::integer AS count
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = ANY($1::text[])
      `,
      [[
        "idx_document_chunks_embedding_hnsw",
        "uq_documents_project_content_sha256",
        "uq_incidents_project_external_reference",
        "idx_sessions_user_active",
        "idx_project_memberships_user",
        "idx_security_audit_events_occurred",
      ]],
    );
    if (indexes.rows[0]?.count !== 6) {
      throw new Error("Expected vector, idempotency, session, membership and audit indexes.");
    }
    const constraints = await pool.query<{ count: number }>(
      `
        SELECT count(*)::integer AS count
        FROM pg_constraint
        WHERE conname = ANY($1::text[])
      `,
      [[
        "uq_projects_id_workspace",
        "project_memberships_project_id_workspace_id_fkey",
        "project_memberships_workspace_id_user_id_fkey",
        "fk_document_chunks_document_project",
        "fk_investigations_project",
        "fk_evidence_project",
      ]],
    );
    if (constraints.rows[0]?.count !== 6) {
      throw new Error("Expected composite tenant and project integrity constraints.");
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (resolve(process.cwd()) !== resolve(apiDirectory)) {
    throw new Error("Run this command from the apps/api workspace.");
  }
  const unregisterTerminationHandlers = registerTerminationHandlers(
    (signal, listener) => {
      process.on(signal, listener);
    },
    (signal, listener) => {
      process.off(signal, listener);
    },
    termination,
  );
  let operationError: unknown = null;
  let cidfile: string | null = null;
  let cleanupResult: ReturnType<typeof cleanupTemporaryPostgresContainer> | null =
    null;
  try {
    const dockerRunEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      POSTGRES_PASSWORD: password,
    };
    const started = runCommand(
      "docker",
      buildPostgresContainerArgs({
        name: containerName,
        runId,
        cidfile: cidfilePath,
        image,
        database,
        user,
      }),
      { env: dockerRunEnvironment },
    );
    throwIfTerminated();
    if (started.status !== 0 || !started.stdout) {
      throw new Error(
        `Docker could not start the temporary PostgreSQL container: ${started.stderr || started.stdout || "unknown error"}`,
      );
    }
    try {
      cidfile = (await readFile(cidfilePath, "utf8")).trim();
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    throwIfTerminated();

    const portBinding = docker(["port", containerName, "5432/tcp"]);
    const port = parseDockerPort(portBinding);
    const inspected = JSON.parse(docker(["inspect", containerName])) as unknown;
    const inspectedEntry = Array.isArray(inspected) ? inspected[0] : inspected;
    const inspectedId =
      typeof inspectedEntry === "object" &&
      inspectedEntry !== null &&
      "Id" in inspectedEntry &&
      typeof inspectedEntry.Id === "string"
        ? inspectedEntry.Id
        : null;
    const expectedId = cidfile ?? inspectedId;
    if (!expectedId) {
      throw new Error("Could not establish the temporary container identity.");
    }
    assertPostgresContainerIdentity(inspected, {
      id: expectedId,
      name: containerName,
      runId,
      image,
      port,
    });
    await waitForPostgres(port);

    const env = migrationEnvironment(port);
    const node = process.execPath;
    const migrate = () =>
      run(node, ["--experimental-transform-types", "--import=./scripts/node-ts-register.mjs", "src/migrate.ts"], {
        cwd: apiDirectory,
        env,
        printOutput: true,
      });
    migrate();
    await verifyMigrations(port);
    migrate();
    await verifyMigrations(port);

    run(
      node,
      [
        "--experimental-transform-types",
        "--import=./scripts/node-ts-register.mjs",
        "--test",
        "--test-concurrency=1",
        "--test-reporter=spec",
        "tests/project-isolation.integration.test.ts",
        "tests/security.integration.test.ts",
      ],
      { cwd: apiDirectory, env, printOutput: true },
    );
    throwIfTerminated();
    console.log("Isolated PostgreSQL migrations and integration tests passed.");
  } catch (error: unknown) {
    operationError = error;
  } finally {
    if (cidfile === null) {
      try {
        cidfile = (await readFile(cidfilePath, "utf8")).trim();
      } catch (error: unknown) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          operationError ??= error;
        }
      }
    }
    try {
      cleanupResult = cleanupTemporaryPostgresContainer({
        containerName,
        runId,
        image,
        cidfile,
        runDocker,
      });
    } catch (error: unknown) {
      const detail = redactSecrets(
        error instanceof Error ? error.message : "unknown cleanup error",
        [password],
      );
      cleanupResult = {
        success: false,
        container: "unknown",
        volume: "unknown",
        volumeName: null,
        errors: [`Temporary PostgreSQL cleanup failed: ${detail}`],
      };
    }
    try {
      await unlink(cidfilePath);
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        cleanupResult.errors.push("Could not remove the temporary container ID file.");
        cleanupResult.success = false;
      }
    }
    unregisterTerminationHandlers();
  }

  if (operationError !== null || !cleanupResult.success) {
    const errors = [
      operationError instanceof Error
        ? operationError.message
        : operationError === null
          ? null
          : "PostgreSQL integration execution failed.",
      ...cleanupResult.errors,
    ].filter((message): message is string => message !== null);
    throw new Error(errors.join("; "));
  }
  if (
    cleanupResult.container !== "removed" &&
    cleanupResult.container !== "not_created"
  ) {
    throw new Error("Temporary PostgreSQL container removal was not verified.");
  }
}

void main().catch((error: unknown) => {
  console.error(
    "PostgreSQL integration gate failed:",
    redactSecrets(
      error instanceof Error ? error.message : "Unknown error.",
      [password],
    ),
  );
  process.exitCode =
    termination.reason === "SIGINT"
      ? 130
      : termination.reason === "SIGTERM"
        ? 143
        : 1;
});
