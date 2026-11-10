import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  containsEvaluationReference,
  parseInc001GroundTruth,
} from "./inc001-evaluation.js";
import {
  renderInvestigationAnalysis,
  type InvestigationAnalysis,
} from "./investigation-analysis.js";
import {
  hashChunkContent,
  isUuid,
  type EvidenceManifestItem,
} from "./retrieval-trace.js";

interface InvestigationData {
  model: string;
  response: string;
  evidence: EvidenceManifestItem[];
  evidenceManifest: EvidenceManifestItem[];
  runId: string;
  requestId: string;
  retrievedAt: string;
  analysis: InvestigationAnalysis;
}

interface EvaluationSession {
  cookie: string;
  csrfToken: string;
  origin: string;
}

type EvaluationStage =
  | "arguments"
  | "warmup"
  | "readiness"
  | "authentication"
  | "ingestion"
  | "investigation"
  | "evaluation";

let currentStage: EvaluationStage = "arguments";
const DEFAULT_EVALUATION_REQUEST_TIMEOUT_MS = 120_000;
const MAX_EVALUATION_REQUEST_TIMEOUT_MS = 600_000;

function evaluationRequestTimeoutMs(): number {
  const configured = Number(process.env.SENTINELOPS_EVAL_REQUEST_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1_000 && configured <= MAX_EVALUATION_REQUEST_TIMEOUT_MS
    ? configured
    : DEFAULT_EVALUATION_REQUEST_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseInvestigationAnalysis(value: unknown): InvestigationAnalysis {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      [
        "hypotheses",
        "limitations",
        "missing_information",
        "next_checks",
        "observed_facts",
        "summary",
        "summary_evidence_refs",
      ]
        .sort()
        .join(",") ||
    typeof value.summary !== "string" ||
    !isStringArray(value.summary_evidence_refs) ||
    !Array.isArray(value.observed_facts) ||
    !Array.isArray(value.hypotheses) ||
    !isStringArray(value.missing_information) ||
    !isStringArray(value.next_checks) ||
    !isStringArray(value.limitations)
  ) {
    throw new Error("Investigation analysis has an invalid shape.");
  }
  const observedFacts = value.observed_facts.map((fact) => {
    if (
      !isRecord(fact) ||
      Object.keys(fact).sort().join(",") !== "claim,evidence_refs" ||
      typeof fact.claim !== "string" ||
      !isStringArray(fact.evidence_refs)
    ) {
      throw new Error("Investigation fact has an invalid shape.");
    }
    return { claim: fact.claim, evidence_refs: fact.evidence_refs };
  });
  const allowedStatuses = new Set([
    "supported_unconfirmed",
    "unverified",
    "contradicted",
    "insufficient_evidence",
  ]);
  const hypotheses = value.hypotheses.map((hypothesis) => {
    if (
      !isRecord(hypothesis) ||
      Object.keys(hypothesis).sort().join(",") !==
        "contradicting_evidence,statement,status,supporting_evidence" ||
      typeof hypothesis.statement !== "string" ||
      typeof hypothesis.status !== "string" ||
      !allowedStatuses.has(hypothesis.status) ||
      !isStringArray(hypothesis.supporting_evidence) ||
      !isStringArray(hypothesis.contradicting_evidence)
    ) {
      throw new Error("Investigation hypothesis has an invalid shape.");
    }
    return {
      statement: hypothesis.statement,
      status: hypothesis.status as InvestigationAnalysis["hypotheses"][number]["status"],
      supporting_evidence: hypothesis.supporting_evidence,
      contradicting_evidence: hypothesis.contradicting_evidence,
    };
  });
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

function parseEvidenceManifest(value: unknown): EvidenceManifestItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Product API returned an invalid evidence manifest.");
  }
  return value.map((item, index) => {
    const keys = [
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
    ].sort();
    if (
      !isRecord(item) ||
      Object.keys(item).sort().join(",") !== keys.join(",") ||
      !isUuid(item.evidenceId) ||
      !isUuid(item.chunkId) ||
      item.evidenceId !== item.chunkId ||
      item.alias !== `E${index + 1}` ||
      !isUuid(item.runId) ||
      !isUuid(item.requestId) ||
      !isUuid(item.projectId) ||
      !isUuid(item.documentId) ||
      !isUuid(item.sourceId) ||
      (item.incidentId !== null && typeof item.incidentId !== "string") ||
      !Number.isInteger(item.ordinal) ||
      Number(item.ordinal) < 0 ||
      item.rank !== index + 1 ||
      typeof item.content !== "string" ||
      item.content.length === 0 ||
      typeof item.contentHash !== "string" ||
      item.contentHash !== hashChunkContent(item.content) ||
      typeof item.score !== "number" ||
      !Number.isFinite(item.score) ||
      ![
        "incident_specific",
        "project_context",
        "other_incident",
        "unknown_scope",
      ].includes(String(item.evidenceScope)) ||
      typeof item.retrievedAt !== "string" ||
      Number.isNaN(Date.parse(item.retrievedAt))
    ) {
      throw new Error(`Evidence manifest item ${index + 1} is invalid.`);
    }
    return item as unknown as EvidenceManifestItem;
  });
}

function parseInvestigation(
  value: unknown,
  projectId: string,
  expectedRunId: string | undefined,
): InvestigationData {
  const data = isRecord(value) ? value.data : undefined;
  if (
    !isRecord(data) ||
    Object.keys(data).sort().join(",") !==
      "analysis,evidence,evidenceManifest,model,requestId,response,retrievedAt,runId" ||
    typeof data.model !== "string" ||
    typeof data.response !== "string" ||
    !isUuid(data.runId) ||
    !isUuid(data.requestId) ||
    typeof data.retrievedAt !== "string" ||
    Number.isNaN(Date.parse(data.retrievedAt)) ||
    (expectedRunId !== undefined && data.runId !== expectedRunId)
  ) {
    throw new Error("Product API returned an invalid investigation response.");
  }

  const evidence = parseEvidenceManifest(data.evidence);
  const evidenceManifest = parseEvidenceManifest(data.evidenceManifest);
  if (JSON.stringify(evidence) !== JSON.stringify(evidenceManifest)) {
    throw new Error("Investigation evidence differs from its manifest.");
  }
  const analysis = parseInvestigationAnalysis(data.analysis);
  const response = data.response;
  const runId = data.runId;
  const requestId = data.requestId;
  if (
    evidence.some(
      (item) =>
        item.runId !== runId ||
        item.requestId !== requestId ||
        item.projectId !== projectId ||
        item.incidentId !== "INC-001" ||
        item.retrievedAt !== data.retrievedAt,
    ) ||
    renderInvestigationAnalysis(analysis) !== response
  ) {
    throw new Error("Investigation response is not correlated with its manifest.");
  }

  return {
    model: data.model,
    response,
    evidence,
    evidenceManifest,
    runId,
    requestId,
    retrievedAt: data.retrievedAt,
    analysis,
  };
}

async function postJson(
  url: URL,
  payload: Record<string, unknown>,
  session: EvaluationSession,
  traceRunId?: string,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: session.cookie,
      origin: session.origin,
      "x-csrf-token": session.csrfToken,
      ...(traceRunId ? { "x-sentinelops-run-id": traceRunId } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(evaluationRequestTimeoutMs()),
  });

  if (!response.ok) {
    throw new Error(
      `Product API request failed with HTTP ${response.status}.`,
    );
  }

  return response.json();
}

async function authenticateForEvaluation(
  apiBase: URL,
): Promise<EvaluationSession> {
  const email = process.env.SENTINELOPS_EVAL_EMAIL;
  const password = process.env.SENTINELOPS_EVAL_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Set SENTINELOPS_EVAL_EMAIL and SENTINELOPS_EVAL_PASSWORD for an authorized investigator account.",
    );
  }
  const origin =
    process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
  const response = await fetch(new URL("/api/auth/login", apiBase), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin,
    },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(
      `Evaluation account authentication failed with HTTP ${response.status}.`,
    );
  }

  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies
    .map((cookie) => cookie.split(";", 1)[0]!)
    .find((cookie) =>
      cookie.startsWith("__Host-sentinel_session=") ||
      cookie.startsWith("sentinel_session="),
    );
  const csrfCookie = cookies
    .map((cookie) => cookie.split(";", 1)[0]!)
    .find((cookie) =>
      cookie.startsWith("__Host-sentinel_csrf=") ||
      cookie.startsWith("sentinel_csrf="),
    );
  if (!sessionCookie || !csrfCookie) {
    throw new Error("Authentication response did not include session cookies.");
  }
  const csrfToken = csrfCookie.slice(csrfCookie.indexOf("=") + 1);
  return {
    cookie: `${sessionCookie}; ${csrfCookie}`,
    csrfToken,
    origin,
  };
}

async function withEvaluationSession(
  apiBase: URL,
  session: EvaluationSession,
  action: () => Promise<void>,
): Promise<void> {
  let actionFailed = false;
  try {
    await action();
  } catch (error: unknown) {
    actionFailed = true;
    throw error;
  } finally {
    try {
      const response = await fetch(new URL("/api/auth/logout", apiBase), {
        method: "POST",
        headers: {
          cookie: session.cookie,
          origin: session.origin,
          "x-csrf-token": session.csrfToken,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(
          `Evaluation session logout failed with HTTP ${response.status}.`,
        );
      }
    } catch (error: unknown) {
      if (actionFailed) {
        console.error("The evaluation session could not be revoked.");
      } else {
        throw error;
      }
    }
  }
}

async function main(): Promise<void> {
  currentStage = "arguments";
  const argumentsList = process.argv.slice(2);
  const skipIngestion = argumentsList.includes("--skip-ingestion");
  const positionalArguments = argumentsList.filter(
    (argument) => argument !== "--skip-ingestion",
  );
  const projectId = positionalArguments[0];
  const traceRunId = process.env.SENTINELOPS_TRACE_RUN_ID;
  if (
    positionalArguments.length !== 1 ||
    !projectId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      projectId,
    )
  ) {
    throw new Error(
      "Provide one existing project UUID and optionally --skip-ingestion.",
    );
  }
  if (traceRunId !== undefined && !isUuid(traceRunId)) {
    throw new Error("SENTINELOPS_TRACE_RUN_ID must be a UUID.");
  }

  const apiBase = new URL(
    process.env.PRODUCT_API_URL ?? "http://127.0.0.1:3001",
  );
  if (!["http:", "https:"].includes(apiBase.protocol)) {
    throw new Error("PRODUCT_API_URL must use HTTP or HTTPS.");
  }

  const aiBase = new URL(
    process.env.AI_ORCHESTRATOR_URL ?? "http://127.0.0.1:8000",
  );
  if (!["http:", "https:"].includes(aiBase.protocol)) {
    throw new Error(
      "AI_ORCHESTRATOR_URL must use HTTP or HTTPS.",
    );
  }

  const warmupStartedAt = performance.now();
  currentStage = "warmup";
  const aiAuthKey = process.env.AI_ORCHESTRATOR_API_KEY;
  const warmupResponse = await fetch(new URL("/warmup", aiBase), {
    method: "POST",
    headers: aiAuthKey ? { authorization: `Bearer ${aiAuthKey}` } : {},
    signal: AbortSignal.timeout(120_000),
  });
  if (!warmupResponse.ok) {
    throw new Error(
      `AI model warm-up failed with HTTP ${warmupResponse.status}.`,
    );
  }
  const warmupDurationMs =
    Math.round((performance.now() - warmupStartedAt) * 10) / 10;

  currentStage = "readiness";
  const readinessResponse = await fetch(new URL("/ready", aiBase), {
    signal: AbortSignal.timeout(3_000),
  });
  if (!readinessResponse.ok) {
    throw new Error(
      `AI models are not ready after warm-up: HTTP ${readinessResponse.status}.`,
    );
  }

  currentStage = "authentication";
  const session = await authenticateForEvaluation(apiBase);
  await withEvaluationSession(apiBase, session, () =>
    runEvaluation(
      apiBase,
      session,
      projectId,
      traceRunId,
      skipIngestion,
      warmupDurationMs,
      (stage) => {
        currentStage = stage;
      },
    ),
  );
}

async function runEvaluation(
  apiBase: URL,
  session: EvaluationSession,
  projectId: string,
  traceRunId: string | undefined,
  skipIngestion: boolean,
  warmupDurationMs: number,
  setStage: (stage: EvaluationStage) => void,
): Promise<void> {
  let ingestionDurationMs: number | null = null;
  if (!skipIngestion) {
    setStage("ingestion");
    const ingestionStartedAt = performance.now();
    const ingestion = await postJson(
      new URL(`/api/projects/${projectId}/ingestions/demo`, apiBase),
      {},
      session,
    );
    if (
      !isRecord(ingestion) ||
      !isRecord(ingestion.data) ||
      ingestion.data.dataset !== "sentinelops-synthetic-demo-v1" ||
      !Array.isArray(ingestion.data.files) ||
      !ingestion.data.files.every(
        (file) => isRecord(file) && file.status === "indexed",
      )
    ) {
      throw new Error(
        "INC-001 ingestion did not finish with every document indexed.",
      );
    }

    ingestionDurationMs =
      Math.round((performance.now() - ingestionStartedAt) * 10) / 10;
  }

  setStage("investigation");
  const investigationStartedAt = performance.now();
  const investigation = parseInvestigation(
    await postJson(
      new URL(`/api/projects/${projectId}/investigate`, apiBase),
      {
        question:
          "Describe la cronología de INC-001. En hechos, separa estos cinco puntos y no omitas valores: intentos y request ID; ambas mediciones del pool; endpoint, request ID, mensaje de error y código HTTP; métricas de la cola; nombre, estado y duración de payment-gateway. Distingue hechos, hipótesis y datos faltantes; no afirmes causalidad sin pruebas.",
        incidentId: "INC-001",
        limit: 5,
      },
      session,
      traceRunId,
    ),
    projectId,
    traceRunId,
  );
  const investigationDurationMs =
    Math.round((performance.now() - investigationStartedAt) * 10) / 10;

  setStage("evaluation");
  const referencePath = fileURLToPath(
    new URL(
      "../../../datasets/demo-pedidos-api/ground-truth/INC-001.expected.json",
      import.meta.url,
    ),
  );
  const rawGroundTruth: unknown = JSON.parse(
    await readFile(referencePath, "utf8"),
  );
  const groundTruth = parseInc001GroundTruth(rawGroundTruth);
  const referenceLeaked = containsEvaluationReference(
    investigation.evidence.map((item) => ({
      id: item.chunkId,
      content: item.content,
    })),
  );
  const abstained =
    investigation.model === "not-invoked" ||
    investigation.evidence.length === 0;
  console.log(
    JSON.stringify(
      {
        reportType: "inc001-candidate-v1",
        dataset: groundTruth.dataset,
        incidentId: groundTruth.incident_id,
        model: investigation.model,
        evidenceCount: investigation.evidence.length,
        runId: investigation.runId,
        requestId: investigation.requestId,
        retrievedAt: investigation.retrievedAt,
        evidenceManifest: investigation.evidenceManifest,
        response: investigation.response,
        analysis: investigation.analysis,
        ingestion: skipIngestion ? "skipped" : "completed",
        timings: {
          warmupMs: warmupDurationMs,
          ingestionMs: ingestionDurationMs,
          investigationMs: investigationDurationMs,
        },
        abstained,
        referenceLeaked,
      },
      null,
      2,
    ),
  );

}

void main().catch((error: unknown) => {
  console.error(
    `INC-001 evaluation failed [stage=${currentStage}]:`,
    error instanceof Error ? error.message : "Unknown evaluation error.",
  );
  process.exitCode = 1;
});
