import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TerminationReason } from "./inc001-runner-lifecycle.js";
import {
  containsEvaluationReference,
  type Inc001Evidence,
  type Inc001GroundTruth,
} from "../src/inc001-evaluation.js";
import { evaluateInc001V2 } from "./inc001-evaluator-v2.js";
import {
  renderInvestigationAnalysis,
  type InvestigationAnalysis,
} from "../src/investigation-analysis.js";
import {
  isVerifiedInvestigationResult,
  type VerifiedInvestigationResult,
} from "../src/verified-investigation-result.js";
import {
  hashChunkContent,
  isUuid,
  type EvidenceManifestItem,
} from "../src/retrieval-trace.js";
import type { TraceVerificationReport } from "../src/retrieval-trace-verifier.js";

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
  "008",
] as const;
export const REQUIRED_OLLAMA_MODELS = [
  "qwen3.5:4b",
  "qwen3-embedding:0.6b",
] as const;
export const ORCHESTRATOR_CHAT_MODEL = "qwen3.5:4b";
export const ORCHESTRATOR_EMBEDDING_MODEL = "qwen3-embedding:0.6b";
export const OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const APP_ORIGIN = "http://127.0.0.1:3000";
// The isolated runner has a 12-minute outer deadline. These bounded nested
// deadlines leave time for one local structured response and orderly cleanup.
export const ISOLATED_CHAT_TIMEOUT_SECONDS = 300;
export const ISOLATED_INVESTIGATION_TIMEOUT_MS = 305_000;
export const ISOLATED_EVALUATION_REQUEST_TIMEOUT_MS = 310_000;

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
    AI_ORCHESTRATOR_INVESTIGATION_TIMEOUT_MS: String(ISOLATED_INVESTIGATION_TIMEOUT_MS),
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
    OLLAMA_CHAT_TIMEOUT_SECONDS: String(ISOLATED_CHAT_TIMEOUT_SECONDS),
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
    SENTINELOPS_EVAL_REQUEST_TIMEOUT_MS: String(ISOLATED_EVALUATION_REQUEST_TIMEOUT_MS),
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

const CANDIDATE_KEYS = [
  "reportType",
  "dataset",
  "incidentId",
  "model",
  "evidenceCount",
  "runId",
  "requestId",
  "retrievedAt",
  "evidenceManifest",
  "response",
  "analysis",
  "verifiedInvestigationResult",
  "ingestion",
  "timings",
  "abstained",
  "referenceLeaked",
] as const;

const VERIFIED_REPORT_KEYS = [
  ...CANDIDATE_KEYS.filter((key) => key !== "reportType"),
  "reportType",
  "traceVerification",
  "evaluation",
  "passed",
] as const;

const LEGACY_CANDIDATE_KEYS = CANDIDATE_KEYS.filter(
  (key) => key !== "verifiedInvestigationResult",
);
const LEGACY_VERIFIED_REPORT_KEYS = VERIFIED_REPORT_KEYS.filter(
  (key) => key !== "verifiedInvestigationResult",
);

function hasCandidateKeys(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, CANDIDATE_KEYS) || hasExactKeys(value, LEGACY_CANDIDATE_KEYS);
}

function hasVerifiedReportKeys(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, VERIFIED_REPORT_KEYS) || hasExactKeys(value, LEGACY_VERIFIED_REPORT_KEYS);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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

interface EvaluationCandidate {
  dataset: string;
  incidentId: "INC-001";
  model: string;
  evidenceCount: number;
  runId: string;
  requestId: string;
  retrievedAt: string;
  evidenceManifest: EvidenceManifestItem[];
  response: string;
  analysis: InvestigationAnalysis;
  verifiedInvestigationResult?: VerifiedInvestigationResult;
  ingestion: "skipped" | "completed";
  timings: {
    warmupMs: number;
    ingestionMs: number | null;
    investigationMs: number;
  };
}

function parseEvaluationAnalysis(value: unknown): InvestigationAnalysis | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "summary",
      "summary_evidence_refs",
      "observed_facts",
      "hypotheses",
      "missing_information",
      "next_checks",
      "limitations",
    ]) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    !isStringArray(value.summary_evidence_refs) ||
    !Array.isArray(value.observed_facts) ||
    !Array.isArray(value.hypotheses) ||
    !isStringArray(value.missing_information) ||
    !isStringArray(value.next_checks) ||
    !isStringArray(value.limitations)
  ) {
    return null;
  }

  const observedFacts: InvestigationAnalysis["observed_facts"] = [];
  for (const fact of value.observed_facts) {
    if (
      !isRecord(fact) ||
      !(hasExactKeys(fact, ["claim", "evidence_refs"]) || hasExactKeys(fact, ["event_id", "claim", "evidence_refs"])) ||
      typeof fact.claim !== "string" ||
      !fact.claim.trim() ||
      !isStringArray(fact.evidence_refs) ||
      (Object.hasOwn(fact, "event_id") && (typeof fact.event_id !== "string" || !fact.event_id.trim()))
    ) {
      return null;
    }
    observedFacts.push({
      ...(typeof fact.event_id === "string" ? { event_id: fact.event_id } : {}),
      claim: fact.claim,
      evidence_refs: fact.evidence_refs,
    });
  }

  const statuses = new Set([
    "supported_unconfirmed",
    "unverified",
    "contradicted",
    "insufficient_evidence",
  ]);
  const hypotheses: InvestigationAnalysis["hypotheses"] = [];
  for (const hypothesis of value.hypotheses) {
    if (
      !isRecord(hypothesis) ||
      !hasExactKeys(hypothesis, [
        "statement",
        "status",
        "supporting_evidence",
        "contradicting_evidence",
      ]) ||
      typeof hypothesis.statement !== "string" ||
      !hypothesis.statement.trim() ||
      typeof hypothesis.status !== "string" ||
      !statuses.has(hypothesis.status) ||
      !isStringArray(hypothesis.supporting_evidence) ||
      !isStringArray(hypothesis.contradicting_evidence)
    ) {
      return null;
    }
    hypotheses.push({
      statement: hypothesis.statement,
      status:
        hypothesis.status as InvestigationAnalysis["hypotheses"][number]["status"],
      supporting_evidence: hypothesis.supporting_evidence,
      contradicting_evidence: hypothesis.contradicting_evidence,
    });
  }

  return {
    summary: value.summary,
    summary_evidence_refs: value.summary_evidence_refs,
    observed_facts: observedFacts,
    hypotheses,
    missing_information: value.missing_information,
    next_checks: value.next_checks,
    limitations: value.limitations,
  };
}

function parseManifest(
  value: unknown,
  runId: string,
  requestId: string,
): EvidenceManifestItem[] | null {
  if (!Array.isArray(value) || value.length > 5) {
    return null;
  }
  const manifest: EvidenceManifestItem[] = [];
  const seenChunkIds = new Set<string>();
  const scopes = new Set([
    "incident_specific",
    "project_context",
    "other_incident",
    "unknown_scope",
  ]);
  for (const [index, raw] of value.entries()) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "alias",
        "chunkId",
        "content",
        "contentHash",
        "documentId",
        "evidenceId",
        "evidenceScope",
        "incidentId",
        "ordinal",
        "projectId",
        "rank",
        "requestId",
        "retrievedAt",
        "runId",
        "score",
        "sourceId",
      ]) ||
      !isUuid(raw.evidenceId) ||
      raw.evidenceId !== raw.chunkId ||
      !isUuid(raw.chunkId) ||
      !isUuid(raw.documentId) ||
      !isUuid(raw.sourceId) ||
      !isUuid(raw.projectId) ||
      raw.runId !== runId ||
      raw.requestId !== requestId ||
      raw.incidentId !== "INC-001" ||
      raw.alias !== `E${index + 1}` ||
      raw.rank !== index + 1 ||
      !Number.isInteger(raw.ordinal) ||
      Number(raw.ordinal) < 0 ||
      typeof raw.score !== "number" ||
      !Number.isFinite(raw.score) ||
      typeof raw.content !== "string" ||
      raw.content.length === 0 ||
      raw.contentHash !== hashChunkContent(raw.content) ||
      typeof raw.evidenceScope !== "string" ||
      !scopes.has(raw.evidenceScope) ||
      typeof raw.retrievedAt !== "string" ||
      Number.isNaN(Date.parse(raw.retrievedAt)) ||
      new Date(raw.retrievedAt).toISOString() !== raw.retrievedAt ||
      seenChunkIds.has(raw.chunkId)
    ) {
      return null;
    }
    seenChunkIds.add(raw.chunkId);
    manifest.push({
      evidenceId: raw.evidenceId,
      alias: raw.alias,
      runId: raw.runId,
      requestId: raw.requestId,
      projectId: raw.projectId,
      incidentId: raw.incidentId,
      chunkId: raw.chunkId,
      documentId: raw.documentId,
      sourceId: raw.sourceId,
      ordinal: Number(raw.ordinal),
      rank: Number(raw.rank),
      score: raw.score,
      content: raw.content,
      contentHash: raw.contentHash,
      evidenceScope: raw.evidenceScope as EvidenceManifestItem["evidenceScope"],
      retrievedAt: raw.retrievedAt,
    });
  }
  return manifest;
}

function parseCandidate(
  value: unknown,
  groundTruth: Inc001GroundTruth,
  expectedRunId: string,
): EvaluationCandidate | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    !hasCandidateKeys(value) ||
    value.reportType !== "inc001-candidate-v1" ||
    value.dataset !== "sentinelops-synthetic-demo-v1" ||
    value.incidentId !== "INC-001" ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    value.runId !== expectedRunId ||
    !isUuid(value.runId) ||
    !isUuid(value.requestId) ||
    typeof value.retrievedAt !== "string" ||
    Number.isNaN(Date.parse(value.retrievedAt)) ||
    !Number.isInteger(value.evidenceCount) ||
    Number(value.evidenceCount) < 0 ||
    Number(value.evidenceCount) > 5 ||
    typeof value.response !== "string" ||
    value.response.length === 0 ||
    (value.verifiedInvestigationResult !== undefined && value.verifiedInvestigationResult !== null && !isVerifiedInvestigationResult(value.verifiedInvestigationResult)) ||
    (value.ingestion !== "skipped" && value.ingestion !== "completed") ||
    typeof value.abstained !== "boolean" ||
    typeof value.referenceLeaked !== "boolean" ||
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
    )
  ) {
    return null;
  }

  const manifest = parseManifest(value.evidenceManifest, expectedRunId, value.requestId);
  const analysis = parseEvaluationAnalysis(value.analysis);
  if (
    !manifest ||
    manifest.length !== value.evidenceCount ||
    !analysis ||
    manifest.some((item) => item.retrievedAt !== value.retrievedAt) ||
    renderInvestigationAnalysis(analysis) !== value.response
  ) {
    return null;
  }

  const aliases = new Set(manifest.map(({ alias }) => alias));
  const references = [
    ...analysis.summary_evidence_refs,
    ...analysis.observed_facts.flatMap(({ evidence_refs }) => evidence_refs),
    ...analysis.hypotheses.flatMap(({ supporting_evidence, contradicting_evidence }) => [
      ...supporting_evidence,
      ...contradicting_evidence,
    ]),
  ];
  if (references.some((reference) => !aliases.has(reference))) {
    return null;
  }

  const evidence = manifest.map<Inc001Evidence>((item) => ({
    id: item.chunkId,
    content: item.content,
    alias: item.alias,
    evidenceScope: item.evidenceScope,
  }));
  const referenceLeaked = containsEvaluationReference(evidence);
  const abstained = value.model === "not-invoked" || evidence.length === 0;
  if (
    value.referenceLeaked !== referenceLeaked ||
    value.abstained !== abstained
  ) {
    return null;
  }
  return {
    dataset: value.dataset,
    incidentId: "INC-001",
    model: value.model,
    evidenceCount: Number(value.evidenceCount),
    runId: value.runId,
    requestId: value.requestId,
    retrievedAt: value.retrievedAt,
    evidenceManifest: manifest,
    response: value.response,
    analysis,
    ...(isVerifiedInvestigationResult(value.verifiedInvestigationResult)
      ? { verifiedInvestigationResult: value.verifiedInvestigationResult }
      : {}),
    ingestion: value.ingestion,
    timings: {
      warmupMs: value.timings.warmupMs,
      ingestionMs: value.timings.ingestionMs as number | null,
      investigationMs: value.timings.investigationMs,
    },
  };
}

function isTraceVerificationReport(value: unknown): value is TraceVerificationReport {
  if (
    isRecord(value) &&
    hasExactKeys(value, [
      "status",
      "verifiedCount",
      "unverifiedCount",
      "failedCount",
      "verificationErrors",
      "verifiedEvidenceIds",
      "requestId",
      "runId",
      "evidence",
    ]) &&
    ["verified", "unverified", "failed"].includes(String(value.status)) &&
    Number.isInteger(value.verifiedCount) &&
    Number.isInteger(value.unverifiedCount) &&
    typeof value.failedCount === "number" &&
    Number.isInteger(value.failedCount) &&
    isStringArray(value.verificationErrors) &&
    isStringArray(value.verifiedEvidenceIds) &&
    isUuid(value.requestId) &&
    isUuid(value.runId) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(
      (item) =>
        isRecord(item) &&
        Object.keys(item).every((key) => key === "evidenceId" || key === "status" || key === "attestation") &&
        Object.keys(item).length >= 2 &&
        isUuid(item.evidenceId) &&
        ["verified", "unverified", "failed"].includes(String(item.status)),
    )
  ) {
    const evidence = value.evidence as Array<{
      evidenceId: string;
      status: string;
    }>;
    const verifiedIds = evidence
      .filter(({ status }) => status === "verified")
      .map(({ evidenceId }) => evidenceId);
    const unverifiedCount = evidence.filter(
      ({ status }) => status === "unverified",
    ).length;
    const failedCount = evidence.filter(
      ({ status }) => status === "failed",
    ).length;
    const verifiedCount = verifiedIds.length;
    const expectedStatus =
      value.verificationErrors.length > 0 || value.failedCount > 0
        ? "failed"
        : unverifiedCount > 0
          ? "unverified"
          : "verified";
    return (
      value.verifiedCount === verifiedCount &&
      value.unverifiedCount === unverifiedCount &&
      Number(value.failedCount) >= failedCount &&
      value.status === expectedStatus &&
      isDeepStrictEqual(value.verifiedEvidenceIds, verifiedIds) &&
      new Set(evidence.map(({ evidenceId }) => evidenceId)).size ===
        evidence.length
    );
  }
  return false;
}

function createVerifiedReport(
  candidate: EvaluationCandidate,
  traceVerification: TraceVerificationReport,
  groundTruth: Inc001GroundTruth,
): Record<string, unknown> {
  const evaluation = evaluateInc001V2({
    response: candidate.response,
    analysis: candidate.analysis,
    manifest: candidate.evidenceManifest,
    trace: traceVerification,
    groundTruth,
    publicResult: candidate.verifiedInvestigationResult,
  });
  const evidence = candidate.evidenceManifest.map<Inc001Evidence>((item) => ({
    id: item.chunkId,
    content: item.content,
    alias: item.alias,
    evidenceScope: item.evidenceScope,
  }));
  const referenceLeaked = containsEvaluationReference(evidence);
  const abstained = candidate.model === "not-invoked" || evidence.length === 0;
  const passed =
    traceVerification.status === "verified" &&
    candidate.model !== "not-invoked" &&
    !referenceLeaked &&
    evaluation.accepted;
  return {
    ...candidate,
    reportType: "inc001-verified-v2",
    abstained,
    referenceLeaked,
    traceVerification,
    evaluation,
    passed,
  };
}

function traceMatchesCandidate(
  traceVerification: TraceVerificationReport,
  candidate: EvaluationCandidate,
): boolean {
  return (
    traceVerification.runId === candidate.runId &&
    traceVerification.requestId === candidate.requestId &&
    isDeepStrictEqual(
      traceVerification.evidence.map(({ evidenceId }) => evidenceId),
      candidate.evidenceManifest.map(({ evidenceId }) => evidenceId),
    )
  );
}

export function parseEvaluationTraceExpectation(
  candidateOutput: string,
  groundTruth: Inc001GroundTruth,
  expectedRunId: string,
  expectedProjectId: string,
): {
  runId: string;
  requestId: string;
  projectId: string;
  incidentId: string;
  retrievedAt: string;
  manifest: EvidenceManifestItem[];
} {
  let value: unknown;
  try {
    value = JSON.parse(candidateOutput);
  } catch {
    throw new Error("Evaluator output is not valid JSON.");
  }
  const candidate = parseCandidate(value, groundTruth, expectedRunId);
  if (
    !candidate ||
    candidate.evidenceManifest.some(
      (item) => item.projectId !== expectedProjectId,
    )
  ) {
    throw new Error("Evaluator candidate does not match the isolated project.");
  }
  return {
    runId: candidate.runId,
    requestId: candidate.requestId,
    projectId: expectedProjectId,
    incidentId: "INC-001",
    retrievedAt: candidate.retrievedAt,
    manifest: candidate.evidenceManifest,
  };
}

export function finalizeEvaluationOutput(
  candidateOutput: string,
  groundTruth: Inc001GroundTruth,
  expectedRunId: string,
  traceVerification: TraceVerificationReport,
): string {
  let value: unknown;
  try {
    value = JSON.parse(candidateOutput);
  } catch {
    throw new Error("Evaluator output is not valid JSON.");
  }
  const candidate = parseCandidate(value, groundTruth, expectedRunId);
  if (
    !candidate ||
    !isTraceVerificationReport(traceVerification) ||
    !traceMatchesCandidate(traceVerification, candidate)
  ) {
    throw new Error("Evaluator candidate or retrieval verification is invalid.");
  }
  const finalized = createVerifiedReport(
    candidate,
    traceVerification,
    groundTruth,
  );
  const output = JSON.stringify(finalized, null, 2);
  if (!summarizeEvaluationOutput(output, groundTruth).parsed) {
    throw new Error("Finalized evaluation report failed integrity validation.");
  }
  return output;
}

export function summarizeEvaluationOutput(
  stdout: string,
  groundTruth: Inc001GroundTruth,
): EvaluationOutcome {
  try {
    const value: unknown = JSON.parse(stdout);
    const parsed =
      isRecord(value) &&
      hasVerifiedReportKeys(value) &&
      value.reportType === "inc001-verified-v2" &&
      typeof value.runId === "string" &&
      isUuid(value.runId) &&
      isTraceVerificationReport(value.traceVerification) &&
      value.traceVerification.runId === value.runId &&
      typeof value.requestId === "string" &&
      value.traceVerification.requestId === value.requestId &&
      isRecord(value.timings) &&
      typeof value.model === "string"
        ? (() => {
            const candidateValue = {
              reportType: "inc001-candidate-v1",
              dataset: value.dataset,
              incidentId: value.incidentId,
              model: value.model,
              evidenceCount: value.evidenceCount,
              runId: value.runId,
              requestId: value.requestId,
              retrievedAt: value.retrievedAt,
              evidenceManifest: value.evidenceManifest,
              response: value.response,
              analysis: value.analysis,
              ...("verifiedInvestigationResult" in value
                ? { verifiedInvestigationResult: value.verifiedInvestigationResult }
                : {}),
              ingestion: value.ingestion,
              timings: value.timings,
              abstained: value.abstained,
              referenceLeaked: value.referenceLeaked,
            };
            const candidate = parseCandidate(
              candidateValue,
              groundTruth,
              value.runId,
            );
            if (
              !candidate ||
              !traceMatchesCandidate(value.traceVerification, candidate) ||
              !isDeepStrictEqual(
                createVerifiedReport(
                  candidate,
                  value.traceVerification,
                  groundTruth,
                ),
                value,
              )
            ) {
              return false;
            }
            return true;
          })()
        : false;
    return {
      parsed,
      passed: parsed && isRecord(value) && typeof value.passed === "boolean"
        ? value.passed
        : null,
      model: parsed && isRecord(value) && typeof value.model === "string" ? value.model : null,
      timings: parsed && isRecord(value) ? value.timings : null,
      validationErrors: parsed ? [] : ["invalid or incomplete verified evaluation report"],
    };
  } catch {
    return {
      parsed: false,
      passed: null,
      model: null,
      timings: null,
      validationErrors: ["invalid or incomplete verified evaluation report"],
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
