import type { InvestigationAnalysis } from "./investigation-analysis.js";
import type {
  VerifiedFact,
  VerifiedFactInventory,
  VerifiedFactValue,
} from "./verified-fact-engine.js";

export interface VerifiedObservation extends VerifiedFact {
  evidenceAlias: string;
}

export interface VerifiedInvestigationResult {
  version: "verified-investigation-result-v1";
  verifiedObservations: VerifiedObservation[];
  aiAnalysis: {
    status: "validated" | "not_invoked" | "invalid";
    analysis: InvestigationAnalysis | null;
    failure: "none" | "no_evidence" | "contract_invalid" | "factuality_invalid";
  };
}

/**
 * A public, versioned composition boundary. Facts are copied only from a
 * verified inventory; model analysis remains explicitly independent.
 */
export function composeVerifiedInvestigationResult(input: {
  inventory: VerifiedFactInventory | undefined;
  analysis: InvestigationAnalysis | null;
  analysisStatus: VerifiedInvestigationResult["aiAnalysis"]["status"];
  failure?: VerifiedInvestigationResult["aiAnalysis"]["failure"];
}): VerifiedInvestigationResult {
  const aliases = new Map(
    (input.inventory?.records ?? []).map((record) => [record.evidenceId, record.evidenceAlias]),
  );
  const observations = input.inventory?.attestationStatus === "verified"
    ? input.inventory.facts.map((fact) => ({
        ...fact,
        evidenceAlias: aliases.get(fact.evidenceId) ?? "",
      }))
    : [];
  return {
    version: "verified-investigation-result-v1",
    verifiedObservations: observations,
    aiAnalysis: {
      status: input.analysisStatus,
      analysis: input.analysis,
      failure: input.failure ?? "none",
    },
  };
}

function sameValue(left: VerifiedFactValue, right: unknown): boolean {
  return left === right && (typeof left !== "number" || Number.isFinite(left));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFactValue(value: unknown): value is VerifiedFactValue {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value));
}

function isVerifiedObservation(value: unknown): value is VerifiedObservation {
  if (!isRecord(value) || !isRecord(value.context) || !isRecord(value.sourceLocator)) return false;
  const context = value.context;
  const locator = value.sourceLocator;
  return [
    "factId", "evidenceId", "eventId", "projectId", "incidentId", "documentId", "sourceId", "property", "evidenceAlias",
  ].every((key) => typeof value[key] === "string") &&
    isFactValue(value.value) &&
    ["string", "number", "boolean", "null"].includes(String(value.valueType)) &&
    (typeof value.unit === "string" || value.unit === null) &&
    ["event", "timestamp", "service", "incidentRequestId"].every(
      (key) => typeof context[key] === "string" || context[key] === null,
    ) &&
    typeof locator.line === "number" && Number.isInteger(locator.line) &&
    typeof locator.startOffset === "number" && Number.isInteger(locator.startOffset) &&
    typeof locator.endOffset === "number" && Number.isInteger(locator.endOffset) &&
    typeof locator.recordContentHash === "string" &&
    value.extractionMethod === "jsonl_record" && value.verificationStatus === "verified";
}

/** Validates untrusted serialized public output before it reaches recomputation. */
export function isVerifiedInvestigationResult(value: unknown): value is VerifiedInvestigationResult {
  if (!isRecord(value) || value.version !== "verified-investigation-result-v1" ||
    !Array.isArray(value.verifiedObservations) || !value.verifiedObservations.every(isVerifiedObservation) ||
    !isRecord(value.aiAnalysis)) return false;
  const analysis = value.aiAnalysis;
  return ["validated", "not_invoked", "invalid"].includes(String(analysis.status)) &&
    (analysis.analysis === null || isRecord(analysis.analysis)) &&
    ["none", "no_evidence", "contract_invalid", "factuality_invalid"].includes(String(analysis.failure));
}

/** Fail closed: a final result counts only exact, in-scope public facts. */
export function hasCompletePresentedFacts(
  inventory: VerifiedFactInventory,
  result: unknown,
): boolean {
  if (!isVerifiedInvestigationResult(result) || inventory.attestationStatus !== "verified") return false;
  if (result.verifiedObservations.length !== inventory.facts.length) return false;
  const expected = new Map(inventory.facts.map((fact) => [fact.factId, fact]));
  const aliases = new Map(inventory.records.map((record) => [record.evidenceId, record.evidenceAlias]));
  const seenFactIds = new Set<string>();
  return result.verifiedObservations.every((observation) => {
    if (seenFactIds.has(observation.factId)) return false;
    seenFactIds.add(observation.factId);
    const fact = expected.get(observation.factId);
    return fact !== undefined && observation.evidenceId === fact.evidenceId &&
      observation.projectId === fact.projectId && observation.incidentId === fact.incidentId &&
      observation.documentId === fact.documentId && observation.sourceId === fact.sourceId &&
      observation.eventId === fact.eventId && observation.property === fact.property &&
      sameValue(fact.value, observation.value) && observation.valueType === fact.valueType &&
      observation.unit === fact.unit && observation.verificationStatus === "verified" &&
      observation.sourceLocator.recordContentHash === fact.sourceLocator.recordContentHash &&
      observation.sourceLocator.startOffset === fact.sourceLocator.startOffset &&
      observation.sourceLocator.endOffset === fact.sourceLocator.endOffset &&
      observation.sourceLocator.line === fact.sourceLocator.line &&
      JSON.stringify(observation.context) === JSON.stringify(fact.context) &&
      observation.evidenceAlias === aliases.get(fact.evidenceId);
  });
}
