import assert from "node:assert/strict";
import test from "node:test";

import {
  extractVerifiedFacts,
  projectVerifiedFactsForPrompt,
} from "../src/verified-fact-engine.js";
import {
  composeVerifiedInvestigationResult,
  hasCompletePresentedFacts,
} from "../src/verified-investigation-result.js";
import { validateRuntimeObservedFacts } from "../src/investigation-routes.js";
import type { InvestigationAnalysis } from "../src/investigation-analysis.js";
import { hashChunkContent, type EvidenceManifestItem } from "../src/retrieval-trace.js";
import type { TraceVerificationReport } from "../src/retrieval-trace-verifier.js";

const runId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";
const sourceId = "55555555-5555-4555-8555-555555555555";
const chunkId = "66666666-6666-4666-8666-666666666666";
const retrievedAt = "2026-11-10T00:00:00.000Z";

function manifest(content: string, incidentId = "INC-OTHER"): EvidenceManifestItem {
  return {
    evidenceId: chunkId,
    alias: "E1",
    runId,
    requestId,
    projectId,
    incidentId,
    chunkId,
    documentId,
    sourceId,
    ordinal: 0,
    rank: 1,
    score: 0.9,
    content,
    contentHash: hashChunkContent(content),
    evidenceScope: "incident_specific",
    retrievedAt,
  };
}

function verifiedTrace(item: EvidenceManifestItem): TraceVerificationReport {
  return {
    status: "verified",
    verifiedCount: 1,
    unverifiedCount: 0,
    failedCount: 0,
    verificationErrors: [],
    verifiedEvidenceIds: [item.evidenceId],
    runId,
    requestId,
    evidence: [{
      evidenceId: item.evidenceId,
      status: "verified",
      attestation: {
        evidenceId: item.evidenceId,
        chunkId: item.chunkId,
        documentId: item.documentId,
        sourceId: item.sourceId,
        projectId,
        runId,
        retrievalRequestId: requestId,
        requestedIncidentId: item.incidentId,
        rank: 1,
        ordinal: 0,
        expectedContentHash: item.contentHash,
        storedContentHash: item.contentHash,
        recomputedContentHash: item.contentHash,
        contentMatchesManifest: true,
        hashesMatch: true,
        documentMatchesSource: true,
        projectMatches: true,
        documentStatus: "indexed",
        sourceStatus: "active",
        evidenceScope: "incident_specific",
        metadata: {
          documentTitle: "other-incident.jsonl",
          mediaType: "application/x-ndjson",
          sourceDocumentKey: "other/observed.jsonl",
          sourceType: "log_bundle",
          chunkStartOffset: 0,
          chunkEndOffset: item.content.length,
          chunkMetadata: { incidentId: item.incidentId },
          documentMetadata: {},
          sourceMetadata: {},
        },
        errors: [],
      },
    }],
  };
}

function extract(content: string, incidentId = "INC-OTHER") {
  const item = manifest(content, incidentId);
  return extractVerifiedFacts({
    manifest: [item],
    trace: verifiedTrace(item),
    runId,
    requestId,
    projectId,
    incidentId,
  });
}

test("Verified Fact Engine preserves typed JSONL values, zeroes, units and repeated records", () => {
  const content = [
    '{"incident_id":"INC-OTHER","event":"pool","idle_connections":0,"duration_ms":180,"status_code":200,"service":"other-gateway"}',
    '{"incident_id":"INC-OTHER","event":"pool","idle_connections":0,"duration_ms":180,"status_code":200,"service":"other-gateway"}',
  ].join("\n");
  const inventory = extract(content);

  assert.equal(inventory.attestationStatus, "verified");
  assert.equal(inventory.records.length, 2);
  assert.notEqual(inventory.records[0]?.eventId, inventory.records[1]?.eventId);
  assert.equal(inventory.facts.filter(({ property }) => property === "idle_connections").length, 2);
  const idle = inventory.facts.find(({ property }) => property === "idle_connections");
  assert.equal(idle?.value, 0);
  assert.equal(idle?.valueType, "number");
  assert.equal(idle?.unit, null);
  const duration = inventory.facts.find(({ property }) => property === "duration_ms");
  assert.equal(duration?.value, 180);
  assert.equal(duration?.unit, "milliseconds");
  assert.equal(inventory.records[0]?.context.service, "other-gateway");
});

test("Verified Fact Engine keeps incidents and malformed JSON isolated", () => {
  const content = [
    '{"incident_id":"INC-OTHER","request_id":"other-17","queue_depth":9}',
    '{"incident_id":"INC-UNRELATED","queue_depth":99}',
    '{"incident_id":"INC-OTHER",',
  ].join("\n");
  const inventory = extract(content);

  assert.equal(inventory.records.length, 1);
  assert.equal(inventory.records[0]?.context.incidentRequestId, "other-17");
  assert.ok(inventory.issues.some(({ reason }) => reason === "incident_mismatch_or_missing"));
  assert.ok(inventory.issues.some(({ reason }) => reason === "invalid_or_incomplete_json"));
});

test("Verified Fact Engine rejects unattested evidence and never exposes sensitive fields", () => {
  const content = '{"incident_id":"INC-OTHER","password":"do-not-expose","api_key":"also-private","count":1}';
  const inventory = extract(content);
  assert.equal(inventory.facts.some(({ property }) => property === "password"), false);
  assert.equal(inventory.facts.some(({ property }) => property === "api_key"), false);
  assert.ok(inventory.issues.filter(({ reason }) => reason === "sensitive_field_excluded").length === 2);

  const item = manifest(content);
  const trace = verifiedTrace(item);
  trace.status = "failed";
  trace.verificationErrors = ["content_or_hash_mismatch"];
  const rejected = extractVerifiedFacts({ manifest: [item], trace, runId, requestId, projectId, incidentId: "INC-OTHER" });
  assert.equal(rejected.facts.length, 0);
  assert.ok(rejected.issues.some(({ reason }) => reason === "trace_not_verified"));
});

test("Verified Fact Engine classifies TypeScript as contextual static support, not a runtime fact", () => {
  const content = "export const RETRY_LIMIT = 3;";
  const item = manifest(content);
  const trace = verifiedTrace(item);
  trace.evidence[0]!.attestation!.metadata.sourceDocumentKey = "src/retry.ts";
  const inventory = extractVerifiedFacts({ manifest: [item], trace, runId, requestId, projectId, incidentId: "INC-OTHER" });
  assert.equal(inventory.facts.length, 0);
  assert.deepEqual(inventory.contextualArtifacts.map(({ classification }) => classification), ["static_code"]);
});

test("Verified Fact Engine compact projection retains attested event identity and fields without raw content", () => {
  const content = '{"incident_id":"INC-OTHER","event":"pool","idle_connections":0,"duration_ms":180}';
  const inventory = extract(content);
  const compact = projectVerifiedFactsForPrompt(inventory);

  assert.equal(compact.records.length, 1);
  assert.equal(compact.records[0]?.evidenceAlias, "E1");
  assert.equal(compact.records[0]?.fields.idle_connections, 0);
  assert.equal(compact.records[0]?.fields.duration_ms, 180);
  assert.match(compact.records[0]?.eventId ?? "", new RegExp(`^${chunkId}:`));
  assert.equal(compact.records[0]?.sourceLocator.recordContentHash.length, 64);
  assert.equal(compact.records[0]?.eventAlias, "R1");
  assert.deepEqual(compact.records[0]?.properties, [
    { propertyId: "P1_1", property: "idle_connections", value: 0, valueType: "number", unit: null },
    { propertyId: "P1_2", property: "duration_ms", value: 180, valueType: "number", unit: "milliseconds" },
  ]);
  assert.equal(compact.records[0]?.context.event, "pool");
  assert.equal("content" in (compact.records[0] ?? {}), false);
  assert.equal("recordId" in (compact.records[0] ?? {}), false);
});

test("runtime semantic validation binds compact model claims to their own event, values, units, and evidence", () => {
  const inventory = extract([
    '{"incident_id":"INC-OTHER","event":"pool","idle_connections":0,"duration_ms":180,"status_code":200}',
    '{"incident_id":"INC-OTHER","event":"request","request_id":"other-17","status_code":500,"duration_ms":5000}',
  ].join("\n"));
  const projection = projectVerifiedFactsForPrompt(inventory);
  const claimFor = (record: typeof projection.records[number]) => record.properties.map((property) => {
    const unit = property.unit === "milliseconds" ? " ms" : property.unit ? ` ${property.unit}` : "";
    return `${property.property}=${String(property.value)}${unit}`;
  }).join("; ");
  const analysis: InvestigationAnalysis = {
    summary: "Se registraron dos eventos independientes.", summary_evidence_refs: ["E1"],
    observed_facts: projection.records.map((record) => ({
      event_id: record.eventAlias,
      property_refs: record.properties.map(({ propertyId }) => propertyId),
      claim: claimFor(record), evidence_refs: [record.evidenceAlias],
    })),
    hypotheses: [], missing_information: [], next_checks: [], limitations: [],
  };
  assert.deepEqual(validateRuntimeObservedFacts(analysis, projection.records), []);

  const altered = structuredClone(analysis);
  altered.observed_facts[0]!.claim = altered.observed_facts[0]!.claim.replace("idle_connections=0", "idle_connections=1"); // zero preservation
  altered.observed_facts[0]!.claim = altered.observed_facts[0]!.claim.replace("duration_ms=180 ms", "duration_ms=180"); // unit omission
  altered.observed_facts[1]!.property_refs!.push(altered.observed_facts[0]!.property_refs![0]!); // foreign event ID
  altered.observed_facts[1]!.evidence_refs = ["E9"]; // irrelevant citation
  altered.observed_facts[1]!.claim = "Este evento causó el incidente."; // causal language as fact
  const codes = validateRuntimeObservedFacts(altered, projection.records).map(({ code }) => code);
  assert.ok(codes.includes("property_not_expressed"));
  assert.ok(codes.includes("property_unit_not_expressed"));
  assert.ok(codes.includes("property_not_in_event"));
  assert.ok(codes.includes("irrelevant_citation"));
  assert.ok(codes.includes("causal_language_in_observed_fact"));

  const compact = structuredClone(analysis);
  compact.observed_facts[0]!.property_refs = [compact.observed_facts[0]!.property_refs![0]!];
  compact.observed_facts[0]!.claim = "idle_connections=0";
  assert.deepEqual(validateRuntimeObservedFacts(compact, projection.records), []);

  const duplicate = structuredClone(analysis);
  duplicate.observed_facts[0]!.property_refs!.push(duplicate.observed_facts[0]!.property_refs![0]!);
  assert.ok(validateRuntimeObservedFacts(duplicate, projection.records).some(({ code }) => code === "duplicate_property_reference"));
});

test("public verified result preserves zeroes and refuses altered project facts", () => {
  const inventory = extract('{"incident_id":"INC-OTHER","event":"pool","idle_connections":0,"status_code":500,"duration_ms":180}');
  const result = composeVerifiedInvestigationResult({
    inventory,
    analysis: null,
    analysisStatus: "invalid",
    failure: "contract_invalid",
  });
  assert.equal(result.aiAnalysis.status, "invalid");
  assert.equal(result.verifiedObservations.find(({ property }) => property === "idle_connections")?.value, 0);
  assert.equal(result.verifiedObservations.find(({ property }) => property === "status_code")?.value, 500);
  assert.equal(result.verifiedObservations.find(({ property }) => property === "duration_ms")?.unit, "milliseconds");
  assert.equal(hasCompletePresentedFacts(inventory, result), true);

  result.verifiedObservations[0]!.projectId = "other-project";
  assert.equal(hasCompletePresentedFacts(inventory, result), false);

  result.verifiedObservations[0]!.projectId = projectId;
  result.verifiedObservations[0]!.evidenceAlias = "E999";
  assert.equal(hasCompletePresentedFacts(inventory, result), false);
});

test("public verified result rejects duplicate identities and malformed serialized data", () => {
  const inventory = extract('{"incident_id":"INC-OTHER","event":"pool","idle_connections":0,"duration_ms":180}');
  const result = composeVerifiedInvestigationResult({ inventory, analysis: null, analysisStatus: "invalid" });
  result.verifiedObservations[1] = { ...result.verifiedObservations[0]! };
  assert.equal(hasCompletePresentedFacts(inventory, result), false);
  assert.equal(hasCompletePresentedFacts(inventory, { version: "verified-investigation-result-v1" }), false);
});
