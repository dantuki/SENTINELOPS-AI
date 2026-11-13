import type {
  VerifiedFact,
  VerifiedFactInventory,
  VerifiedFactRecord,
  VerifiedFactValue,
} from "./verified-fact-engine.js";
import {
  composeVerifiedInvestigationResult,
  hasCompletePresentedFacts,
  type VerifiedObservation,
} from "./verified-investigation-result.js";

export type InvestigationMode = "deterministic" | "hybrid" | "ai";
export type AiEnrichmentStatus = "not_requested" | "unavailable" | "invalid" | "validated";

export interface DeterministicPattern {
  ruleId: string;
  version: "v1";
  description: string;
  confidenceCategory: "observed" | "correlated" | "insufficient_evidence";
  matchedFactIds: string[];
  evidenceRefs: string[];
  limitations: string[];
  suggestedChecks: string[];
}

export interface DeterministicHypothesis {
  statement: string;
  status: "insufficient_evidence";
  supportingEvidence: string[];
  contradictingEvidence: string[];
  missingEvidence: string[];
  recommendedChecks: string[];
}

export interface DeterministicInvestigationResult {
  schemaVersion: "investigation-result-v2";
  investigationId: string;
  projectId: string;
  incidentId: string | null;
  requestId: string;
  runId: string;
  status: "complete" | "partial" | "insufficient_evidence";
  generatedAt: string;
  mode: InvestigationMode;
  evidenceManifest: Array<{ evidenceId: string; evidenceAlias: string; hash: string; locator: VerifiedObservation["sourceLocator"] }>;
  verifiedObservations: VerifiedObservation[];
  detectedPatterns: DeterministicPattern[];
  hypotheses: DeterministicHypothesis[];
  missingInformation: string[];
  recommendedChecks: string[];
  limitations: string[];
  aiEnrichment: { status: AiEnrichmentStatus; model: string | null; failure: string | null };
  verification: { attestationStatus: "verified" | "failed" | "unverified"; recomputable: boolean };
  gateResult: DeterministicProductGateResult;
}

export interface DeterministicProductGateResult {
  gate: "evidence-first-deterministic-product-gate-v2";
  status: "pass" | "fail";
  reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Boundary validator for serialized API and runner output. */
export function isDeterministicInvestigationResult(value: unknown): value is DeterministicInvestigationResult {
  return isRecord(value) && value.schemaVersion === "investigation-result-v2" &&
    typeof value.investigationId === "string" && typeof value.projectId === "string" &&
    (typeof value.incidentId === "string" || value.incidentId === null) &&
    typeof value.requestId === "string" && typeof value.runId === "string" &&
    ["complete", "partial", "insufficient_evidence"].includes(String(value.status)) &&
    ["deterministic", "hybrid", "ai"].includes(String(value.mode)) &&
    Array.isArray(value.verifiedObservations) && Array.isArray(value.detectedPatterns) &&
    Array.isArray(value.hypotheses) && isRecord(value.aiEnrichment) &&
    isRecord(value.verification) && isRecord(value.gateResult) &&
    value.gateResult.gate === "evidence-first-deterministic-product-gate-v2" &&
    ["pass", "fail"].includes(String(value.gateResult.status));
}

type FactWithRecord = { fact: VerifiedFact; record: VerifiedFactRecord };

function valueNumber(value: VerifiedFactValue): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function propertyMatches(property: string, expression: RegExp): boolean {
  return expression.test(property.toLowerCase());
}

function observationFor(inventory: VerifiedFactInventory): VerifiedObservation[] {
  const aliases = new Map(inventory.records.map((record) => [record.evidenceId, record.evidenceAlias]));
  return inventory.facts.map((fact) => ({ ...fact, evidenceAlias: aliases.get(fact.evidenceId) ?? "" }));
}

function recordFacts(inventory: VerifiedFactInventory): FactWithRecord[] {
  const records = new Map(inventory.records.map((record) => [record.eventId, record]));
  return inventory.facts.flatMap((fact) => {
    const record = records.get(fact.eventId);
    return record ? [{ fact, record }] : [];
  });
}

function factsFor(record: VerifiedFactRecord, facts: FactWithRecord[], expression: RegExp): FactWithRecord[] {
  return facts.filter(({ fact }) => fact.eventId === record.eventId && propertyMatches(fact.property, expression));
}

function createPattern(
  ruleId: DeterministicPattern["ruleId"],
  description: string,
  matched: FactWithRecord[],
  limitations: string[],
  suggestedChecks: string[],
  confidenceCategory: DeterministicPattern["confidenceCategory"] = "observed",
): DeterministicPattern {
  return {
    ruleId,
    version: "v1",
    description,
    confidenceCategory,
    matchedFactIds: [...new Set(matched.map(({ fact }) => fact.factId))],
    evidenceRefs: [...new Set(matched.map(({ fact }) => fact.evidenceId))],
    limitations,
    suggestedChecks,
  };
}

/**
 * Applies intentionally small rules to facts from a single attested runtime
 * record. It never joins snapshots merely because their text looks related.
 */
export function detectDeterministicPatterns(inventory: VerifiedFactInventory): DeterministicPattern[] {
  if (inventory.attestationStatus !== "verified") return [];
  const all = recordFacts(inventory);
  const patterns: DeterministicPattern[] = [];
  for (const record of inventory.records) {
    const active = factsFor(record, all, /(?:^|_)(?:active|in_use|used)(?:_|$)/u).find(({ fact }) => valueNumber(fact.value) !== null);
    const maximum = factsFor(record, all, /(?:^|_)(?:max|maximum|capacity|limit)(?:_|$)/u).find(({ fact }) => valueNumber(fact.value) !== null);
    if (active && maximum && valueNumber(active.fact.value)! >= valueNumber(maximum.fact.value)!) {
      patterns.push(createPattern(
        "capacity-at-limit", "La capacidad activa observada alcanza o supera el límite en un mismo evento.", [active, maximum],
        ["La condición observada no demuestra por sí sola la causa de un incidente."],
        ["Comprobar saturación sostenida con mediciones adicionales del mismo recurso."],
      ));
    }
    const idle = factsFor(record, all, /(?:^|_)(?:idle|available|free)(?:_|$)/u).find(({ fact }) => valueNumber(fact.value) === 0);
    if (idle) patterns.push(createPattern(
      "no-idle-capacity", "No se observó capacidad inactiva en este evento.", [idle],
      ["Una medición aislada no establece persistencia temporal."],
      ["Obtener series temporales de capacidad libre y activa."],
    ));
    const waiting = factsFor(record, all, /(?:^|_)(?:waiting|waiters|queued|queue_depth|queue_size)(?:_|$)/u).filter(({ fact }) => (valueNumber(fact.value) ?? 0) > 0);
    if (waiting.length > 0) patterns.push(createPattern(
      "operational-waiting", "Se observaron solicitudes o elementos en espera en un mismo evento.", waiting,
      ["La espera observada no identifica el componente que la provocó."],
      ["Correlacionar las esperas con trazas del mismo request_id si está disponible."],
    ));
    const retry = factsFor(record, all, /(?:^|_)(?:retry|retries|attempts?)(?:_|$)/u).filter(({ fact }) => (valueNumber(fact.value) ?? 0) > 0);
    if (retry.length > 0) patterns.push(createPattern(
      "retries-observed", "Se observaron reintentos o intentos adicionales.", retry,
      ["Los reintentos no demuestran la causa del fallo original."],
      ["Revisar el error original y la política de reintento para el mismo evento."],
    ));
    const status = factsFor(record, all, /(?:^|_)(?:http_)?status(?:_code)?(?:_|$)/u).filter(({ fact }) => {
      const numeric = valueNumber(fact.value);
      return numeric !== null && numeric >= 500 && numeric < 600;
    });
    if (status.length > 0) patterns.push(createPattern(
      "http-5xx-observed", "Se observó una respuesta HTTP 5xx.", status,
      ["El código HTTP no atribuye causalidad a un servicio concreto."],
      ["Consultar trazas downstream y el cuerpo/error asociado al mismo request_id."],
    ));
    const timeout = factsFor(record, all, /(?:timeout|timed_out|deadline)/u).filter(({ fact }) => fact.value === true || typeof fact.value === "string");
    if (timeout.length > 0) patterns.push(createPattern(
      "timeout-observed", "Se observó un timeout explícito o un campo de timeout.", timeout,
      ["Un timeout no determina qué dependencia o recurso lo originó."],
      ["Comparar latencias y errores de dependencias para la misma operación."],
    ));
  }
  return patterns;
}

export function evaluateDeterministicProductGate(input: {
  inventory: VerifiedFactInventory;
  result: Pick<DeterministicInvestigationResult, "verifiedObservations" | "detectedPatterns" | "hypotheses" | "mode">;
}): DeterministicProductGateResult {
  const reasons: string[] = [];
  const publicResult = composeVerifiedInvestigationResult({ inventory: input.inventory, analysis: null, analysisStatus: "not_invoked" });
  publicResult.verifiedObservations = input.result.verifiedObservations;
  if (input.inventory.attestationStatus !== "verified") reasons.push("evidence_attestation_not_verified");
  if (input.result.verifiedObservations.length === 0) reasons.push("no_verified_observations");
  if (!hasCompletePresentedFacts(input.inventory, publicResult)) reasons.push("verified_observations_do_not_match_inventory");
  const knownFacts = new Set(input.inventory.facts.map((fact) => fact.factId));
  const knownEvidence = new Set(input.inventory.records.map((record) => record.evidenceId));
  for (const pattern of input.result.detectedPatterns) {
    if (pattern.matchedFactIds.length === 0 || pattern.matchedFactIds.some((id) => !knownFacts.has(id))) reasons.push(`invalid_pattern_facts:${pattern.ruleId}`);
    if (pattern.evidenceRefs.length === 0 || pattern.evidenceRefs.some((id) => !knownEvidence.has(id))) reasons.push(`invalid_pattern_evidence:${pattern.ruleId}`);
    if (/\b(?:causa\s+ra[ií]z|root cause|caused by|causado por)\b/iu.test(pattern.description)) reasons.push(`causal_pattern:${pattern.ruleId}`);
  }
  if (input.result.hypotheses.some((hypothesis) => hypothesis.status !== "insufficient_evidence")) reasons.push("hypothesis_not_explicitly_unconfirmed");
  return { gate: "evidence-first-deterministic-product-gate-v2", status: reasons.length === 0 ? "pass" : "fail", reasons };
}

export function buildDeterministicInvestigation(input: {
  inventory: VerifiedFactInventory;
  investigationId: string;
  projectId: string;
  incidentId: string | null;
  requestId: string;
  runId: string;
  generatedAt: string;
  mode: InvestigationMode;
  aiEnrichment?: DeterministicInvestigationResult["aiEnrichment"];
}): DeterministicInvestigationResult {
  const verifiedObservations = observationFor(input.inventory);
  const detectedPatterns = detectDeterministicPatterns(input.inventory);
  const recommendedChecks = [...new Set(detectedPatterns.flatMap((pattern) => pattern.suggestedChecks))];
  const limitations = [
    "Las observaciones se limitan a valores presentes en registros JSONL atestados.",
    "Los patrones describen condiciones observadas; no confirman causalidad.",
    ...new Set(detectedPatterns.flatMap((pattern) => pattern.limitations)),
  ];
  const missingInformation = [
    "Trazas o métricas adicionales que permitan demostrar una relación causal.",
    "Mediciones temporales comparables para determinar persistencia.",
  ];
  const hypotheses: DeterministicHypothesis[] = [{
    statement: "Causa raíz no determinada con la evidencia disponible.",
    status: "insufficient_evidence",
    supportingEvidence: [],
    contradictingEvidence: [],
    missingEvidence: missingInformation,
    recommendedChecks: recommendedChecks.length > 0 ? recommendedChecks : ["Obtener telemetría adicional del incidente antes de atribuir una causa."],
  }];
  const base = {
    schemaVersion: "investigation-result-v2" as const,
    investigationId: input.investigationId,
    projectId: input.projectId,
    incidentId: input.incidentId,
    requestId: input.requestId,
    runId: input.runId,
    status: input.inventory.attestationStatus !== "verified" || verifiedObservations.length === 0 ? "insufficient_evidence" as const : detectedPatterns.length === 0 ? "partial" as const : "complete" as const,
    generatedAt: input.generatedAt,
    mode: input.mode,
    evidenceManifest: input.inventory.records.map((record) => ({ evidenceId: record.evidenceId, evidenceAlias: record.evidenceAlias, hash: record.sourceLocator.recordContentHash, locator: record.sourceLocator })),
    verifiedObservations,
    detectedPatterns,
    hypotheses,
    missingInformation,
    recommendedChecks: recommendedChecks.length > 0 ? recommendedChecks : ["Obtener evidencia adicional antes de establecer una relación causal."],
    limitations,
    aiEnrichment: input.aiEnrichment ?? { status: "not_requested" as const, model: null, failure: null },
    verification: { attestationStatus: input.inventory.attestationStatus, recomputable: input.inventory.attestationStatus === "verified" },
  };
  return { ...base, gateResult: evaluateDeterministicProductGate({ inventory: input.inventory, result: base }) };
}

export function renderDeterministicInvestigation(result: DeterministicInvestigationResult): string {
  const lines = [
    "Resultado determinista basado en evidencia atestada.",
    "Observaciones verificadas:",
    ...result.verifiedObservations.map((fact) => `- ${fact.property}=${String(fact.value)}${fact.unit ? ` ${fact.unit}` : ""} [${fact.evidenceAlias}]`),
    "Patrones detectados:",
    ...(result.detectedPatterns.length > 0 ? result.detectedPatterns.map((pattern) => `- ${pattern.description}`) : ["- No se aplicó una regla con evidencia suficiente."]),
    "Hipótesis:",
    ...result.hypotheses.map((hypothesis) => `- ${hypothesis.statement}`),
    "Limitaciones:",
    ...result.limitations.map((limitation) => `- ${limitation}`),
  ];
  return lines.join("\n");
}
