import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  containsEvaluationReference,
  evaluateInc001Response,
  isInc001EvaluationAccepted,
  parseInc001GroundTruth,
  type Inc001Evidence,
} from "./inc001-evaluation.js";

interface InvestigationData {
  model: string;
  response: string;
  evidence: Inc001Evidence[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseInvestigation(value: unknown): InvestigationData {
  if (
    !isRecord(value) ||
    !isRecord(value.data) ||
    typeof value.data.model !== "string" ||
    typeof value.data.response !== "string" ||
    !Array.isArray(value.data.evidence)
  ) {
    throw new Error("Product API returned an invalid investigation response.");
  }

  const evidence: Inc001Evidence[] = [];
  for (const item of value.data.evidence) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.content !== "string"
    ) {
      throw new Error("Investigation evidence has an invalid shape.");
    }

    evidence.push({
      id: item.id,
      content: item.content,
    });
  }

  return {
    model: value.data.model,
    response: value.data.response,
    evidence,
  };
}

async function postJson(
  url: URL,
  payload: Record<string, unknown>,
  session: EvaluationSession,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      cookie: session.cookie,
      origin: session.origin,
      "x-csrf-token": session.csrfToken,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
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
    ),
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
  const evaluation = evaluateInc001Response(
    investigation.response,
    investigation.evidence,
    groundTruth,
  );
  const referenceLeaked = containsEvaluationReference(investigation.evidence);
  const abstained =
    investigation.model === "not-invoked" ||
    investigation.evidence.length === 0;
  const passed = isInc001EvaluationAccepted(
    investigation.model,
    investigation.evidence,
    evaluation,
  );

  console.log(
    JSON.stringify(
      {
        dataset: groundTruth.dataset,
        incidentId: groundTruth.incident_id,
        model: investigation.model,
        evidenceCount: investigation.evidence.length,
        evidence: investigation.evidence,
        response: investigation.response,
        ingestion: skipIngestion ? "skipped" : "completed",
        timings: {
          warmupMs: warmupDurationMs,
          ingestionMs: ingestionDurationMs,
          investigationMs: investigationDurationMs,
        },
        abstained,
        referenceLeaked,
        evaluation,
        passed,
      },
      null,
      2,
    ),
  );

  if (!passed) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(
    `INC-001 evaluation failed [stage=${currentStage}]:`,
    error instanceof Error ? error.message : "Unknown evaluation error.",
  );
  process.exitCode = 1;
});
