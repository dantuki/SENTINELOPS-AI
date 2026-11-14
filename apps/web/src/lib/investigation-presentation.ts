import { deterministicPatternKey } from "./deterministic-pattern.ts";

export type VerifiedFactValue = string | number | boolean | null;

export interface InvestigationEvidenceReference {
  evidenceId: string;
  alias: string;
}

export interface InvestigationFactContext {
  event: string | null;
  timestamp: string | null;
  service: string | null;
  incidentRequestId: string | null;
}

export interface InvestigationSourceLocator {
  line: number;
  startOffset: number;
  endOffset: number;
  recordContentHash: string;
}

/** A fact as serialized by the verified-fact public result. */
export interface InvestigationObservation {
  factId: string;
  evidenceId: string;
  evidenceAlias: string;
  eventId: string;
  projectId: string;
  incidentId: string;
  documentId: string;
  sourceId: string;
  property: string;
  value: VerifiedFactValue;
  valueType: "string" | "number" | "boolean" | "null";
  unit: string | null;
  context: InvestigationFactContext;
  sourceLocator: InvestigationSourceLocator;
  extractionMethod: "jsonl_record";
  verificationStatus: "verified";
}

export interface InvestigationPattern {
  ruleId: string;
  description: string;
  matchedFactIds: string[];
  evidenceRefs: string[];
}

export interface InvestigationHypothesis {
  statement: string;
  status: "insufficient_evidence";
  missingEvidence: string[];
}

export interface DeterministicInvestigationPresentationInput {
  mode: "deterministic" | "hybrid" | "ai";
  status: "complete" | "partial" | "insufficient_evidence";
  verifiedObservations: InvestigationObservation[];
  detectedPatterns: InvestigationPattern[];
  hypotheses: InvestigationHypothesis[];
  limitations: string[];
  recommendedChecks: string[];
  aiEnrichment: {
    status: "not_requested" | "unavailable" | "invalid" | "validated";
  };
  gateResult: {
    status: "pass" | "fail";
  };
}

export interface InvestigationPresentationIncident {
  reference: string;
  title: string;
  serviceName: string | null;
}

export interface InvestigationPresentationInput {
  incident: InvestigationPresentationIncident;
  evidence: InvestigationEvidenceReference[];
  result: DeterministicInvestigationPresentationInput;
}

export interface PresentationPatternInstance {
  key: string;
  description: string;
  matchedFactIds: string[];
  matchedFacts: InvestigationObservation[];
  missingFactIds: string[];
  evidence: InvestigationEvidenceReference[];
}

export interface PresentationPatternGroup {
  ruleId: string;
  label: string;
  instances: PresentationPatternInstance[];
}

export interface PresentationEventFacts {
  eventId: string;
  context: InvestigationFactContext;
  observations: InvestigationObservation[];
}

export interface InvestigationPresentation {
  incident: InvestigationPresentationIncident;
  evidence: InvestigationEvidenceReference[];
  metadata: {
    mode: DeterministicInvestigationPresentationInput["mode"];
    status: DeterministicInvestigationPresentationInput["status"];
    aiEnrichmentStatus: DeterministicInvestigationPresentationInput["aiEnrichment"]["status"];
    gateStatus: DeterministicInvestigationPresentationInput["gateResult"]["status"];
  };
  summary: {
    text: string;
    evidence: InvestigationEvidenceReference[];
    conditions: string[];
    retrievedEvidenceCount: number;
  };
  indicators: InvestigationObservation[];
  patternGroups: PresentationPatternGroup[];
  eventFacts: PresentationEventFacts[];
  unconfirmed: string[];
  recommendedChecks: string[];
}

const patternLabels: Record<string, string> = {
  "capacity-at-limit": "Capacidad al límite",
  "no-idle-capacity": "Sin capacidad inactiva",
  "operational-waiting": "Elementos en espera",
  "retries-observed": "Reintentos observados",
  "http-5xx-observed": "Respuestas HTTP 5xx",
  "timeout-observed": "Timeouts observados",
};

export function labelForPattern(ruleId: string): string {
  return patternLabels[ruleId] ?? `Patrón observado: ${ruleId}`;
}

export function labelForProperty(property: string): string {
  return property
    .replace(/[_-]+/gu, " ")
    .replace(/^./u, (letter) => letter.toLocaleUpperCase("es-CO"));
}

export function formatObservationValue(
  observation: Pick<InvestigationObservation, "value" | "unit">,
): string {
  const value = observation.value === null ? "null" : String(observation.value);
  return observation.unit ? `${value} ${observation.unit}` : value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function referencesFor(
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, InvestigationEvidenceReference>,
): InvestigationEvidenceReference[] {
  return uniqueStrings(evidenceIds)
    .map((evidenceId) => evidenceById.get(evidenceId))
    .filter((reference): reference is InvestigationEvidenceReference => reference !== undefined);
}

function eventTime(context: InvestigationFactContext): number | null {
  if (!context.timestamp) return null;
  const value = Date.parse(context.timestamp);
  return Number.isFinite(value) ? value : null;
}

function groupFactsByEvent(
  observations: readonly InvestigationObservation[],
): PresentationEventFacts[] {
  const byEvent = new Map<
    string,
    PresentationEventFacts & { firstIndex: number }
  >();

  observations.forEach((observation, index) => {
    const current = byEvent.get(observation.eventId);
    if (current) {
      current.observations.push(observation);
      return;
    }

    byEvent.set(observation.eventId, {
      eventId: observation.eventId,
      context: observation.context,
      observations: [observation],
      firstIndex: index,
    });
  });

  return [...byEvent.values()]
    .sort((first, second) => {
      const firstTime = eventTime(first.context);
      const secondTime = eventTime(second.context);

      if (firstTime !== null && secondTime !== null && firstTime !== secondTime) {
        return firstTime - secondTime;
      }

      return first.firstIndex - second.firstIndex;
    })
    .map(({ firstIndex: _firstIndex, ...event }) => event);
}

/**
 * Creates a deterministic, UI-only organization of the serialized result.
 * It never joins measurements across events or emits a causal conclusion.
 */
export function createInvestigationPresentation(
  input: InvestigationPresentationInput,
): InvestigationPresentation {
  const evidenceById = new Map(
    input.evidence.map((evidence) => [evidence.evidenceId, evidence]),
  );
  const factsById = new Map(
    input.result.verifiedObservations.map((observation) => [
      observation.factId,
      observation,
    ]),
  );
  const patternFactIds = new Set<string>();
  const groups = new Map<string, PresentationPatternGroup>();

  for (const pattern of input.result.detectedPatterns) {
    const matchedFacts = pattern.matchedFactIds.flatMap((factId) => {
      const fact = factsById.get(factId);
      return fact ? [fact] : [];
    });
    const missingFactIds = pattern.matchedFactIds.filter(
      (factId) => !factsById.has(factId),
    );
    const evidence = referencesFor(
      [...pattern.evidenceRefs, ...matchedFacts.map((fact) => fact.evidenceId)],
      evidenceById,
    );
    const instance: PresentationPatternInstance = {
      key: deterministicPatternKey(pattern),
      description: pattern.description,
      matchedFactIds: [...pattern.matchedFactIds],
      matchedFacts,
      missingFactIds,
      evidence,
    };
    const group = groups.get(pattern.ruleId);

    if (group) {
      group.instances.push(instance);
    } else {
      groups.set(pattern.ruleId, {
        ruleId: pattern.ruleId,
        label: labelForPattern(pattern.ruleId),
        instances: [instance],
      });
    }

    for (const factId of pattern.matchedFactIds) {
      patternFactIds.add(factId);
    }
  }

  const indicators = input.result.verifiedObservations.filter(
    (observation) =>
      typeof observation.value === "number" && patternFactIds.has(observation.factId),
  );
  const allReferencedEvidence = referencesFor(
    uniqueStrings([
      ...input.result.verifiedObservations.map((fact) => fact.evidenceId),
      ...input.result.detectedPatterns.flatMap((pattern) => pattern.evidenceRefs),
    ]),
    evidenceById,
  );
  const factCount = input.result.verifiedObservations.length;
  const conditionCount = groups.size;
  const summary = factCount === 0
    ? `No se expusieron hechos verificados para esta investigación; se recuperaron ${input.evidence.length} ${input.evidence.length === 1 ? "evidencia" : "evidencias"}, pero no es posible resumir condiciones observadas.`
    : `Se verificaron ${factCount} ${factCount === 1 ? "hecho" : "hechos"} atestados a partir de ${input.evidence.length} ${input.evidence.length === 1 ? "evidencia recuperada" : "evidencias recuperadas"} y ${conditionCount} ${conditionCount === 1 ? "condición observada" : "condiciones observadas"}. La causa raíz permanece sin confirmar.`;

  return {
    incident: input.incident,
    evidence: input.evidence,
    metadata: {
      mode: input.result.mode,
      status: input.result.status,
      aiEnrichmentStatus: input.result.aiEnrichment.status,
      gateStatus: input.result.gateResult.status,
    },
    summary: {
      text: summary,
      evidence: allReferencedEvidence,
      conditions: [...groups.values()].map((group) => group.label),
      retrievedEvidenceCount: input.evidence.length,
    },
    indicators,
    patternGroups: [...groups.values()],
    eventFacts: groupFactsByEvent(input.result.verifiedObservations),
    unconfirmed: uniqueStrings([
      ...input.result.hypotheses.map((hypothesis) => hypothesis.statement),
      ...input.result.hypotheses.flatMap((hypothesis) => hypothesis.missingEvidence),
      ...input.result.limitations,
    ]),
    recommendedChecks: uniqueStrings(input.result.recommendedChecks),
  };
}
