import { createScanner, SyntaxKind } from "typescript/unstable/ast";

import {
  containsEvaluationReference,
  detectFactualityViolations,
  type Inc001GroundTruth,
} from "../src/inc001-evaluation.js";
import type { InvestigationAnalysis } from "../src/investigation-analysis.js";
import type { EvidenceManifestItem } from "../src/retrieval-trace.js";
import type { TraceVerificationReport } from "../src/retrieval-trace-verifier.js";
import {
  extractInc001JsonlEvents,
  type Inc001Event,
} from "./inc001-jsonl-events.js";

export type V2RelationshipStatus = "valid" | "partial" | "invalid" | "not_evaluable";
export type V2ObservationStatus = "complete" | "incomplete" | "not_evaluable" | "blocked";
export type V2ClaimKind = "observed_fact" | "summary" | "hypothesis_support" | "hypothesis_contradiction" | "missing_information" | "recommendation" | "limitation";

interface ObservationDefinition {
  id: string;
  components: readonly string[];
}

/** Dataset-specific requirements, not answer text or a prompt template. */
const OBSERVATIONS: readonly ObservationDefinition[] = [
  { id: "OBS-01", components: ["request:req-7841", "operation:create_order", "attempts:5", "parallel"] },
  { id: "OBS-02", components: ["pool-active:20", "pool-max:20", "pool-idle:0", "pool-waiting:18"] },
  { id: "OBS-03", components: ["request:req-7841", "path:POST:/api/orders", "http:500", "pool-timeout"] },
  { id: "OBS-04", components: ["retry-queue:42", "retries-minute:120"] },
  { id: "OBS-05", components: ["pool-persistent", "pool-active:20", "pool-idle:0", "pool-waiting:31"] },
  { id: "OBS-06", components: ["service:payment-gateway", "http:200", "duration-ms:180"] },
] as const;

export interface V2Claim {
  id: string;
  kind: V2ClaimKind;
  text: string;
  references: string[];
  components: string[];
  factual: boolean;
}

export interface V2ClaimEvidenceRelationship {
  claimId: string;
  referenceOccurrence: number;
  evidenceAlias: string;
  evidenceId: string | null;
  observationIds: string[];
  status: V2RelationshipStatus;
  provenance: "verified" | "failed" | "unverified";
  evidenceComponents: string[];
  supportedComponents: string[];
  contextualOnly: boolean;
  reasons: string[];
}

export interface V2ObservationResult {
  id: string;
  requiredComponents: string[];
  recoveredComponents: string[];
  coveredComponents: string[];
  missingRecoveredComponents: string[];
  missingCoveredComponents: string[];
  claimIds: string[];
  evidenceIds: string[];
  contexts: string[];
  contradictions: string[];
  status: V2ObservationStatus;
}

export interface Inc001EvaluationV2 {
  version: "inc001-evaluation-v2";
  evidenceInventory: Array<{
    alias: string;
    evidenceId: string;
    contentHash: string;
    scope: string;
    verification: "verified" | "failed" | "unverified";
    metadata: Record<string, unknown> | null;
    temporalLimitation: string;
  }>;
  claims: V2Claim[];
  claimEvidenceMatrix: V2ClaimEvidenceRelationship[];
  observationMatrix: V2ObservationResult[];
  metrics: {
    retrievalRecall: number;
    answerCoverage: number;
    citationValidity: { valid: number; partial: number; invalid: number; notEvaluable: number };
    claimSupport: { supported: number; partiallySupported: number; unsupported: number; contradicted: number; unverified: number; contextual: number; notEvaluable: number };
    factualityViolations: string[];
    contradictions: string[];
    abstained: boolean;
    referenceLeaked: boolean;
    provenanceStatus: "verified" | "failed" | "unverified";
  };
  accepted: boolean;
}

function textHas(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

function componentsInText(text: string): Set<string> {
  const found = new Set<string>();
  if (textHas(text, /\breq-7841\b/iu)) found.add("request:req-7841");
  if (textHas(text, /\bcreate[_ ]order\b/iu)) found.add("operation:create_order");
  if (textHas(text, /\b(?:5|five|cinco)\s+(?:parallel\w*\s+)?(?:attempts?|intentos?)\b/iu)) found.add("attempts:5");
  if (textHas(text, /\b(?:parallel|paralel\w*|concurrent\w*)\b/iu)) found.add("parallel");
  if (textHas(text, /(?:active_connections\D{0,12}20|20\s+(?:active\s+)?connections|20\s+conexiones\s+activas)/iu)) found.add("pool-active:20");
  if (textHas(text, /(?:max_connections\D{0,12}20|20\s*\/\s*20|maximum\s+of\s+20|m[aá]ximo\s+de\s+20)/iu)) found.add("pool-max:20");
  if (textHas(text, /(?:idle_connections\D{0,12}0|(?:zero|0|cero|ninguna)\s+(?:idle|free|inactivas|libres))/iu)) found.add("pool-idle:0");
  if (textHas(text, /(?:waiting_requests\D{0,12}18|18\s+(?:waiting\s+requests|solicitudes\s+(?:en espera|esperando)))/iu)) found.add("pool-waiting:18");
  if (textHas(text, /(?:waiting_requests\D{0,12}31|31\s+(?:waiting\s+requests|solicitudes\s+(?:en espera|esperando)))/iu)) found.add("pool-waiting:31");
  if (textHas(text, /\b(?:persist\w*|remained\s+saturated|permaneci[oó]\s+saturad\w*)\b/iu)) found.add("pool-persistent");
  if (textHas(text, /\bPOST\s+\/api\/orders\b/iu)) found.add("path:POST:/api/orders");
  if (textHas(text, /(?:HTTP\s*500|status_code\D{0,12}500)/iu)) found.add("http:500");
  if (textHas(text, /(?:timeout\s+(?:acquiring|al adquirir).{0,40}(?:PostgreSQL\s+)?pool|pool.{0,40}timeout|(?:agot[oó]\s+el\s+)?tiempo\s+de\s+espera\s+al\s+adquirir\s+(?:una\s+)?conexi[oó]n)/iu)) found.add("pool-timeout");
  if (textHas(text, /(?:queue_depth\D{0,12}42|(?:queue|cola).{0,25}\b42\b)/iu)) found.add("retry-queue:42");
  if (textHas(text, /(?:retries_started_last_minute\D{0,12}120|120\s+(?:retries|reintentos).{0,30}(?:minute|minuto))/iu)) found.add("retries-minute:120");
  if (textHas(text, /\bpayment-gateway\b/iu)) found.add("service:payment-gateway");
  if (textHas(text, /(?:HTTP\s*200|status_code\D{0,12}200)/iu)) found.add("http:200");
  if (textHas(text, /(?:duration_ms\D{0,12}180|\b180\s*ms\b|180\s+milisegundos)/iu)) found.add("duration-ms:180");
  return found;
}

function eventComponents(event: Inc001Event): Set<string> {
  const fields = event.fields;
  const parts = componentsInText(JSON.stringify(fields));
  if (fields.event === "parallel_attempts_scheduled") {
    if (fields.request_id === "req-7841") parts.add("request:req-7841");
    if (fields.operation === "create_order") parts.add("operation:create_order");
    if (fields.attempts === 5) parts.add("attempts:5");
    if (fields.retry_mode === "parallel") parts.add("parallel");
  }
  if (fields.event === "connection_pool_saturated") {
    if (fields.active_connections === 20) parts.add("pool-active:20");
    if (fields.max_connections === 20) parts.add("pool-max:20");
    if (fields.idle_connections === 0) parts.add("pool-idle:0");
    if (fields.waiting_requests === 18) parts.add("pool-waiting:18");
    if (fields.waiting_requests === 31) {
      parts.add("pool-waiting:31");
      if (typeof fields.message === "string" && /persist/iu.test(fields.message)) parts.add("pool-persistent");
    }
  }
  if (fields.event === "request_failed") {
    if (fields.request_id === "req-7841") parts.add("request:req-7841");
    if (fields.method === "POST" && fields.path === "/api/orders") parts.add("path:POST:/api/orders");
    if (fields.status_code === 500) parts.add("http:500");
    if (typeof fields.error === "string" && /timeout.+(?:connection|pool)/iu.test(fields.error)) parts.add("pool-timeout");
  }
  if (fields.event === "retry_queue_growing") {
    if (fields.queue_depth === 42) parts.add("retry-queue:42");
    if (fields.retries_started_last_minute === 120) parts.add("retries-minute:120");
  }
  if (fields.event === "payment_request_completed") {
    if (fields.service === "payment-gateway") parts.add("service:payment-gateway");
    if (fields.status_code === 200) parts.add("http:200");
    if (fields.duration_ms === 180) parts.add("duration-ms:180");
  }
  return parts;
}

function staticCodeComponents(content: string): Set<string> {
  // TypeScript 7 exposes a supported token scanner rather than its former
  // compiler parser.  Token relationships below deliberately verify the
  // declaration and call structure; an extension or source filename alone is
  // never evidence of static behaviour.
  const scanner = createScanner(true, undefined, content);
  const tokens: string[] = [];
  for (;;) {
    const kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) break;
    tokens.push(scanner.getTokenValue() || scanner.getTokenText());
  }
  const tokenSequence = (parts: string[]): boolean => {
    let cursor = 0;
    for (const part of parts) {
      const found = tokens.indexOf(part, cursor);
      if (found === -1) return false;
      cursor = found + 1;
    }
    return true;
  };
  const constantFive = tokenSequence(["MAX_PARALLEL_ATTEMPTS", "=", "5"]);
  const createsUsingConstant = tokenSequence(["Array", ".", "from"]) && tokens.includes("MAX_PARALLEL_ATTEMPTS");
  const promiseAll = tokenSequence(["Promise", ".", "all"]);
  const components = new Set<string>();
  if (constantFive && createsUsingConstant) components.add("attempts:5");
  if (constantFive && createsUsingConstant && promiseAll) components.add("parallel");
  return components;
}

function buildClaims(analysis: InvestigationAnalysis): V2Claim[] {
  const claims: V2Claim[] = [];
  const add = (id: string, kind: V2ClaimKind, text: string, references: string[], factual: boolean): void => {
    claims.push({ id, kind, text, references, components: [...componentsInText(text)].sort(), factual });
  };
  add("summary:0", "summary", analysis.summary, analysis.summary_evidence_refs, true);
  analysis.observed_facts.forEach((fact, index) => add(`fact:${index}`, "observed_fact", fact.claim, fact.evidence_refs, true));
  analysis.hypotheses.forEach((hypothesis, index) => {
    add(`hypothesis:${index}:support`, "hypothesis_support", hypothesis.statement, hypothesis.supporting_evidence, true);
    if (hypothesis.contradicting_evidence.length > 0) add(`hypothesis:${index}:contradiction`, "hypothesis_contradiction", hypothesis.statement, hypothesis.contradicting_evidence, true);
  });
  analysis.missing_information.forEach((text, index) => add(`missing-information:${index}`, "missing_information", text, [], false));
  analysis.next_checks.forEach((text, index) => add(`next-check:${index}`, "recommendation", text, [], /\b(?:was|were|is|are|fue|son|es|registr|HTTP|\d)\b/iu.test(text)));
  analysis.limitations.forEach((text, index) => add(`limitation:${index}`, "limitation", text, [], false));
  return claims;
}

function belongsTo(definition: ObservationDefinition, components: Set<string>): string[] {
  return definition.components.filter((component) => components.has(component));
}

function factualClaimWithoutObservedComponent(claim: V2Claim): boolean {
  return claim.factual && claim.components.length === 0 && claim.kind !== "limitation" && claim.kind !== "recommendation";
}

export function evaluateInc001V2(input: {
  response: string;
  analysis: InvestigationAnalysis;
  manifest: EvidenceManifestItem[];
  trace: TraceVerificationReport;
  groundTruth: Inc001GroundTruth;
}): Inc001EvaluationV2 {
  const traceVerified = input.trace.status === "verified" && input.trace.verificationErrors.length === 0;
  const verificationById = new Map(input.trace.evidence.map((item) => [item.evidenceId, item]));
  const claims = buildClaims(input.analysis);
  const evidenceComponents = new Map<string, Set<string>>();
  const evidenceComponentGroups = new Map<string, Set<string>[]>();
  const evidenceContexts = new Map<string, string[]>();

  for (const item of input.manifest) {
    const verification = verificationById.get(item.evidenceId);
    const usable = traceVerified && verification?.status === "verified" && verification.attestation?.hashesMatch === true && verification.attestation.contentMatchesManifest === true;
    const components = new Set<string>();
    const groups: Set<string>[] = [];
    const contexts: string[] = [];
    if (usable && item.evidenceScope === "incident_specific" && item.incidentId === "INC-001") {
      try {
        const extraction = extractInc001JsonlEvents(item, input.trace, {
          runId: item.runId, retrievalRequestId: item.requestId, projectId: item.projectId, incidentId: "INC-001", retrievedAt: item.retrievedAt,
        });
        for (const event of extraction.events) {
          const eventParts = eventComponents(event);
          for (const component of eventParts) components.add(component);
          groups.push(eventParts);
          contexts.push(`event:${event.id}`);
        }
      } catch {
        // A non-JSONL chunk may still be statically evaluable code below.
      }
      const attested = verification?.attestation;
      const isTypeScript = attested?.metadata.sourceDocumentKey?.endsWith(".ts") || attested?.metadata.documentTitle?.endsWith(".ts");
      if (isTypeScript) {
        const staticParts = staticCodeComponents(item.content);
        for (const component of staticParts) components.add(component);
        if (staticParts.size > 0) {
          groups.push(staticParts);
          contexts.push(`static-code:${item.evidenceId}`);
        }
      }
    }
    evidenceComponents.set(item.evidenceId, components);
    evidenceComponentGroups.set(item.evidenceId, groups);
    evidenceContexts.set(item.evidenceId, contexts);
  }

  const byAlias = new Map(input.manifest.map((item) => [item.alias, item]));
  const relationships: V2ClaimEvidenceRelationship[] = [];
  claims.forEach((claim) => claim.references.forEach((alias, occurrence) => {
    const evidence = byAlias.get(alias);
    const verification = evidence ? verificationById.get(evidence.evidenceId) : undefined;
    const evidenceParts = evidence ? evidenceComponents.get(evidence.evidenceId) ?? new Set<string>() : new Set<string>();
    const groups = evidence ? evidenceComponentGroups.get(evidence.evidenceId) ?? [] : [];
    const supported = groups
      .map((group) => [...group].filter((component) => claim.components.includes(component)))
      .sort((left, right) => right.length - left.length)[0] ?? [];
    const observationIds = OBSERVATIONS.filter((definition) => supported.some((component) => definition.components.includes(component))).map(({ id }) => id);
    const contextualOnly = evidence !== undefined && evidenceContexts.get(evidence.evidenceId)?.some((context) => context.startsWith("static-code:")) === true;
    const reasons: string[] = [];
    let status: V2RelationshipStatus = "invalid";
    let provenance: "verified" | "failed" | "unverified" = verification?.status ?? "unverified";
    if (!evidence) reasons.push("alias_not_found");
    else if (!traceVerified || verification?.status !== "verified" || !verification.attestation?.hashesMatch || !verification.attestation.contentMatchesManifest) {
      status = "not_evaluable";
      provenance = verification?.status ?? "unverified";
      reasons.push("provenance_not_usable");
    } else if (evidence.evidenceScope !== "incident_specific" || evidence.incidentId !== "INC-001") {
      status = "invalid";
      reasons.push("scope_not_incident_specific");
    } else if (supported.length === 0 || observationIds.length === 0) {
      status = "invalid";
      reasons.push("evidence_irrelevant_to_claim_occurrence");
    } else if (contextualOnly && /(?:production|producci[oó]n|deployed|desplegad|executed|ejecutad|caus[aoó]|root cause|causa ra[ií]z)/iu.test(claim.text)) {
      status = "invalid";
      reasons.push("static_code_does_not_prove_execution_or_causality");
    } else if (supported.length < claim.components.length) {
      status = "partial";
      reasons.push("evidence_supports_only_some_claim_components");
    } else {
      status = "valid";
      if (contextualOnly) reasons.push("static_configuration_only");
    }
    relationships.push({ claimId: claim.id, referenceOccurrence: occurrence, evidenceAlias: alias, evidenceId: evidence?.evidenceId ?? null, observationIds, status, provenance, evidenceComponents: [...evidenceParts].sort(), supportedComponents: supported.sort(), contextualOnly, reasons });
  }));

  const observationMatrix = OBSERVATIONS.map((definition) => {
    const recoveredEvidence = input.manifest.filter((item) => [...(evidenceComponents.get(item.evidenceId) ?? [])].some((component) => definition.components.includes(component)));
    const recovered = new Set(recoveredEvidence.flatMap((item) => [...(evidenceComponents.get(item.evidenceId) ?? [])].filter((component) => definition.components.includes(component))));
    const validRelationships = relationships.filter((relationship) => relationship.status === "valid" || relationship.status === "partial");
    const covered = new Set(validRelationships.filter((relationship) => relationship.observationIds.includes(definition.id)).flatMap((relationship) => relationship.supportedComponents.filter((component) => definition.components.includes(component))));
    const claimIds = [...new Set(validRelationships.filter((relationship) => relationship.observationIds.includes(definition.id)).map(({ claimId }) => claimId))];
    const evidenceIds = [...new Set(recoveredEvidence.map(({ evidenceId }) => evidenceId))];
    const contexts = [...new Set(recoveredEvidence.flatMap((item) => evidenceContexts.get(item.evidenceId) ?? []))];
    const missingRecovered = definition.components.filter((component) => !recovered.has(component));
    const missingCovered = definition.components.filter((component) => !covered.has(component));
    const contradictions: string[] = [];
    if (definition.id === "OBS-05" && covered.has("pool-waiting:18")) contradictions.push("OBS-02 waiting measurement cannot complete OBS-05");
    const status: V2ObservationStatus = !traceVerified ? "blocked" : missingRecovered.length > 0 ? "not_evaluable" : missingCovered.length > 0 ? "incomplete" : "complete";
    return { id: definition.id, requiredComponents: [...definition.components], recoveredComponents: [...recovered].sort(), coveredComponents: [...covered].sort(), missingRecoveredComponents: missingRecovered, missingCoveredComponents: missingCovered, claimIds, evidenceIds, contexts, contradictions, status };
  });

  const citationValidity = { valid: 0, partial: 0, invalid: 0, notEvaluable: 0 };
  for (const relationship of relationships) {
    if (relationship.status === "valid") citationValidity.valid += 1;
    else if (relationship.status === "partial") citationValidity.partial += 1;
    else if (relationship.status === "not_evaluable") citationValidity.notEvaluable += 1;
    else citationValidity.invalid += 1;
  }
  const factsWithoutSupport = claims.filter(factualClaimWithoutObservedComponent).map(({ id }) => id);
  const unsupported = claims.filter((claim) => claim.factual && claim.references.length > 0 && !relationships.some((relationship) => relationship.claimId === claim.id && (relationship.status === "valid" || relationship.status === "partial"))).length + factsWithoutSupport.length;
  const partial = claims.filter((claim) => relationships.some((relationship) => relationship.claimId === claim.id && relationship.status === "partial")).length;
  const factualityViolations = detectFactualityViolations(`${input.response}\n${JSON.stringify(input.analysis)}`).map(({ id }) => id);
  const referenceLeaked = containsEvaluationReference(input.manifest.map((item) => ({ id: item.evidenceId, content: item.content })));
  const abstained = input.manifest.length === 0;
  const retrievalComplete = observationMatrix.filter(({ status }) => status !== "not_evaluable" && status !== "blocked").length;
  const coverageComplete = observationMatrix.filter(({ status }) => status === "complete").length;
  const contradictions = observationMatrix.flatMap(({ contradictions: values }) => values);
  const accepted = traceVerified && retrievalComplete === OBSERVATIONS.length && coverageComplete === OBSERVATIONS.length && citationValidity.invalid === 0 && citationValidity.notEvaluable === 0 && unsupported === 0 && factualityViolations.length === 0 && contradictions.length === 0 && !referenceLeaked && !abstained;
  return {
    version: "inc001-evaluation-v2",
    evidenceInventory: input.manifest.map((item) => {
      const verification = verificationById.get(item.evidenceId);
      return { alias: item.alias, evidenceId: item.evidenceId, contentHash: item.contentHash, scope: item.evidenceScope, verification: verification?.status ?? "unverified", metadata: verification?.attestation?.metadata ?? null, temporalLimitation: "Current PostgreSQL rows were compared to the retrieval trace; this is not a historical snapshot or external signature." };
    }),
    claims,
    claimEvidenceMatrix: relationships,
    observationMatrix,
    metrics: {
      retrievalRecall: OBSERVATIONS.length === 0 ? 0 : retrievalComplete / OBSERVATIONS.length,
      answerCoverage: OBSERVATIONS.length === 0 ? 0 : coverageComplete / OBSERVATIONS.length,
      citationValidity,
      claimSupport: { supported: claims.filter((claim) => relationships.some((relationship) => relationship.claimId === claim.id && relationship.status === "valid")).length, partiallySupported: partial, unsupported, contradicted: 0, unverified: traceVerified ? 0 : claims.length, contextual: relationships.filter(({ contextualOnly, status }) => contextualOnly && status === "valid").length, notEvaluable: relationships.filter(({ status }) => status === "not_evaluable").length },
      factualityViolations,
      contradictions,
      abstained,
      referenceLeaked,
      provenanceStatus: traceVerified ? "verified" : input.trace.status,
    },
    accepted,
  };
}
