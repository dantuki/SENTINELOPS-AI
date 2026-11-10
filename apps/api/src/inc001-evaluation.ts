import type { InvestigationAnalysis } from "./investigation-analysis.js";
import type { EvidenceManifestItem } from "./retrieval-trace.js";
import type { EvidenceAttestationV2 } from "./retrieval-trace-verifier.js";

export interface Inc001Evidence {
  id: string;
  content: string;
  alias?: string;
  evidenceScope?: "incident_specific" | "project_context" | "other_incident" | "unknown_scope";
}

export interface Inc001Observation {
  id: string;
  /** Optional only for legacy unit fixtures; parseInc001GroundTruth always supplies these. */
  description?: string;
  source?: string;
  supporting_log?: string;
  timestamp_utc?: string;
  request_id?: string;
}

export interface Inc001GroundTruth {
  expected_observations: Inc001Observation[];
  classification?: "synthetic_evaluation_reference";
  ingestion_policy?: "evaluation_only_do_not_ingest";
  best_supported_hypothesis?: {
    statement: string;
    classification: "supported_hypothesis_not_proven_root_cause";
    supporting_observations: string[];
    limitations: string[];
  };
  must_not_claim: string[];
  evaluation_rubric?: string[];
}

export interface Inc001EvaluationReference extends Inc001GroundTruth {
  dataset: string;
  incident_id: "INC-001";
}

export interface FactualityViolation {
  id: string;
  description: string;
}

export interface Inc001Evaluation {
  retrievalRecall: number;
  answerCoverage: number;
  retrievedObservationIds: string[];
  responseObservationIds: string[];
  citations: {
    count: number;
    invalid: string[];
  };
  factualityViolations: FactualityViolation[];
}

export type EvidenceProvenanceStatus = "verified" | "unverified" | "failed";
export type ClaimSupportStatus =
  | "supported"
  | "partially_supported"
  | "unsupported"
  | "contradicted"
  | "unverified";

export interface ClaimEvidenceMapping {
  observationId: string;
  claimText: string | null;
  evidenceRefs: string[];
  canonicalEvidenceIds: string[];
  evidenceScope: Array<EvidenceManifestItem["evidenceScope"]>;
  provenanceStatus: EvidenceProvenanceStatus;
  supportStatus: ClaimSupportStatus;
}

export interface Inc001VerifiedEvaluation extends Inc001Evaluation {
  claimEvidenceMappings: ClaimEvidenceMapping[];
  unsupportedClaims: string[];
  contradictedClaims: string[];
  verifiedEvidence: string[];
}

export interface EvidenceVerificationStatus {
  evidenceId: string;
  status: EvidenceProvenanceStatus;
  /** Present for V2 SQL verification; absent only in legacy test/report data. */
  attestation?: EvidenceAttestationV2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseInc001GroundTruth(
  value: unknown,
): Inc001EvaluationReference {
  if (
    !isRecord(value) ||
    typeof value.dataset !== "string" ||
    value.incident_id !== "INC-001" ||
    !Array.isArray(value.expected_observations) ||
    !Array.isArray(value.must_not_claim)
  ) {
    throw new Error("INC-001 evaluation reference has an invalid shape.");
  }

  const expectedObservations: Inc001Observation[] = [];
  for (const observation of value.expected_observations) {
    if (
      !isRecord(observation) ||
      typeof observation.id !== "string" ||
      observation.id.length === 0 ||
      typeof observation.description !== "string" ||
      typeof observation.source !== "string" ||
      (observation.supporting_log !== undefined && typeof observation.supporting_log !== "string") ||
      (observation.timestamp_utc !== undefined && typeof observation.timestamp_utc !== "string") ||
      (observation.request_id !== undefined && typeof observation.request_id !== "string")
    ) {
      throw new Error("INC-001 observation reference has an invalid shape.");
    }
    expectedObservations.push({
      id: observation.id, description: observation.description, source: observation.source,
      ...(typeof observation.supporting_log === "string" ? { supporting_log: observation.supporting_log } : {}),
      ...(typeof observation.timestamp_utc === "string" ? { timestamp_utc: observation.timestamp_utc } : {}),
      ...(typeof observation.request_id === "string" ? { request_id: observation.request_id } : {}),
    });
  }

  if (
    new Set(expectedObservations.map(({ id }) => id)).size !==
    expectedObservations.length
  ) {
    throw new Error("INC-001 observation references must be unique.");
  }

  const mustNotClaim: string[] = [];
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
    ...(value.classification === "synthetic_evaluation_reference" ? { classification: value.classification } : {}),
    ...(value.ingestion_policy === "evaluation_only_do_not_ingest" ? { ingestion_policy: value.ingestion_policy } : {}),
    ...(Array.isArray(value.evaluation_rubric) && value.evaluation_rubric.every((item) => typeof item === "string") ? { evaluation_rubric: value.evaluation_rubric } : {}),
  };
}

export function containsEvaluationReference(
  evidence: Inc001Evidence[],
): boolean {
  const markers = [
    "synthetic_evaluation_reference",
    "evaluation_only_do_not_ingest",
    "best_supported_hypothesis",
  ];
  return evidence.some((item) =>
    markers.some((marker) => item.content.includes(marker)),
  );
}

const observationPatterns: Record<string, RegExp> = {
  "OBS-01":
    /req-7841[\s\S]{0,180}\b(?:5|five|cinco)\b[\s\S]{0,100}\b(?:parallel|paralel\w*|concurrent\w*)\b|\b(?:5|five|cinco)\b[\s\S]{0,100}\b(?:parallel|paralel\w*|concurrent\w*)\b[\s\S]{0,180}req-7841/iu,
  "OBS-02":
    /active_connections["'\s:=]+20[\s\S]{0,120}idle_connections["'\s:=]+0[\s\S]{0,120}waiting_requests["'\s:=]+18|20\s+active connections[\s\S]{0,100}0\s+idle connections[\s\S]{0,100}18\s+waiting requests|20\s+conexiones activas[\s\S]{0,100}(?:0|cero)\s+(?:conexiones )?inactivas[\s\S]{0,100}18\s+solicitudes (?:en espera|esperando)|20\/20[\s\S]{0,100}(?:0|cero)\s+conexiones libres[\s\S]{0,100}18\s+solicitudes (?:en espera|esperando|pendientes)|20\/20[\s\S]{0,100}18\s+solicitudes (?:en espera|esperando|pendientes)[\s\S]{0,400}(?:idle_connections["'\s:=]+0|0\s+conexiones libres)|active["'\s:=]+20[\s\S]{0,60}idle["'\s:=]+0[\s\S]{0,60}waiting["'\s:=]+18/iu,
  "OBS-03":
    /(?:status_code["'\s:=]+500|http\s*500|http 500)[\s\S]{0,180}(?:timeout|tiempo de espera)[\s\S]{0,180}(?:req-7841|\/api\/orders)|(?:req-7841|\/api\/orders)[\s\S]{0,180}(?:status_code["'\s:=]+500|http\s*500)[\s\S]{0,180}(?:timeout|tiempo de espera)|(?:req-7841|\/api\/orders)[\s\S]{0,220}(?:timeout|tiempo de espera)[\s\S]{0,180}(?:status_code["'\s:=]+500|http\s*500)|(?:req-7841|\/api\/orders)[\s\S]{0,220}(?:timeout|tiempo de espera)[\s\S]{0,220}(?:status_code["'\s:=]+500|http\s*500|http 500)/iu,
  "OBS-04":
    /(?:queue_depth["'\s:=]+42|cola[^.!?]{0,80}42)[\s\S]{0,120}(?:retries_started_last_minute["'\s:=]+120|120 reintentos|120 retries)|(?:120 reintentos|120 retries)[\s\S]{0,120}(?:queue_depth["'\s:=]+42|cola[^.!?]{0,80}42)/iu,
  "OBS-05":
    /waiting_requests["'\s:=]+31[\s\S]{0,160}active_connections["'\s:=]+20|active_connections["'\s:=]+20[\s\S]{0,160}waiting_requests["'\s:=]+31|31\s+solicitudes (?:en espera|esperando)[\s\S]{0,100}20\s+conexiones activas|20\s+conexiones activas[\s\S]{0,100}31\s+solicitudes (?:en espera|esperando)|(?:saturaci[oó]n|pool)[\s\S]{0,80}persisti[oó][\s\S]{0,180}31\s+solicitudes (?:en espera|esperando|pendientes)|pool[\s\S]{0,80}permaneci[oó]\s+saturado[\s\S]{0,180}31\s+solicitudes (?:en espera|esperando|pendientes)/iu,
  "OBS-06":
    /payment-gateway[\s\S]{0,120}(?:status_code["'\s:=]+200|http\s*200)[\s\S]{0,80}(?:duration_ms["'\s:=]+180|180\s*ms|180 milisegundos)|(?:status_code["'\s:=]+200|http\s*200)[\s\S]{0,120}payment-gateway[\s\S]{0,80}(?:duration_ms["'\s:=]+180|180\s*ms|180 milisegundos)/iu,
};

const factualityRules: Array<{
  id: string;
  description: string;
  pattern: RegExp;
}> = [
  {
    id: "waiting-requests-as-blocked-transactions",
    description:
      "Interpreta waiting_requests como transacciones bloqueadas.",
    pattern:
      /\b(?:18|31)\s+(?:blocked\s+transactions?|transactions?\s+(?:are\s+)?blocked)\b|\b(?:18|31)\s+transacciones?\s+bloqueadas?\b/iu,
  },
  {
    id: "active-connections-as-available",
    description:
      "Interpreta las conexiones activas como conexiones disponibles.",
    pattern:
      /\bactive_connections["'\s:=]+20\s+(?:are\s+)?(?:available|free)\b|\b20\s+active connections\s+(?:are\s+)?(?:available|free)\b|\b20\s+conexiones activas\s+(?:están\s+)?(?:disponibles|libres)\b/iu,
  },
  {
    id: "idle-connections-as-occupied",
    description:
      "Interpreta las conexiones inactivas como conexiones ocupadas.",
    pattern:
      /\bidle_connections["'\s:=]+0\s+(?:are\s+)?(?:occupied|busy|in use)\b|\b0\s+idle connections\s+(?:are\s+)?(?:occupied|busy|in use)\b|\b0\s+conexiones inactivas\s+(?:están\s+)?(?:ocupadas|en uso)\b/iu,
  },
  {
    id: "component-http-200-as-business-success",
    description:
      "Interpreta el HTTP 200 de payment-gateway como éxito de create_order.",
    pattern:
      /payment-gateway[\s\S]{0,100}(?:http\s*200|status_code["'\s:=]+200)[\s\S]{0,100}(?:demuestra|confirma|garantiza|means|proves)[\s\S]{0,80}(?:create_order|operaci[oó]n de negocio|pedido)[\s\S]{0,60}(?:complet|exitos|successful|succeeded)|(?:create_order|operaci[oó]n de negocio|pedido)[\s\S]{0,80}(?:complet|exitos|successful|succeeded)[\s\S]{0,100}payment-gateway[\s\S]{0,100}(?:http\s*200|status_code["'\s:=]+200)|payment-gateway[\s\S]{0,100}(?:demuestra|confirma|garantiza|means|proves)[\s\S]{0,100}(?:create_order|operaci[oó]n de negocio|pedido)[\s\S]{0,60}(?:complet|exitos|successful|succeeded)/iu,
  },
  {
    id: "unsupported-http-500-business-outcome",
    description:
      "Atribuye el HTTP 500 a payment-gateway o lo presenta como resultado total del negocio.",
    pattern:
      /payment-gateway[\s\S]{0,120}(?:caus[oó]|provoc[oó]|origin[oó]|caused|triggered)[\s\S]{0,100}(?:http\s*500|status_code["'\s:=]+500)|(?:http\s*500|status_code["'\s:=]+500)[\s\S]{0,100}(?:demuestra|confirma|indica|significa|means|proves)[\s\S]{0,100}(?:falla total|fallo total|fracaso total|operaci[oó]n completa|resultado del negocio|complete business failure)/iu,
  },
  {
    id: "unproven-pool-root-cause",
    description:
      "Presenta la saturación del pool como causa definitiva del error HTTP 500.",
    pattern:
      /(?:saturaci[oó]n (?:del|de) (?:pool|conexiones)|pool de conexiones)[\s\S]{0,100}(?:caus[oó]|provoc[oó]|origin[oó]|caused|triggered)[\s\S]{0,120}(?:http\s*500|falla|fallo|error)/iu,
  },
  {
    id: "similarity-as-causal-probability",
    description:
      "Interpreta la similitud de recuperación como probabilidad causal.",
    pattern:
      /(?:similarity|similitud)[\s\S]{0,100}(?:causal probability|probabilidad causal|probabilidad de causa raíz|demuestra la causa raíz|proves the root cause)/iu,
  },
  {
    id: "synthetic-code-as-production-execution",
    description:
      "Afirma que el código sintético se ejecutó o desplegó en producción.",
    pattern:
      /(?:synthetic|sint[eé]tic)[\s\S]{0,100}(?:was executed|was deployed|se ejecut[oó]|se despleg[oó]|fue ejecutado|fue desplegado)[\s\S]{0,80}(?:production|producci[oó]n)|(?:production|producci[oó]n)[\s\S]{0,80}(?:synthetic|sint[eé]tic)[\s\S]{0,100}(?:was executed|was deployed|se ejecut[oó]|se despleg[oó]|fue ejecutado|fue desplegado)/iu,
  },
  {
    id: "temporal-coincidence-as-proven-causality",
    description:
      "Presenta una coincidencia temporal como causalidad demostrada.",
    pattern:
      /(?:temporal coincidence|coincidencia temporal|secuencia temporal)[\s\S]{0,100}(?:demuestra|prueba|confirma|proves|demonstrates)[\s\S]{0,80}(?:causalidad|causality|causa ra[ií]z|root cause)/iu,
  },
];

function isExplicitlyNegated(
  text: string,
  matchIndex: number,
  matchLength: number,
): boolean {
  const start = Math.max(
    text.lastIndexOf(".", matchIndex),
    text.lastIndexOf(";", matchIndex),
    text.lastIndexOf("\n", matchIndex),
    text.lastIndexOf("!", matchIndex),
    text.lastIndexOf("?", matchIndex),
  ) + 1;
  const following = text.slice(matchIndex + matchLength);
  const sentenceEnd = following.search(/[.!?;\n]/u);
  const end =
    sentenceEnd === -1
      ? text.length
      : matchIndex + matchLength + sentenceEnd;
  const sentence = text.slice(start, end);

  return /\bno\b[^.!?]{0,120}\b(?:hay|es|son|demuestra|prueba|confirma|significa|representa|puede|fue|ejecut\w*|despleg\w*)\b|\b(?:not|never|doesn't|does not)\b[^.!?]{0,120}\b(?:available|executed|deployed|prove|demonstrate|mean)\b/iu.test(
    sentence,
  );
}

function matchesUnnegatedClaim(text: string, pattern: RegExp): boolean {
  const match = pattern.exec(text);

  return (
    match !== null &&
    !isExplicitlyNegated(text, match.index, match[0].length)
  );
}

export function detectFactualityViolations(
  text: string,
): FactualityViolation[] {
  return factualityRules
    .filter((rule) => matchesUnnegatedClaim(text, rule.pattern))
    .map(({ id, description }) => ({ id, description }));
}

export function evaluateInc001Response(
  response: string,
  evidence: Inc001Evidence[],
  groundTruth: Inc001GroundTruth,
): Inc001Evaluation {
  const expectedIds = groundTruth.expected_observations.map(
    (observation) => observation.id,
  );
  const retrievedObservationIds = expectedIds.filter((id) => {
    const pattern = observationPatterns[id];
    return (
      pattern !== undefined &&
      evidence.some((item) => pattern.test(item.content))
    );
  });
  const responseObservationIds = expectedIds.filter((id) => {
    const pattern = observationPatterns[id];
    return pattern !== undefined && pattern.test(response);
  });
  const citations = [...response.matchAll(/\[E(\d+)\]/giu)].map(
    (match) => Number(match[1]),
  );
  const invalid = [
    ...new Set(
      citations
        .filter((index) => index < 1 || index > evidence.length)
        .map((index) => `[E${index}]`),
    ),
  ];

  return {
    retrievalRecall:
      expectedIds.length === 0
        ? 0
        : retrievedObservationIds.length / expectedIds.length,
    answerCoverage:
      expectedIds.length === 0
        ? 0
        : responseObservationIds.length / expectedIds.length,
    retrievedObservationIds,
    responseObservationIds,
    citations: {
      count: citations.length,
      invalid,
    },
    factualityViolations: detectFactualityViolations(response),
  };
}

const partialObservationPatterns: Record<string, RegExp> = {
  "OBS-01": /\b(?:5|five|cinco)\b[\s\S]{0,60}\b(?:attempts?|intentos?)\b[\s\S]{0,60}\b(?:parallel|paralel\w*)\b|\b(?:parallel|paralel\w*)\b[\s\S]{0,60}\b(?:5|five|cinco)\b[\s\S]{0,60}\b(?:attempts?|intentos?)\b/iu,
  "OBS-02": /(?:active_connections|20\s*(?:active\s+)?connections?|20\s+conexiones activas)[\s\S]{0,100}(?:idle_connections|0\s+idle|0\s+inactivas|18\s+waiting|18\s+solicitudes)|(?:idle_connections|0\s+idle|0\s+inactivas|18\s+waiting|18\s+solicitudes)[\s\S]{0,100}(?:active_connections|20\s*(?:active\s+)?connections?|20\s+conexiones activas)/iu,
  "OBS-03": /(?:req-7841|\/api\/orders)[\s\S]{0,160}(?:http\s*500|status_code["'\s:=]+500|timeout|tiempo de espera)|(?:http\s*500|status_code["'\s:=]+500|timeout|tiempo de espera)[\s\S]{0,160}(?:req-7841|\/api\/orders)/iu,
  "OBS-04": /(?:queue_depth|cola)[\s\S]{0,100}(?:42|retries_started_last_minute|120\s+(?:retries|reintentos))|(?:42|retries_started_last_minute|120\s+(?:retries|reintentos))[\s\S]{0,100}(?:queue_depth|cola)/iu,
  "OBS-05": /(?:waiting_requests["'\s:=]+31|31\s+solicitudes (?:en espera|esperando|pendientes)|saturaci[oó]n[\s\S]{0,100}(?:persisti[oó]|persistente))|(?:(?:persisti[oó]|persistente)[\s\S]{0,100}31\s+solicitudes)/iu,
  "OBS-06": /payment-gateway[\s\S]{0,120}(?:status_code|http\s*\d{3}|duration_ms|\b\d+\s*ms\b)|(?:status_code|http\s*\d{3}|duration_ms|\b\d+\s*ms\b)[\s\S]{0,120}payment-gateway/iu,
};

const contradictionPatterns: Record<string, RegExp> = {
  "OBS-01": /(?:\b(?:attempts?|intentos?)\s*(?:[:=]\s*)?(?!5\b)\d+\b)|(?:\b(?!5\b)\d+\s+(?:attempts?|intentos?)\b)|(?:req-(?!7841\b)[a-z0-9-]+\b)/iu,
  "OBS-02": /(?:active_connections["'\s:=]+(?!20\b)\d+)|(?:idle_connections["'\s:=]+(?!0\b)\d+)|(?:waiting_requests["'\s:=]+(?!18\b)\d+)|(?:\b(?:pool|conexiones activas)\b[^.!?\n]{0,60}\b(?:19|21)\b)/iu,
  "OBS-03": /(?:\/api\/orders|req-7841)[\s\S]{0,140}(?:http\s*(?!500\b)\d{3}|status_code["'\s:=]+(?!500\b)\d{3})/iu,
  "OBS-04": /(?:queue_depth["'\s:=]+(?!42\b)\d+)|(?:retries_started_last_minute["'\s:=]+(?!120\b)\d+)|(?:\b(?!42\b)\d+\s+(?:items|elementos|requests|solicitudes)\s+(?:in\s+)?(?:the\s+)?queue\b)|(?:\b(?:reintentos|retries)\s*(?:[:=]\s*)?(?!120\b)\d+\b)|(?:\b(?!120\b)\d+\s+(?:reintentos|retries)\b)/iu,
  "OBS-05": /waiting_requests["'\s:=]+(?!31\b)\d+/iu,
  "OBS-06": /payment-gateway[\s\S]{0,100}(?:status_code["'\s:=]+(?!200\b)\d{3}|http\s*(?!200\b)\d{3}|duration_ms["'\s:=]+(?!180\b)\d+|\b(?!180\b)\d+\s*ms)/iu,
};

function matchesVerifiedObservation(
  observationId: string,
  text: string,
  pattern: RegExp,
): boolean {
  if (observationId !== "OBS-05") {
    return pattern.test(text);
  }
  return text.split(/\r?\n/u).some((line) =>
    pattern.test(line) &&
    !/\b(?:no|not|never)\b/iu.test(line) &&
    /\b(?:persist\w*|permaneci[oó]|permanec\w*)\b/iu.test(line) &&
    /\b(?:pool|saturaci[oó]n|saturation)\b/iu.test(line) &&
    /(?:active_connections["'\s:=]+20\b|20\s+(?:conexiones\s+activas|active\s+connections))/iu.test(line) &&
    /(?:idle_connections["'\s:=]+0\b|(?:0|cero|ninguna)\s+(?:conexiones\s+)?(?:inactivas|libres)|(?:0|zero)\s+idle\s+connections)/iu.test(line) &&
    /(?:waiting_requests["'\s:=]+31\b|31\s+(?:solicitudes\s+(?:en espera|esperando|pendientes)|waiting\s+requests))/iu.test(line),
  );
}

export function evaluateInc001VerifiedClaims(
  response: string,
  analysis: InvestigationAnalysis,
  manifest: EvidenceManifestItem[],
  verification: EvidenceVerificationStatus[],
  groundTruth: Inc001GroundTruth,
): Inc001VerifiedEvaluation {
  const expectedIds = groundTruth.expected_observations.map(({ id }) => id);
  const evidenceByAlias = new Map(manifest.map((item) => [item.alias, item]));
  const provenanceById = new Map(
    verification.map(({ evidenceId, status }) => [evidenceId, status]),
  );
  const claims = [
    ...analysis.observed_facts.map(({ claim, evidence_refs }) => ({
      text: claim,
      refs: evidence_refs,
    })),
    {
      text: analysis.summary,
      refs: analysis.summary_evidence_refs,
    },
  ];
  const mappings: ClaimEvidenceMapping[] = [];
  const retrievedObservationIds: string[] = [];
  const responseObservationIds: string[] = [];

  for (const observationId of expectedIds) {
    const pattern = observationPatterns[observationId];
    const partialPattern = partialObservationPatterns[observationId];
    const contradictionPattern = contradictionPatterns[observationId];
    if (!pattern || !partialPattern || !contradictionPattern) {
      continue;
    }

    const verifiedEvidence = manifest.filter(
      (item) =>
        provenanceById.get(item.evidenceId) === "verified" &&
        item.evidenceScope === "incident_specific" &&
        item.incidentId === "INC-001" &&
        matchesVerifiedObservation(observationId, item.content, pattern),
    );
    if (verifiedEvidence.length > 0) {
      retrievedObservationIds.push(observationId);
    }

    const matchingClaims = claims.filter(
      ({ text }) => matchesVerifiedObservation(observationId, text, pattern) || partialPattern.test(text),
    );
    if (matchingClaims.length === 0) {
      mappings.push({
        observationId,
        claimText: null,
        evidenceRefs: [],
        canonicalEvidenceIds: [],
        evidenceScope: [],
        provenanceStatus: "unverified",
        supportStatus: "unsupported",
      });
      continue;
    }

    for (const claim of matchingClaims) {
      const contradicted = contradictionPattern.test(claim.text);
      const referencedEvidence = claim.refs
        .map((alias) => evidenceByAlias.get(alias))
        .filter((item): item is EvidenceManifestItem => item !== undefined);
      const relevantEvidence = referencedEvidence.filter(
        (item) =>
          matchesVerifiedObservation(observationId, item.content, pattern) &&
          item.evidenceScope === "incident_specific" &&
          item.incidentId === "INC-001",
      );
      const verifiedRelevantEvidence = relevantEvidence.filter(
        (item) => provenanceById.get(item.evidenceId) === "verified",
      );
      const uncertainRelevantEvidence = relevantEvidence.filter(
        (item) => provenanceById.get(item.evidenceId) === "unverified",
      );
      const failedRelevantEvidence = relevantEvidence.filter(
        (item) => provenanceById.get(item.evidenceId) === "failed",
      );
      const scope = [
        ...new Set(referencedEvidence.map(({ evidenceScope }) => evidenceScope)),
      ];
      const provenanceStatus: EvidenceProvenanceStatus =
        verifiedRelevantEvidence.length > 0
          ? "verified"
          : failedRelevantEvidence.length > 0
            ? "failed"
            : "unverified";
      const supportStatus: ClaimSupportStatus = contradicted
        ? "contradicted"
        : verifiedRelevantEvidence.length > 0 && matchesVerifiedObservation(observationId, claim.text, pattern)
          ? "supported"
          : uncertainRelevantEvidence.length > 0
            ? "unverified"
            : verifiedRelevantEvidence.length > 0
              ? "partially_supported"
              : "unsupported";

      mappings.push({
        observationId,
        claimText: claim.text,
        evidenceRefs: claim.refs,
        canonicalEvidenceIds: referencedEvidence.map(({ chunkId }) => chunkId),
        evidenceScope: scope,
        provenanceStatus,
        supportStatus,
      });
    }

    if (
      mappings.some(
        (mapping) =>
          mapping.observationId === observationId &&
          mapping.supportStatus === "supported",
      )
    ) {
      responseObservationIds.push(observationId);
    }
  }

  const citationRefs = [
    ...analysis.summary_evidence_refs,
    ...analysis.observed_facts.flatMap(({ evidence_refs }) => evidence_refs),
    ...analysis.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supporting_evidence,
      ...hypothesis.contradicting_evidence,
    ]),
  ];
  const invalidCitations = new Set<string>();
  for (const ref of citationRefs) {
    const evidence = evidenceByAlias.get(ref);
    if (!evidence) {
      invalidCitations.add(`[${ref}]`);
      continue;
    }
    const hasRelevantObservation = mappings.some((mapping) => {
      const pattern = observationPatterns[mapping.observationId];
      return (
        mapping.evidenceRefs.includes(ref) &&
        pattern !== undefined &&
        mapping.claimText !== null &&
        matchesVerifiedObservation(mapping.observationId, mapping.claimText, pattern) &&
        matchesVerifiedObservation(mapping.observationId, evidence.content, pattern) &&
        evidence.evidenceScope === "incident_specific" &&
        evidence.incidentId === "INC-001" &&
        provenanceById.get(evidence.evidenceId) === "verified"
      );
    });
    if (!hasRelevantObservation) {
      invalidCitations.add(`[${ref}]`);
    }
  }

  const unsupportedMappings = mappings.filter(
    ({ supportStatus }) => supportStatus !== "supported",
  );
  const unsupportedClaims = unsupportedMappings.map(
    ({ observationId, claimText, supportStatus }) =>
      `${observationId}: ${claimText ?? "required observation missing"} (${supportStatus})`,
  );
  const contradictedClaims = mappings
    .filter(({ supportStatus }) => supportStatus === "contradicted")
    .map(({ claimText }) => claimText ?? "");
  const factualityViolations = detectFactualityViolations(
    `${response}\n${JSON.stringify(analysis)}`,
  );
  const denominator = expectedIds.length;
  const retrievalRecall =
    denominator === 0 ? 0 : retrievedObservationIds.length / denominator;
  const answerCoverage =
    denominator === 0 ? 0 : responseObservationIds.length / denominator;
  const evaluation: Inc001VerifiedEvaluation = {
    retrievalRecall,
    answerCoverage,
    retrievedObservationIds,
    responseObservationIds,
    citations: {
      count: [...response.matchAll(/\[E([1-9][0-9]*)\]/giu)].length,
      invalid: [...invalidCitations].sort(),
    },
    factualityViolations,
    claimEvidenceMappings: mappings,
    unsupportedClaims,
    contradictedClaims,
    verifiedEvidence: manifest
      .filter(({ evidenceId }) => provenanceById.get(evidenceId) === "verified")
      .map(({ evidenceId }) => evidenceId),
  };
  return evaluation;
}

export function isInc001VerifiedEvaluationAccepted(
  model: string,
  manifest: EvidenceManifestItem[],
  evaluation: Inc001VerifiedEvaluation,
  referenceLeaked: boolean,
): boolean {
  return (
    model !== "not-invoked" &&
    manifest.length > 0 &&
    !referenceLeaked &&
    evaluation.retrievalRecall === 1 &&
    evaluation.answerCoverage === 1 &&
    evaluation.citations.count > 0 &&
    evaluation.citations.invalid.length === 0 &&
    evaluation.factualityViolations.length === 0 &&
    evaluation.unsupportedClaims.length === 0 &&
    evaluation.contradictedClaims.length === 0 &&
    evaluation.claimEvidenceMappings.length >= 6
  );
}

export function isInc001EvaluationAccepted(
  model: string,
  evidence: Inc001Evidence[],
  evaluation: Inc001Evaluation,
): boolean {
  return (
    model !== "not-invoked" &&
    evidence.length > 0 &&
    !containsEvaluationReference(evidence) &&
    evaluation.retrievalRecall === 1 &&
    evaluation.answerCoverage === 1 &&
    evaluation.citations.count > 0 &&
    evaluation.citations.invalid.length === 0 &&
    evaluation.factualityViolations.length === 0
  );
}
