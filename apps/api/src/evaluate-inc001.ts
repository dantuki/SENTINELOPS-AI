import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  evaluateInc001Response,
  type Inc001Evidence,
  type Inc001GroundTruth,
} from "./inc001-evaluation.js";

interface InvestigationData {
  model: string;
  response: string;
  evidence: Inc001Evidence[];
}

interface GroundTruthReference extends Inc001GroundTruth {
  dataset: string;
  incident_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseGroundTruth(value: unknown): GroundTruthReference {
  if (
    !isRecord(value) ||
    typeof value.dataset !== "string" ||
    value.incident_id !== "INC-001" ||
    !Array.isArray(value.expected_observations) ||
    !Array.isArray(value.must_not_claim)
  ) {
    throw new Error("INC-001 evaluation reference has an invalid shape.");
  }

  const expectedObservations: Array<{ id: string }> = [];
  const mustNotClaim: string[] = [];

  for (const observation of value.expected_observations) {
    if (!isRecord(observation) || typeof observation.id !== "string") {
      throw new Error("INC-001 observation reference has an invalid shape.");
    }

    expectedObservations.push({ id: observation.id });
  }

  for (const claim of value.must_not_claim) {
    if (typeof claim !== "string") {
      throw new Error("INC-001 prohibited claim reference is invalid.");
    }

    mustNotClaim.push(claim);
  }

  return {
    dataset: value.dataset,
    incident_id: "INC-001",
    expected_observations: expectedObservations,
    must_not_claim: mustNotClaim,
  };
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
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
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

async function main(): Promise<void> {
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
  const warmupResponse = await fetch(new URL("/warmup", aiBase), {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
  });
  if (!warmupResponse.ok) {
    throw new Error(
      `AI model warm-up failed with HTTP ${warmupResponse.status}.`,
    );
  }
  const warmupDurationMs =
    Math.round((performance.now() - warmupStartedAt) * 10) / 10;

  const readinessResponse = await fetch(new URL("/ready", aiBase), {
    signal: AbortSignal.timeout(3_000),
  });
  if (!readinessResponse.ok) {
    throw new Error(
      `AI models are not ready after warm-up: HTTP ${readinessResponse.status}.`,
    );
  }

  let ingestionDurationMs: number | null = null;
  if (!skipIngestion) {
    const ingestionStartedAt = performance.now();
    const ingestion = await postJson(
      new URL(`/api/projects/${projectId}/ingestions/demo`, apiBase),
      {},
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
    ),
  );
  const investigationDurationMs =
    Math.round((performance.now() - investigationStartedAt) * 10) / 10;

  const referencePath = fileURLToPath(
    new URL(
      "../../../datasets/demo-pedidos-api/ground-truth/INC-001.expected.json",
      import.meta.url,
    ),
  );
  const rawGroundTruth: unknown = JSON.parse(
    await readFile(referencePath, "utf8"),
  );
  const groundTruth = parseGroundTruth(rawGroundTruth);
  const evaluation = evaluateInc001Response(
    investigation.response,
    investigation.evidence,
    groundTruth,
  );
  const referenceLeaked = investigation.evidence.some((item) =>
    [
      "synthetic_evaluation_reference",
      "evaluation_only_do_not_ingest",
      "best_supported_hypothesis",
    ].some((marker) => item.content.includes(marker)),
  );
  const abstained =
    investigation.model === "not-invoked" ||
    investigation.evidence.length === 0;
  const passed =
    !abstained &&
    !referenceLeaked &&
    evaluation.retrievalRecall === 1 &&
    evaluation.answerCoverage === 1 &&
    evaluation.citations.count > 0 &&
    evaluation.citations.invalid.length === 0 &&
    evaluation.factualityViolations.length === 0;

  console.log(
    JSON.stringify(
      {
        dataset: groundTruth.dataset,
        incidentId: groundTruth.incident_id,
        model: investigation.model,
        evidenceCount: investigation.evidence.length,
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
    "INC-001 evaluation failed:",
    error instanceof Error ? error.message : "Unknown evaluation error.",
  );
  process.exitCode = 1;
});
