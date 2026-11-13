import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeterministicInvestigation,
  evaluateDeterministicProductGate,
} from "../src/deterministic-investigation.js";
import type { VerifiedFactInventory } from "../src/verified-fact-engine.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const evidenceId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const requestId = "66666666-6666-4666-8666-666666666666";

function inventory(): VerifiedFactInventory {
  const locator = { line: 1, startOffset: 0, endOffset: 120, recordContentHash: "a".repeat(64) };
  const fields = { incident_id: "ALT-100", event: "pool_snapshot", active: 10, max: 10, idle: 0, waiting: 3, retry_count: 0 };
  const record = {
    recordId: "record:event-1", eventId: "event-1", evidenceId, evidenceAlias: "E1", projectId,
    incidentId: "ALT-100", documentId, sourceId, fields, context: { event: "pool_snapshot", timestamp: "2026-01-01T00:00:00Z", service: "orders", incidentRequestId: "req-1" },
    sourceLocator: locator, extractionMethod: "jsonl_record" as const, verificationStatus: "verified" as const,
  };
  return {
    version: "verified-fact-inventory-v1", attestationStatus: "verified", records: [record], contextualArtifacts: [], issues: [],
    facts: Object.entries(fields).map(([property, value], index) => ({
      factId: `fact-${index}`, evidenceId, eventId: "event-1", projectId, incidentId: "ALT-100", documentId, sourceId,
      property, value, valueType: typeof value === "number" ? "number" as const : "string" as const,
      unit: null, context: record.context, sourceLocator: locator, extractionMethod: "jsonl_record" as const, verificationStatus: "verified" as const,
    })),
  };
}

test("deterministic engine preserves zeroes and emits only record-local patterns", () => {
  const result = buildDeterministicInvestigation({
    inventory: inventory(), investigationId: requestId, projectId, incidentId: "ALT-100", requestId, runId,
    generatedAt: "2026-01-01T00:00:00.000Z", mode: "deterministic",
  });
  assert.equal(result.gateResult.status, "pass");
  assert.equal(result.verifiedObservations.find((fact) => fact.property === "idle")?.value, 0);
  assert.ok(result.detectedPatterns.some((pattern) => pattern.ruleId === "capacity-at-limit"));
  assert.ok(result.detectedPatterns.some((pattern) => pattern.ruleId === "no-idle-capacity"));
  assert.ok(result.detectedPatterns.some((pattern) => pattern.ruleId === "operational-waiting"));
  assert.equal(result.hypotheses[0]?.status, "insufficient_evidence");
});

test("deterministic gate rejects altered observations and unsupported pattern links", () => {
  const facts = inventory();
  const result = buildDeterministicInvestigation({
    inventory: facts, investigationId: requestId, projectId, incidentId: "ALT-100", requestId, runId,
    generatedAt: "2026-01-01T00:00:00.000Z", mode: "deterministic",
  });
  const altered = {
    ...result,
    verifiedObservations: result.verifiedObservations.map((fact) => fact.property === "idle" ? { ...fact, value: 1 } : fact),
    detectedPatterns: [...result.detectedPatterns, { ...result.detectedPatterns[0]!, ruleId: "adversarial", matchedFactIds: ["unknown"], evidenceRefs: ["unknown"] }],
  };
  const gate = evaluateDeterministicProductGate({ inventory: facts, result: altered });
  assert.equal(gate.status, "fail");
  assert.ok(gate.reasons.includes("verified_observations_do_not_match_inventory"));
  assert.ok(gate.reasons.some((reason) => reason.startsWith("invalid_pattern_facts:")));
});
