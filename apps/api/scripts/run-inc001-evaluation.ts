import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { AuthRepository } from "../src/auth-repository.js";
import { ProductRepository } from "../src/product-repository.js";
import { parseInc001GroundTruth } from "../src/inc001-evaluation.js";
import { ManagedProcess } from "./managed-process.js";
import {
  EXPECTED_MIGRATIONS,
  OLLAMA_BASE_URL,
  POSTGRES_IMAGE,
  REQUIRED_OLLAMA_MODELS,
  assertContainerIdentity,
  assertTemporaryDatabaseName,
  assertTemporaryPort,
  buildApiEnvironment,
  buildEvaluatorEnvironment,
  buildMigrationEnvironment,
  buildOrchestratorEnvironment,
  createContainerName,
  createRunId,
  createTemporaryDatabaseName,
  finalizeEvaluationOutput,
  getAnonymousPostgresVolumeName,
  missingOllamaModels,
  parseEvaluationTraceExpectation,
  parseDockerPort,
  redactSecrets,
  resolveEvaluationResult,
  summarizeEvaluationOutput,
  systemEnvironment,
  RUNNER_LABEL,
  RUNNER_LABEL_VALUE,
  RUN_ID_LABEL,
  type ServiceEndpoints,
  type TemporaryDatabase,
} from "./inc001-isolated-lib.js";
import {
  classifyContainerCleanup,
  classifyDockerInspect,
  classifyVolumeCleanup,
  cleanupIsVerified,
  parseEvaluationFailureStage,
  registerTerminationHandlers,
  resolveContainerCandidate,
  TerminationController,
  type CleanupResourceState,
  type DockerResourceState,
  type ProcessStopState,
} from "./inc001-runner-lifecycle.js";
import {
  RetrievalTraceVerifier,
  type TraceVerificationReport,
} from "../src/retrieval-trace-verifier.js";

const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(apiDirectory, "..", "..");
const orchestratorDirectory = join(
  repositoryRoot,
  "services",
  "ai-orchestrator",
);
const pythonExecutable = join(
  orchestratorDirectory,
  ".venv",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const reportsDirectory = join(repositoryRoot, "reports", "inc001-isolated");
const EVALUATION_TIMEOUT_MS = 12 * 60_000;
const PREFLIGHT_ONLY = process.argv.slice(2).includes("--preflight-only");

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface OllamaFacts {
  version: string | null;
  models: Array<{ name: string; digest: string | null; size: number | null }>;
}

interface CleanupReport {
  success: boolean;
  processes: Record<string, ProcessStopState | "not_started">;
  container: {
    state: CleanupResourceState;
    verified: boolean;
  };
  volume: {
    state: CleanupResourceState;
    verified: boolean;
    name: string | null;
  };
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendError(existing: string | null, next: string): string {
  return [existing, next].filter((value): value is string => value !== null).join("; ");
}

function runSync(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  errorCode?: string;
  timedOut?: boolean;
} {
  const result = spawnSync(command, args, {
    cwd: apiDirectory,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    return {
      status: null,
      stdout: "",
      stderr: error.message,
      errorCode: error.code,
      timedOut: error.code === "ETIMEDOUT",
    };
  }
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function docker(args: string[], env?: NodeJS.ProcessEnv): string {
  const result = runSync("docker", args, env);
  if (result.status !== 0) {
    throw new Error(
      `docker ${args[0] ?? ""} failed: ${(result.stderr || result.stdout).split(/\r?\n/u)[0] ?? "unknown error"}`,
    );
  }
  return result.stdout;
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => {
        if (port === 0) {
          reject(new Error("Could not select a free loopback port."));
        } else {
          resolvePort(port);
        }
      });
    });
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function readOllamaFacts(): Promise<{
  tags: unknown;
  facts: OllamaFacts;
}> {
  const tags = await fetchJson(`${OLLAMA_BASE_URL}/api/tags`);
  let version: string | null = null;
  try {
    const payload = await fetchJson(`${OLLAMA_BASE_URL}/api/version`);
    if (isRecord(payload) && typeof payload.version === "string") {
      version = payload.version;
    }
  } catch {
    version = null;
  }
  const models: OllamaFacts["models"] = [];
  if (isRecord(tags) && Array.isArray(tags.models)) {
    for (const model of tags.models) {
      if (
        isRecord(model) &&
        typeof model.name === "string" &&
        (REQUIRED_OLLAMA_MODELS as readonly string[]).includes(model.name)
      ) {
        models.push({
          name: model.name,
          digest: typeof model.digest === "string" ? model.digest : null,
          size: typeof model.size === "number" ? model.size : null,
        });
      }
    }
  }
  return { tags, facts: { version, models } };
}

// Performs only read-only checks: no containers, databases, services or inference.
async function preflight(): Promise<{
  checks: Check[];
  ollama: OllamaFacts | null;
  pythonVersion: string | null;
}> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) =>
    checks.push({ name, ok, detail });

  const daemon = runSync("docker", ["version", "--format", "{{.Server.Version}}"]);
  add(
    "Docker daemon",
    daemon.status === 0 && daemon.stdout.length > 0,
    daemon.status === 0 ? `server ${daemon.stdout}` : "daemon not reachable",
  );

  const image = runSync("docker", ["image", "inspect", "--format", "{{.Id}}", POSTGRES_IMAGE]);
  add(
    "PostgreSQL image present locally",
    image.status === 0,
    image.status === 0 ? POSTGRES_IMAGE : `${POSTGRES_IMAGE} not found locally`,
  );

  let ollama: OllamaFacts | null = null;
  try {
    const { tags, facts } = await readOllamaFacts();
    ollama = facts;
    add("Ollama reachable", true, `${OLLAMA_BASE_URL} (version ${facts.version ?? "unknown"})`);
    const missing = missingOllamaModels(tags);
    add(
      "Required Ollama models present in /api/tags",
      missing.length === 0,
      missing.length === 0
        ? REQUIRED_OLLAMA_MODELS.join(", ")
        : `missing: ${missing.join(", ")}`,
    );
  } catch (error: unknown) {
    add(
      "Ollama reachable",
      false,
      `${OLLAMA_BASE_URL}/api/tags failed (${error instanceof Error ? error.name : "error"})`,
    );
  }

  let pythonVersion: string | null = null;
  if (!existsSync(pythonExecutable)) {
    add("Orchestrator virtual environment", false, "services/ai-orchestrator/.venv not found");
  } else {
    const version = runSync(pythonExecutable, ["--version"], systemEnvironment());
    pythonVersion = version.status === 0 ? version.stdout || version.stderr : null;
    const imports = runSync(
      pythonExecutable,
      [
        "-c",
        "import uvicorn, fastapi, httpx, sentinelops_ai_orchestrator.app",
      ],
      {
        ...systemEnvironment(),
        PYTHONPATH: join(orchestratorDirectory, "src"),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    );
    add(
      "Orchestrator virtual environment",
      version.status === 0 && imports.status === 0,
      imports.status === 0
        ? `${pythonVersion}; uvicorn, fastapi, httpx and the orchestrator app import`
        : "dependencies of the orchestrator do not import",
    );
  }

  try {
    const ports = [await findFreePort(), await findFreePort(), await findFreePort()];
    ports.forEach(assertTemporaryPort);
    add("Loopback ports selectable", true, "3 free ports obtained on 127.0.0.1");
  } catch (error: unknown) {
    add(
      "Loopback ports selectable",
      false,
      error instanceof Error ? error.message : "unknown error",
    );
  }

  add(
    "Configuration generable",
    true,
    "database name, credentials and service key are generated per run",
  );
  add(
    "Habitual .env isolated",
    true,
    "child processes receive an allowlisted system environment plus explicit variables; no --env-file",
  );
  return { checks, ollama, pythonVersion };
}

async function waitForHttp(
  label: string,
  url: URL,
  process_: ManagedProcess,
  timeoutMs: number,
  throwIfTerminated: () => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    throwIfTerminated();
    if (process_.exitCode !== undefined) {
      throw new Error(
        `${label} exited before becoming available (exit code ${process_.exitCode}).`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        return;
      }
      last = `HTTP ${response.status}`;
    } catch (error: unknown) {
      last = error instanceof Error ? error.name : "error";
    }
    await delay(500);
  }
  throw new Error(
    `${label} did not answer ${url.pathname} on ${url.origin} within ${timeoutMs / 1000}s (last: ${last}).`,
  );
}

function makePool(database: TemporaryDatabase): Pool {
  return new Pool({
    host: "127.0.0.1",
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    max: 2,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 5_000,
    query_timeout: 6_000,
  });
}

async function assertDatabaseIdentity(
  pool: Pool,
  database: TemporaryDatabase,
): Promise<void> {
  assertTemporaryDatabaseName(database.database);
  const identity = await pool.query<{ name: string; role: string }>(
    "SELECT current_database() AS name, current_user AS role",
  );
  if (
    identity.rows[0]?.name !== database.database ||
    identity.rows[0]?.role !== database.user
  ) {
    throw new Error(
      "Refusing to continue: the connected database is not the temporary evaluation database.",
    );
  }
}

async function waitForPostgres(
  database: TemporaryDatabase,
  throwIfTerminated: () => void,
  isTerminated: () => boolean,
): Promise<void> {
  const pool = makePool(database);
  try {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      throwIfTerminated();
      try {
        await assertDatabaseIdentity(pool, database);
        throwIfTerminated();
        return;
      } catch (error: unknown) {
        if (isTerminated()) {
          throw error;
        }
        if (
          error instanceof Error &&
          error.message.startsWith("Refusing to continue")
        ) {
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

async function verifyMigrations(database: TemporaryDatabase): Promise<void> {
  const pool = makePool(database);
  try {
    await assertDatabaseIdentity(pool, database);
    const applied = await pool.query<{ version: string }>(
      "SELECT version FROM public.schema_migrations ORDER BY version",
    );
    if (
      applied.rows.map((row) => row.version).join(",") !==
      EXPECTED_MIGRATIONS.join(",")
    ) {
      throw new Error(
        `Expected migration versions ${EXPECTED_MIGRATIONS.join(", ")}.`,
      );
    }
    const extension = await pool.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
    );
    if (!extension.rowCount) {
      throw new Error("The vector extension is not installed.");
    }
    const embedding = await pool.query<{ type: string }>(
      `
        SELECT format_type(atttypid, atttypmod) AS type
        FROM pg_attribute
        WHERE attrelid = 'public.document_chunks'::regclass
          AND attname = 'embedding'
          AND NOT attisdropped
      `,
    );
    if (embedding.rows[0]?.type !== "vector(1024)") {
      throw new Error(
        "document_chunks.embedding must be vector(1024) to match the embedding contract.",
      );
    }
    const tables = await pool.query<{ missing: string[] | null }>(
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
      throw new Error(
        `Missing expected tables: ${tables.rows[0].missing.join(", ")}.`,
      );
    }
  } finally {
    await pool.end();
  }
}

interface SeededEvaluation {
  projectId: string;
  evaluatorEmail: string;
  evaluatorPassword: string;
}

async function seedEvaluation(
  database: TemporaryDatabase,
  secrets: string[],
): Promise<SeededEvaluation> {
  const pool = makePool(database);
  try {
    await assertDatabaseIdentity(pool, database);
    const auth = new AuthRepository(pool);
    const products = new ProductRepository(pool);
    const suffix = randomBytes(6).toString("hex");
    const adminPassword = randomBytes(24).toString("base64url");
    const evaluatorPassword = randomBytes(24).toString("base64url");
    secrets.push(adminPassword, evaluatorPassword);

    const admin = await auth.createInitialAdmin(
      `inc001-admin-${suffix}@example.test`,
      adminPassword,
      {},
    );
    const evaluatorEmail = `inc001-evaluator-${suffix}@example.test`;
    const evaluator = await auth.createUser(
      evaluatorEmail,
      evaluatorPassword,
      admin.id,
      {},
    );
    // createWorkspace and createProject grant WORKSPACE_OWNER and PROJECT_ADMIN
    // to the supplied user; both roles are verified below instead of assumed.
    const workspace = await products.createWorkspace(
      { slug: `inc001-eval-${suffix}`, name: `INC-001 evaluation ${suffix}` },
      evaluator.id,
    );
    const project = await products.createProject(
      workspace.id,
      { slug: `pedidos-api-${suffix}`, name: "Pedidos API (INC-001 evaluation)" },
      evaluator.id,
    );
    if (!project) {
      throw new Error("The evaluation project was not created.");
    }

    const memberships = await pool.query<{ scope: string; role: string }>(
      `
        SELECT 'workspace' AS scope, role
        FROM workspace_memberships
        WHERE workspace_id = $1::uuid AND user_id = $2::uuid
        UNION ALL
        SELECT 'project' AS scope, role
        FROM project_memberships
        WHERE project_id = $3::uuid AND user_id = $2::uuid
      `,
      [workspace.id, evaluator.id, project.id],
    );
    const roles = new Map(memberships.rows.map((row) => [row.scope, row.role]));
    if (
      roles.get("workspace") !== "WORKSPACE_OWNER" ||
      roles.get("project") !== "PROJECT_ADMIN"
    ) {
      throw new Error("The evaluator memberships are not the expected roles.");
    }
    for (const permission of ["project.manage", "project.investigate"]) {
      if (
        !(await auth.authorize(evaluator.id, permission, {
          projectId: project.id,
        }))
      ) {
        throw new Error(
          `The evaluator is not authorized for ${permission} on the evaluation project.`,
        );
      }
    }
    return { projectId: project.id, evaluatorEmail, evaluatorPassword };
  } finally {
    await pool.end();
  }
}

function runNodeSync(
  args: string[],
  env: NodeJS.ProcessEnv,
  secrets: string[],
): string {
  const result = spawnSync(process.execPath, args, {
    cwd: apiDirectory,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `node ${args[1] ?? ""} failed: ${redactSecrets((result.stderr || result.stdout || String(result.error)).trim(), secrets)}`,
    );
  }
  return result.stdout.trim();
}

function printPreflight(checks: Check[]): void {
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}`);
  }
}

async function main(): Promise<number> {
  if (resolve(process.cwd()) !== resolve(apiDirectory)) {
    throw new Error("Run this command from the apps/api workspace.");
  }

  const groundTruthPath = fileURLToPath(
    new URL(
      "../../../datasets/demo-pedidos-api/ground-truth/INC-001.expected.json",
      import.meta.url,
    ),
  );
  const groundTruth = parseInc001GroundTruth(
    JSON.parse(await readFile(groundTruthPath, "utf8")) as unknown,
  );
  if (groundTruth.dataset !== "sentinelops-synthetic-demo-v1") {
    throw new Error("INC-001 evaluation reference uses an unexpected dataset.");
  }

  const pre = await preflight();
  printPreflight(pre.checks);
  const preflightOk = pre.checks.every((check) => check.ok);
  if (PREFLIGHT_ONLY) {
    console.log(
      preflightOk
        ? "Preflight passed. No container, database, service or inference was started."
        : "Preflight failed.",
    );
    return preflightOk ? 0 : 1;
  }
  if (!preflightOk) {
    throw new Error("Preflight failed; nothing was started.");
  }

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  const resultDirectory = join(reportsDirectory, stamp);
  await mkdir(resultDirectory, { recursive: true });

  const database: TemporaryDatabase = {
    port: 0,
    database: createTemporaryDatabaseName(),
    user: "sentinelops_eval",
    password: randomBytes(32).toString("base64url"),
  };
  assertTemporaryDatabaseName(database.database);
  const serviceKey = randomBytes(32).toString("base64url");
  const secrets: string[] = [database.password, serviceKey];
  const runId = createRunId();
  const traceRunId = randomUUID();
  const containerName = createContainerName(runId);
  const cidfilePath = join(resultDirectory, "container.cid");

  let containerId: string | null = null;
  let containerVerified = false;
  let volumeName: string | null = null;
  let currentPhase = "infrastructure_startup";
  let api: ManagedProcess | null = null;
  let orchestrator: ManagedProcess | null = null;
  let evaluator: ManagedProcess | null = null;
  let evaluatorExitCode: number | null = null;
  let evaluationExitCode: number | null = null;
  let finalizedEvaluationOutput: string | null = null;
  let runnerError: string | null = null;
  let failureStage: string | null = null;
  const termination = new TerminationController();
  let endpoints: ServiceEndpoints | null = null;
  let cleanupPromise: Promise<CleanupReport> | null = null;
  const cleanupReport: CleanupReport = {
    success: false,
    processes: {
      evaluator: "not_started",
      api: "not_started",
      orchestrator: "not_started",
    },
    container: { state: "unknown", verified: false },
    volume: { state: "unknown", verified: false, name: null },
    errors: [],
  };

  const inspectOwnedContainer = async (id: string): Promise<void> => {
    const inspection = runSync("docker", ["inspect", id]);
    const inspectState = classifyDockerInspect(inspection);
    if (inspectState !== "PRESENT") {
      throw new Error(
        `Container ownership could not be verified (${inspectState}).`,
      );
    }
    const inspected: unknown = JSON.parse(inspection.stdout);
    const entry = Array.isArray(inspected) ? inspected[0] : inspected;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("Name" in entry) ||
      entry.Name !== `/${containerName}`
    ) {
      throw new Error("The discovered container name does not match this run.");
    }
    database.port = parseDockerPort(
      docker(["port", containerName, "5432/tcp"]),
    );
    assertContainerIdentity(inspected, {
      id,
      name: containerName,
      runId,
      image: POSTGRES_IMAGE,
      port: database.port,
    });
    volumeName = getAnonymousPostgresVolumeName(inspected);
    containerId = id;
    containerVerified = true;
  };

  const resolveOwnedContainer = async (): Promise<boolean> => {
    let cidfile: string | null = null;
    try {
      cidfile = (await readFile(cidfilePath, "utf8")).trim();
    } catch (error: unknown) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    const candidates = cidfile
      ? { status: 0, stdout: "", stderr: "" }
      : runSync("docker", [
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=${RUNNER_LABEL}=${RUNNER_LABEL_VALUE}`,
          "--filter",
          `label=${RUN_ID_LABEL}=${runId}`,
        ]);
    const resolution = resolveContainerCandidate(cidfile, candidates);
    if (resolution.state === "unknown") {
      const state = classifyDockerInspect(candidates);
      throw new Error(
        `Docker creation outcome is unknown (${state}); no resource will be removed without ownership proof.`,
      );
    }
    if (resolution.state === "absent") {
      cleanupReport.container = { state: "not_created", verified: true };
      return false;
    }
    await inspectOwnedContainer(resolution.id);
    return true;
  };

  const cleanup = (): Promise<CleanupReport> => {
    if (cleanupPromise) {
      return cleanupPromise;
    }
    cleanupPromise = (async () => {
      for (const [name, child] of [
        ["evaluator", evaluator],
        ["api", api],
        ["orchestrator", orchestrator],
      ] as const) {
        if (!child) {
          continue;
        }
        try {
          const state = await child.stop();
          cleanupReport.processes[name] = state;
          if (state !== "stopped") {
            cleanupReport.errors.push(`${name} process tree is ${state}.`);
          }
        } catch (error: unknown) {
          cleanupReport.processes[name] = "failed";
          const detail = redactSecrets(
            error instanceof Error ? error.message : "unknown process stop error",
            secrets,
          );
          cleanupReport.errors.push(`${name} process tree stop failed: ${detail}`);
        }
      }

      if (!containerVerified && cleanupReport.container.state !== "not_created") {
        try {
          await resolveOwnedContainer();
        } catch (error: unknown) {
          cleanupReport.container = { state: "unknown", verified: false };
          cleanupReport.errors.push(
            error instanceof Error
              ? error.message
              : "Container ownership could not be verified.",
          );
        }
      }

      if (containerVerified && containerId) {
        const stopped = runSync("docker", ["stop", containerId]);
        let state: DockerResourceState = "UNKNOWN";
        for (let attempt = 0; attempt < 15; attempt += 1) {
          const inspection = runSync("docker", ["inspect", containerId]);
          state = classifyDockerInspect(inspection);
          if (classifyContainerCleanup(state) !== "present") {
            break;
          }
          await delay(1_000);
        }
        const containerCleanup = classifyContainerCleanup(state);
        if (containerCleanup === "removed") {
          cleanupReport.container = { state: "removed", verified: true };
        } else if (containerCleanup === "present") {
          cleanupReport.container = { state: "present", verified: true };
          cleanupReport.errors.push("The owned container remained after cleanup.");
        } else {
          cleanupReport.container = { state: "unknown", verified: false };
          cleanupReport.errors.push(
            `Container removal could not be verified (${state}${stopped.status === 0 ? "" : "; stop command failed"}).`,
          );
        }
      }

      cleanupReport.volume.name = volumeName;
      if (volumeName && cleanupReport.container.state === "removed") {
        const inspection = runSync("docker", ["volume", "inspect", volumeName]);
        const state = classifyDockerInspect(inspection);
        let identityMatches = false;
        if (state === "PRESENT") {
          try {
            const value: unknown = JSON.parse(inspection.stdout);
            const entry = Array.isArray(value) ? value[0] : value;
            identityMatches =
              typeof entry === "object" &&
              entry !== null &&
              "Name" in entry &&
              entry.Name === volumeName;
          } catch {
            identityMatches = false;
          }
        }
        const volumeCleanup = classifyVolumeCleanup(state, identityMatches);
        if (volumeCleanup === "removed") {
          cleanupReport.volume = {
            state: "removed",
            verified: true,
            name: volumeName,
          };
        } else if (volumeCleanup === "present") {
          cleanupReport.volume = {
            state: "present",
            verified: true,
            name: volumeName,
          };
          cleanupReport.errors.push(
            "The run-owned anonymous volume remains; it was not removed automatically.",
          );
        } else {
          cleanupReport.volume = {
            state: "unknown",
            verified: false,
            name: volumeName,
          };
          cleanupReport.errors.push(
            `Anonymous volume removal could not be verified (${state}).`,
          );
        }
      } else if (volumeName === null) {
        if (cleanupReport.container.state === "not_created") {
          cleanupReport.volume = {
            state: "not_created",
            verified: true,
            name: null,
          };
        } else {
          cleanupReport.volume = {
            state: "unknown",
            verified: false,
            name: null,
          };
          cleanupReport.errors.push(
            "No verified container mount was available to identify the temporary volume.",
          );
        }
      } else if (cleanupReport.container.state !== "removed") {
        cleanupReport.volume = {
          state: "unknown",
          verified: false,
          name: volumeName,
        };
      }

      cleanupReport.success = cleanupIsVerified(cleanupReport);
      return cleanupReport;
    })();
    return cleanupPromise;
  };

  const throwIfTerminated = (): void => {
    termination.throwIfTerminated("Evaluation");
  };
  const unregisterTerminationHandlers = registerTerminationHandlers(
    (signal, listener) => {
      process.on(signal, listener);
    },
    (signal, listener) => {
      process.off(signal, listener);
    },
    termination,
  );

  try {
    const started = runSync(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--cidfile",
        cidfilePath,
        "--name",
        containerName,
        "--label",
        `${RUNNER_LABEL}=${RUNNER_LABEL_VALUE}`,
        "--label",
        `${RUN_ID_LABEL}=${runId}`,
        "--env",
        "POSTGRES_DB",
        "--env",
        "POSTGRES_USER",
        "--env",
        "POSTGRES_PASSWORD",
        "--publish",
        "127.0.0.1::5432",
        POSTGRES_IMAGE,
      ],
      {
        ...process.env,
        POSTGRES_DB: database.database,
        POSTGRES_USER: database.user,
        POSTGRES_PASSWORD: database.password,
      },
    );
    throwIfTerminated();
    if (started.status === 0 && /^[0-9a-f]{12,64}$/iu.test(started.stdout)) {
      containerId = started.stdout;
      await inspectOwnedContainer(containerId);
    } else if (!(await resolveOwnedContainer())) {
      throw new Error(
        `Docker did not create an identifiable container (${started.errorCode ?? started.status ?? "unknown"}).`,
      );
    }
    if (!containerVerified) {
      throw new Error(
        "The temporary container was created but its ownership could not be verified.",
      );
    }
    currentPhase = "database_migration";
    await waitForPostgres(
      database,
      throwIfTerminated,
      () => termination.reason !== null,
    );
    throwIfTerminated();

    const migrationEnv = buildMigrationEnvironment(database);
    const migrate = () =>
      {
        console.log(
          runNodeSync(["--import=tsx", "src/migrate.ts"], migrationEnv, secrets),
        );
        throwIfTerminated();
      };
    migrate();
    await verifyMigrations(database);
    throwIfTerminated();
    migrate();
    await verifyMigrations(database);
    throwIfTerminated();

    currentPhase = "seeding";
    const seeded = await seedEvaluation(database, secrets);
    throwIfTerminated();
    console.log("Temporary database seeded; evaluator memberships verified.");

    currentPhase = "service_startup";
    endpoints = {
      apiPort: await findFreePort(),
      orchestratorPort: await findFreePort(),
      serviceKey,
    };
    throwIfTerminated();
    assertTemporaryPort(endpoints.apiPort);
    assertTemporaryPort(endpoints.orchestratorPort);

    orchestrator = new ManagedProcess(
      "orchestrator",
      pythonExecutable,
      [
        "-m",
        "uvicorn",
        "sentinelops_ai_orchestrator.app:app",
        "--app-dir",
        "src",
        "--host",
        "127.0.0.1",
        "--port",
        String(endpoints.orchestratorPort),
      ],
      { cwd: orchestratorDirectory, env: buildOrchestratorEnvironment(endpoints) },
      secrets,
    );
    await waitForHttp(
      "AI orchestrator",
      new URL(`http://127.0.0.1:${endpoints.orchestratorPort}/health`),
      orchestrator,
      60_000,
      throwIfTerminated,
    );
    throwIfTerminated();

    api = new ManagedProcess(
      "api",
      process.execPath,
      ["--import=tsx", "src/server.ts"],
      { cwd: apiDirectory, env: buildApiEnvironment(database, endpoints) },
      secrets,
    );
    await waitForHttp(
      "Product API",
      new URL(`http://127.0.0.1:${endpoints.apiPort}/health`),
      api,
      60_000,
      throwIfTerminated,
    );
    throwIfTerminated();

    // The evaluator performs its own warm-up and /ready check.
    currentPhase = "evaluation";
    evaluator = new ManagedProcess(
      "evaluator",
      process.execPath,
      ["--import=tsx", "src/evaluate-inc001.ts", seeded.projectId],
      {
        cwd: apiDirectory,
        env: {
          ...buildEvaluatorEnvironment(endpoints, {
            email: seeded.evaluatorEmail,
            password: seeded.evaluatorPassword,
          }),
          SENTINELOPS_TRACE_RUN_ID: traceRunId,
        },
      },
      secrets,
    );
    const outcome = await Promise.race([
      evaluator.exited.then((code) => ({ kind: "done" as const, code })),
      api.exited.then(() => ({ kind: "api" as const, code: null })),
      orchestrator.exited.then(() => ({
        kind: "orchestrator" as const,
        code: null,
      })),
      delay(EVALUATION_TIMEOUT_MS).then(() => ({
        kind: "timeout" as const,
        code: null,
      })),
      termination.interrupted.then((signal) => ({
        kind: "signal" as const,
        signal,
        code: null,
      })),
    ]);
    if (outcome.kind === "signal") {
      throw new Error(`Evaluation interrupted by ${outcome.signal}.`);
    }
    if (outcome.kind !== "done") {
      if (outcome.kind === "timeout") {
        termination.record("timeout");
      }
      throw new Error(
        outcome.kind === "timeout"
          ? "The evaluation exceeded its time limit."
          : `The ${outcome.kind} process exited during the evaluation.`,
      );
    }
    evaluatorExitCode = outcome.code;
    evaluationExitCode = outcome.code;
    if (outcome.code === 0) {
      const candidateOutput = evaluator.stdout.trim();
      const expectation = parseEvaluationTraceExpectation(
        candidateOutput,
        groundTruth,
        traceRunId,
        seeded.projectId,
      );
      const tracePool = makePool(database);
      let traceVerification: TraceVerificationReport;
      try {
        await assertDatabaseIdentity(tracePool, database);
        traceVerification = await new RetrievalTraceVerifier(
          tracePool,
        ).verifyTrace(expectation);
      } finally {
        await tracePool.end();
      }
      finalizedEvaluationOutput = finalizeEvaluationOutput(
        candidateOutput,
        groundTruth,
        traceRunId,
        traceVerification,
      );
      const verifiedSummary = summarizeEvaluationOutput(
        finalizedEvaluationOutput,
        groundTruth,
      );
      if (!verifiedSummary.parsed) {
        throw new Error("The verified evaluation report is invalid.");
      }
      evaluationExitCode = verifiedSummary.passed === true ? 0 : 1;
    }
  } catch (error: unknown) {
    failureStage = currentPhase;
    runnerError = redactSecrets(
      error instanceof Error ? error.message : "Unknown error.",
      secrets,
    );
    console.error("INC-001 isolated evaluation aborted:", runnerError);
  } finally {
    currentPhase = "cleanup";
    try {
      await cleanup();
    } catch (error: unknown) {
      const detail = redactSecrets(
        error instanceof Error ? error.message : "Unknown cleanup error.",
        secrets,
      );
      cleanupReport.errors.push(detail);
      runnerError = appendError(runnerError, `Cleanup failed: ${detail}`);
      failureStage ??= "cleanup";
    } finally {
      unregisterTerminationHandlers();
    }
  }

  const evaluatorStdout =
    finalizedEvaluationOutput ?? evaluator?.stdout.trim() ?? "";
  const summary = summarizeEvaluationOutput(evaluatorStdout, groundTruth);
  let result = resolveEvaluationResult(
    summary,
    evaluationExitCode,
    cleanupReport.success,
    runnerError,
    termination.reason,
  );
  if (
    failureStage === null &&
    evaluatorExitCode !== null &&
    evaluatorExitCode !== 0
  ) {
    failureStage =
      parseEvaluationFailureStage(evaluator?.stderr ?? "") ?? "evaluation";
  }
  const finishedAt = new Date();
  try {
    await writeFile(
      join(resultDirectory, summary.parsed ? "evaluation.json" : "evaluation.raw.txt"),
      evaluatorStdout,
    );
    await writeFile(join(resultDirectory, "evaluator.stderr.log"), evaluator?.stderr ?? "");
    await writeFile(
      join(resultDirectory, "api.log"),
      api ? `${api.stdout}${api.stderr}` : "",
    );
    await writeFile(
      join(resultDirectory, "orchestrator.log"),
      orchestrator ? `${orchestrator.stdout}${orchestrator.stderr}` : "",
    );
    await writeFile(
      join(resultDirectory, "meta.json"),
      JSON.stringify(
        {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          runId,
          traceRunId,
          phase: currentPhase,
          failureStage,
          evaluatorExitCode,
          evaluationExitCode,
          passed: summary.passed,
          status: result.status,
          evaluationStatus: result.evaluationStatus,
          cleanupStatus: result.cleanupStatus,
          evaluationJsonParsed: summary.parsed,
          evaluationValidationErrors: summary.validationErrors,
          terminationReason: termination.reason,
          interruption: {
            signal:
              termination.reason === "SIGINT" ||
              termination.reason === "SIGTERM"
                ? termination.reason
                : null,
            timedOut: termination.reason === "timeout",
          },
          failure: {
            stage: failureStage,
            runnerError,
            cleanupErrors: cleanupReport.errors,
          },
          runnerError,
          timings: summary.timings,
          modelReportedByInvestigation: summary.model,
          configuredModels: {
            chat: "qwen3.5:4b",
            embedding: "qwen3-embedding:0.6b",
            ollama: pre.ollama,
          },
          versions: {
            node: process.version,
            python: pre.pythonVersion,
            postgresImage: POSTGRES_IMAGE,
          },
          isolation: {
            containerRunId: runId,
            traceRunId,
            container: containerName,
            database: database.database,
            postgresPort: database.port,
            apiPort: endpoints?.apiPort ?? null,
            orchestratorPort: endpoints?.orchestratorPort ?? null,
          },
          cleanup: cleanupReport,
        },
        null,
        2,
      ),
    );
    console.log(`Results saved to ${resultDirectory}`);
  } catch (error: unknown) {
    runnerError = [
      runnerError,
      `Could not persist the evaluation report: ${error instanceof Error ? error.message : "unknown error"}`,
    ]
      .filter(Boolean)
      .join("; ");
    console.error("The evaluation report could not be persisted.");
  }

  result = resolveEvaluationResult(
    summary,
    evaluationExitCode,
    cleanupReport.success,
    runnerError,
    termination.reason,
  );
  console.log(
    `Evaluator exit code: ${evaluatorExitCode ?? "not run"}; result: ${result.status}; cleanup success: ${cleanupReport.success}`,
  );
  return result.exitCode;
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      "INC-001 isolated evaluation failed:",
      error instanceof Error ? error.message : "Unknown error.",
    );
    process.exitCode = 1;
  },
);
