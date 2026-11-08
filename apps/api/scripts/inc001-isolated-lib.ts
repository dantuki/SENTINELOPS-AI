import { randomBytes } from "node:crypto";
import type { TerminationReason } from "./inc001-runner-lifecycle.js";
import {
  containsEvaluationReference,
  evaluateInc001Response,
  isInc001EvaluationAccepted,
  type Inc001Evidence,
  type Inc001GroundTruth,
} from "../src/inc001-evaluation.js";

export const POSTGRES_IMAGE = "pgvector/pgvector:0.8.7-pg18-trixie";
export const HABITUAL_POSTGRES_PORT = 5432;
export const HABITUAL_VOLUME_NAME = "sentinelops-ai_postgres_data";
export const POSTGRES_IMAGE_VOLUME_PATH = "/var/lib/postgresql";
export const EXPECTED_MIGRATIONS = [
  "001",
  "002",
  "003",
  "004",
  "005",
  "006",
  "007",
] as const;
export const REQUIRED_OLLAMA_MODELS = [
  "qwen3.5:4b",
  "qwen3-embedding:0.6b",
] as const;
export const ORCHESTRATOR_CHAT_MODEL = "qwen3.5:4b";
export const ORCHESTRATOR_EMBEDDING_MODEL = "qwen3-embedding:0.6b";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const APP_ORIGIN = "http://127.0.0.1:3000";

const DATABASE_PATTERN = /^sentinelops_inc001_eval_\d+$/u;
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/u;
const CONTAINER_PATTERN = /^sentinelops-inc001-eval-[0-9a-f]{32}$/u;
const ANONYMOUS_VOLUME_PATTERN = /^[0-9a-f]{64}$/u;
export const RUNNER_LABEL = "com.sentinelops.runner";
export const RUN_ID_LABEL = "com.sentinelops.run-id";
export const RUNNER_LABEL_VALUE = "inc001-isolated";

const SYSTEM_ENVIRONMENT_NAMES = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "LANG",
] as const;

export function createTemporaryDatabaseName(now: number = Date.now()): string {
  return `sentinelops_inc001_eval_${now}`;
}

export function assertTemporaryDatabaseName(name: string): void {
  if (!DATABASE_PATTERN.test(name)) {
    throw new Error(
      "The database name must match sentinelops_inc001_eval_<timestamp>.",
    );
  }
}

export function createRunId(): string {
  return randomBytes(16).toString("hex");
}

export function createContainerName(runId: string = createRunId()): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("The evaluation run ID must contain 32 lowercase hex digits.");
  }
  return `sentinelops-inc001-eval-${runId}`;
}

export function assertTemporaryContainerName(name: string): void {
  if (!CONTAINER_PATTERN.test(name)) {
    throw new Error(
      "The container name must match sentinelops-inc001-eval-<16 hex digits>.",
    );
  }
}

export function assertTemporaryPort(port: number): void {
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535 ||
    port === HABITUAL_POSTGRES_PORT
  ) {
    throw new Error(
      "The temporary PostgreSQL port must be an unprivileged port other than 5432.",
    );
  }
}

export function parseDockerPort(output: string): number {
  const loopback = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (loopback.length === 0 || loopback.some((line) => !line.startsWith("127.0.0.1:"))) {
    throw new Error(
      "The temporary PostgreSQL port must be published only on 127.0.0.1.",
    );
  }
  const match = /^127\.0\.0\.1:(\d+)$/u.exec(loopback[0]!);
  if (!match?.[1]) {
    throw new Error("Could not resolve the isolated PostgreSQL port.");
  }
  const port = Number(match[1]);
  assertTemporaryPort(port);
  return port;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ExpectedContainer {
  id: string;
  name: string;
  runId: string;
  image: string;
  port: number;
}

// Accepts the JSON produced by `docker inspect <container>`.
export function assertContainerIdentity(
  inspected: unknown,
  expected: ExpectedContainer,
): void {
  assertTemporaryContainerName(expected.name);
  assertTemporaryPort(expected.port);
  if (!RUN_ID_PATTERN.test(expected.runId)) {
    throw new Error("The evaluation run ID is invalid.");
  }
  const entry = Array.isArray(inspected) ? inspected[0] : inspected;
  if (!isRecord(entry)) {
    throw new Error("Docker inspect returned an unexpected shape.");
  }
  if (entry.Id !== expected.id || entry.Name !== `/${expected.name}`) {
    throw new Error(
      "The inspected container is not the one created by this runner.",
    );
  }
  const config = entry.Config;
  if (!isRecord(config) || config.Image !== expected.image) {
    throw new Error("The temporary container uses an unexpected image.");
  }
  const labels = isRecord(config) ? config.Labels : undefined;
  if (
    !isRecord(labels) ||
    labels[RUNNER_LABEL] !== RUNNER_LABEL_VALUE ||
    labels[RUN_ID_LABEL] !== expected.runId
  ) {
    throw new Error("The temporary container does not have this run's ownership labels.");
  }

  const mounts = entry.Mounts;
  if (!Array.isArray(mounts)) {
    throw new Error("Docker inspect did not report the container mounts.");
  }
  for (const mount of mounts) {
    if (
      !isRecord(mount) ||
      mount.Type !== "volume" ||
      typeof mount.Name !== "string" ||
      mount.Name === HABITUAL_VOLUME_NAME ||
      !ANONYMOUS_VOLUME_PATTERN.test(mount.Name) ||
      mount.Destination !== POSTGRES_IMAGE_VOLUME_PATH
    ) {
      throw new Error(
        "The temporary container has a bind mount or a named volume; only the image's own anonymous data volume is allowed.",
      );
    }
  }

  const hostConfig = entry.HostConfig;
  const bindings = isRecord(hostConfig) ? hostConfig.PortBindings : undefined;
  const published = isRecord(bindings) ? bindings["5432/tcp"] : undefined;
  if (
    !Array.isArray(published) ||
    published.length !== 1 ||
    !isRecord(published[0]) ||
    published[0].HostIp !== "127.0.0.1"
  ) {
    throw new Error(
      "PostgreSQL must be published exactly once and only on 127.0.0.1.",
    );
  }
  if (isRecord(hostConfig) && Array.isArray(hostConfig.Binds) && hostConfig.Binds.length > 0) {
    throw new Error("The temporary container must not use bind mounts.");
  }
  if (!isRecord(hostConfig) || hostConfig.AutoRemove !== true) {
    throw new Error("The temporary container must be started with --rm.");
  }

  const network = entry.NetworkSettings;
  const ports = isRecord(network) ? network.Ports : undefined;
  const actual = isRecord(ports) ? ports["5432/tcp"] : undefined;
  if (
    !Array.isArray(actual) ||
    actual.length !== 1 ||
    !isRecord(actual[0]) ||
    actual[0].HostIp !== "127.0.0.1" ||
    actual[0].HostPort !== String(expected.port)
  ) {
    throw new Error(
      "The published PostgreSQL port does not match the resolved loopback port.",
    );
  }
}

export function getAnonymousPostgresVolumeName(inspected: unknown): string {
  const entry = Array.isArray(inspected) ? inspected[0] : inspected;
  if (!isRecord(entry) || !Array.isArray(entry.Mounts)) {
    throw new Error("Docker inspect did not report the temporary database volume.");
  }
  const mounts = entry.Mounts;
  if (
    mounts.length !== 1 ||
    !isRecord(mounts[0]) ||
    mounts[0].Type !== "volume" ||
    typeof mounts[0].Name !== "string" ||
    !ANONYMOUS_VOLUME_PATTERN.test(mounts[0].Name) ||
    mounts[0].Name === HABITUAL_VOLUME_NAME ||
    mounts[0].Destination !== POSTGRES_IMAGE_VOLUME_PATH
  ) {
    throw new Error("The evaluation container does not have one anonymous PostgreSQL data volume.");
  }
  return mounts[0].Name;
}

export function systemEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = new Set<string>(SYSTEM_ENVIRONMENT_NAMES);
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) {
      result[name] = value;
    }
  }
  return result;
}

export interface TemporaryDatabase {
  port: number;
  database: string;
  user: string;
  password: string;
}

function assertDatabase(database: TemporaryDatabase): void {
  assertTemporaryDatabaseName(database.database);
  assertTemporaryPort(database.port);
}

function postgresVariables(database: TemporaryDatabase): NodeJS.ProcessEnv {
  return {
    POSTGRES_HOST: "127.0.0.1",
    POSTGRES_PORT: String(database.port),
    POSTGRES_DB: database.database,
    POSTGRES_USER: database.user,
    POSTGRES_PASSWORD: database.password,
  };
}

export function buildMigrationEnvironment(
  database: TemporaryDatabase,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  assertDatabase(database);
  return {
    ...systemEnvironment(source),
    NODE_ENV: "development",
    ...postgresVariables(database),
  };
}

export interface ServiceEndpoints {
  apiPort: number;
  orchestratorPort: number;
  serviceKey: string;
}

export function buildApiEnvironment(
  database: TemporaryDatabase,
  endpoints: ServiceEndpoints,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  assertDatabase(database);
  return {
    ...systemEnvironment(source),
    NODE_ENV: "development",
    SESSION_COOKIE_SECURE: "false",
    ...postgresVariables(database),
    API_HOST: "127.0.0.1",
    API_PORT: String(endpoints.apiPort),
    APP_ORIGIN,
    AI_ORCHESTRATOR_URL: `http://127.0.0.1:${endpoints.orchestratorPort}`,
    AI_ORCHESTRATOR_API_KEY: endpoints.serviceKey,
  };
}

export function buildOrchestratorEnvironment(
  endpoints: ServiceEndpoints,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...systemEnvironment(source),
    SENTINELOPS_ENV: "development",
    OLLAMA_BASE_URL: OLLAMA_BASE_URL,
    OLLAMA_CHAT_MODEL: ORCHESTRATOR_CHAT_MODEL,
    OLLAMA_EMBEDDING_MODEL: ORCHESTRATOR_EMBEDDING_MODEL,
    AI_ORCHESTRATOR_API_KEY: endpoints.serviceKey,
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

export function buildEvaluatorEnvironment(
  endpoints: ServiceEndpoints,
  credentials: { email: string; password: string },
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...systemEnvironment(source),
    PRODUCT_API_URL: `http://127.0.0.1:${endpoints.apiPort}`,
    AI_ORCHESTRATOR_URL: `http://127.0.0.1:${endpoints.orchestratorPort}`,
    APP_ORIGIN,
    AI_ORCHESTRATOR_API_KEY: endpoints.serviceKey,
    SENTINELOPS_EVAL_EMAIL: credentials.email,
    SENTINELOPS_EVAL_PASSWORD: credentials.password,
  };
}

export function redactSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result;
}

export function missingOllamaModels(
  tags: unknown,
  required: readonly string[] = REQUIRED_OLLAMA_MODELS,
): string[] {
  const names = new Set<string>();
  if (isRecord(tags) && Array.isArray(tags.models)) {
    for (const model of tags.models) {
      if (isRecord(model) && typeof model.name === "string") {
        names.add(model.name);
      }
    }
  }
  return required.filter((name) => !names.has(name));
}

export interface EvaluationOutcome {
  parsed: boolean;
  passed: boolean | null;
  model: string | null;
  timings: unknown;
  validationErrors: string[];
}

const EVALUATION_REPORT_KEYS = new Set([
  "dataset",
  "incidentId",
  "model",
  "evidenceCount",
  "evidence",
  "response",
  "ingestion",
  "timings",
  "abstained",
  "referenceLeaked",
  "evaluation",
  "passed",
]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isUniqueKnownObservationIds(
  value: unknown,
  groundTruth: Inc001GroundTruth,
): value is string[] {
  const expectedIds = new Set(
    groundTruth.expected_observations.map(({ id }) => id),
  );
  return (
    isStringArray(value) &&
    value.every((id) => expectedIds.has(id)) &&
    new Set(value).size === value.length
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => expectedKeys.includes(key))
  );
}

function isInc001EvaluationReport(
  value: unknown,
  groundTruth: Inc001GroundTruth,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !hasExactKeys(value, [...EVALUATION_REPORT_KEYS]) ||
    value.dataset !== "sentinelops-synthetic-demo-v1" ||
    value.incidentId !== "INC-001" ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    !Number.isInteger(value.evidenceCount) ||
    Number(value.evidenceCount) < 0 ||
    Number(value.evidenceCount) > 5 ||
    typeof value.response !== "string" ||
    value.response.length === 0 ||
    !Array.isArray(value.evidence) ||
    value.evidence.length !== value.evidenceCount ||
    !value.evidence.every(
      (item) =>
        isRecord(item) &&
        hasExactKeys(item, ["id", "content"]) &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.content === "string" &&
        item.content.length > 0,
    ) ||
    (value.ingestion !== "skipped" && value.ingestion !== "completed") ||
    typeof value.abstained !== "boolean" ||
    typeof value.referenceLeaked !== "boolean" ||
    typeof value.passed !== "boolean" ||
    !isRecord(value.timings) ||
    !hasExactKeys(value.timings, [
      "warmupMs",
      "ingestionMs",
      "investigationMs",
    ]) ||
    !isNonNegativeFiniteNumber(value.timings.warmupMs) ||
    !isNonNegativeFiniteNumber(value.timings.investigationMs) ||
    !(
      value.ingestion === "skipped"
        ? value.timings.ingestionMs === null
        : isNonNegativeFiniteNumber(value.timings.ingestionMs)
    ) ||
    !isRecord(value.evaluation)
  ) {
    return false;
  }

  const evaluation = value.evaluation;
  if (
    !hasExactKeys(evaluation, [
      "retrievalRecall",
      "answerCoverage",
      "retrievedObservationIds",
      "responseObservationIds",
      "citations",
      "factualityViolations",
    ]) ||
    typeof evaluation.retrievalRecall !== "number" ||
    !Number.isFinite(evaluation.retrievalRecall) ||
    evaluation.retrievalRecall < 0 ||
    evaluation.retrievalRecall > 1 ||
    typeof evaluation.answerCoverage !== "number" ||
    !Number.isFinite(evaluation.answerCoverage) ||
    evaluation.answerCoverage < 0 ||
    evaluation.answerCoverage > 1 ||
    !isUniqueKnownObservationIds(
      evaluation.retrievedObservationIds,
      groundTruth,
    ) ||
    !isUniqueKnownObservationIds(
      evaluation.responseObservationIds,
      groundTruth,
    ) ||
    !isRecord(evaluation.citations) ||
    !hasExactKeys(evaluation.citations, ["count", "invalid"]) ||
    typeof evaluation.citations.count !== "number" ||
    !Number.isInteger(evaluation.citations.count) ||
    Number(evaluation.citations.count) < 0 ||
    !isStringArray(evaluation.citations.invalid) ||
    evaluation.citations.invalid.length > Number(evaluation.citations.count) ||
    !evaluation.citations.invalid.every((citation) =>
      /^\[E\d+\]$/u.test(citation),
    ) ||
    !Array.isArray(evaluation.factualityViolations) ||
    !evaluation.factualityViolations.every(
      (violation) =>
        isRecord(violation) &&
        hasExactKeys(violation, ["id", "description"]) &&
        typeof violation.id === "string" &&
        violation.id.length > 0 &&
        typeof violation.description === "string" &&
        violation.description.length > 0,
    )
  ) {
    return false;
  }

  const evidence = value.evidence as Inc001Evidence[];
  if (new Set(evidence.map(({ id }) => id)).size !== evidence.length) {
    return false;
  }
  const recomputed = evaluateInc001Response(
    value.response,
    evidence,
    groundTruth,
  );
  const referenceLeaked = containsEvaluationReference(evidence);
  const abstained = value.model === "not-invoked" || evidence.length === 0;
  const accepted = isInc001EvaluationAccepted(
    value.model,
    evidence,
    recomputed,
  );

  return (
    evaluation.retrievalRecall === recomputed.retrievalRecall &&
    evaluation.answerCoverage === recomputed.answerCoverage &&
    JSON.stringify(evaluation.retrievedObservationIds) ===
      JSON.stringify(recomputed.retrievedObservationIds) &&
    JSON.stringify(evaluation.responseObservationIds) ===
      JSON.stringify(recomputed.responseObservationIds) &&
    evaluation.citations.count === recomputed.citations.count &&
    JSON.stringify(evaluation.citations.invalid) ===
      JSON.stringify(recomputed.citations.invalid) &&
    JSON.stringify(evaluation.factualityViolations) ===
      JSON.stringify(recomputed.factualityViolations) &&
    value.referenceLeaked === referenceLeaked &&
    value.abstained === abstained &&
    value.passed === accepted
  );
}

export function summarizeEvaluationOutput(
  stdout: string,
  groundTruth: Inc001GroundTruth,
): EvaluationOutcome {
  try {
    const value: unknown = JSON.parse(stdout);
    const parsed = isInc001EvaluationReport(value, groundTruth);
    return {
      parsed,
      passed: parsed && typeof value.passed === "boolean" ? value.passed : null,
      model: parsed && typeof value.model === "string" ? value.model : null,
      timings: parsed ? value.timings : null,
      validationErrors: parsed ? [] : ["invalid or incomplete evaluation report"],
    };
  } catch {
    return {
      parsed: false,
      passed: null,
      model: null,
      timings: null,
      validationErrors: ["invalid or incomplete evaluation report"],
    };
  }
}

export type EvaluationStatus =
  | "passed"
  | "failed"
  | "invalid_result"
  | "not_evaluated";
export type EvaluationRunStatus =
  | EvaluationStatus
  | "infrastructure_error"
  | "interrupted"
  | "cleanup_failed";

export interface ResolvedEvaluationResult {
  status: EvaluationRunStatus;
  evaluationStatus: EvaluationStatus;
  cleanupStatus: "verified" | "failed";
  terminationReason: TerminationReason | null;
  exitCode: number;
}

export function resolveEvaluationResult(
  summary: EvaluationOutcome,
  evaluatorExitCode: number | null,
  cleanupVerified: boolean,
  runnerError: string | null,
  terminationReason: TerminationReason | null,
): ResolvedEvaluationResult {
  let evaluationStatus: EvaluationStatus;
  if (evaluatorExitCode === null) {
    evaluationStatus = "not_evaluated";
  } else if (!summary.parsed) {
    evaluationStatus = "invalid_result";
  } else if (summary.passed === true) {
    evaluationStatus =
      evaluatorExitCode === 0 ? "passed" : "invalid_result";
  } else {
    evaluationStatus =
      evaluatorExitCode === 0 ? "invalid_result" : "failed";
  }

  let status: EvaluationRunStatus = evaluationStatus;
  if (!cleanupVerified) {
    status = "cleanup_failed";
  } else if (terminationReason !== null) {
    status = "interrupted";
  } else if (runnerError !== null) {
    status = "infrastructure_error";
  }

  const exitCode =
    status === "passed"
      ? 0
      : terminationReason === "SIGINT" || terminationReason === "SIGTERM"
        ? 130
      : evaluatorExitCode !== null && evaluatorExitCode !== 0
        ? evaluatorExitCode
        : 1;

  return {
    status,
    evaluationStatus,
    cleanupStatus: cleanupVerified ? "verified" : "failed",
    terminationReason,
    exitCode,
  };
}
