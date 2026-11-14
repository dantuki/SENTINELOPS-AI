import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPatternKey } from "../src/lib/deterministic-pattern.ts";
import {
  createInvestigationPresentation,
  type DeterministicInvestigationPresentationInput,
  type InvestigationObservation,
  type InvestigationPattern,
} from "../src/lib/investigation-presentation.ts";
import { isInvestigationRequest } from "../src/lib/investigation-request.ts";
import { messageForInvestigationStatus } from "../src/lib/investigation-error.ts";

function fact(input: {
  factId: string;
  eventId: string;
  property: string;
  value: InvestigationObservation["value"];
  unit?: string | null;
  timestamp: string;
  service?: string;
}): InvestigationObservation {
  return {
    factId: input.factId,
    evidenceId: "evidence-1",
    evidenceAlias: "E1",
    eventId: input.eventId,
    projectId: "project-1",
    incidentId: "INC-TEST",
    documentId: "document-1",
    sourceId: "source-1",
    property: input.property,
    value: input.value,
    valueType:
      input.value === null
        ? "null"
        : typeof input.value === "string"
          ? "string"
          : typeof input.value === "number"
            ? "number"
            : "boolean",
    unit: input.unit ?? null,
    context: {
      event: "runtime_snapshot",
      timestamp: input.timestamp,
      service: input.service ?? "orders-api",
      incidentRequestId: null,
    },
    sourceLocator: {
      line: 1,
      startOffset: 0,
      endOffset: 120,
      recordContentHash: `hash-${input.eventId}`,
    },
    extractionMethod: "jsonl_record",
    verificationStatus: "verified",
  };
}

function deterministicResult(input: {
  observations: InvestigationObservation[];
  patterns?: InvestigationPattern[];
}): DeterministicInvestigationPresentationInput {
  return {
    mode: "deterministic",
    status: input.observations.length > 0 ? "complete" : "insufficient_evidence",
    verifiedObservations: input.observations,
    detectedPatterns: input.patterns ?? [],
    hypotheses: [
      {
        statement: "Causa raíz no determinada con la evidencia disponible.",
        status: "insufficient_evidence",
        missingEvidence: ["Trazas adicionales del mismo request_id."],
      },
    ],
    limitations: [
      "Los patrones describen condiciones observadas; no confirman causalidad.",
    ],
    recommendedChecks: ["Revisar trazas del mismo request_id."],
    aiEnrichment: { status: "not_requested" },
    gateResult: { status: "pass" },
  };
}

function presentationFor(
  result: DeterministicInvestigationPresentationInput,
  incident: { reference: string; title: string; serviceName: string | null } = {
    reference: "INC-TEST",
    title: "Incidente de prueba",
    serviceName: "orders-api",
  },
) {
  return createInvestigationPresentation({
    incident,
    evidence: [{ evidenceId: "evidence-1", alias: "E1" }],
    result,
  });
}

test("the investigation proxy accepts each supported mode", () => {
  for (const mode of ["deterministic", "hybrid", "ai"] as const) {
    assert.equal(
      isInvestigationRequest({
        question: "What evidence is available?",
        limit: 10,
        incidentId: "INC-001",
        mode,
      }),
      true,
    );
  }
});

test("the investigation proxy rejects unsupported modes and fields", () => {
  assert.equal(
    isInvestigationRequest({ question: "What evidence is available?", mode: "chat" }),
    false,
  );
  assert.equal(
    isInvestigationRequest({ question: "What evidence is available?", extra: true }),
    false,
  );
});

test("the investigation UI distinguishes server responses from connectivity failures", () => {
  assert.equal(
    messageForInvestigationStatus(503),
    "El servicio de investigación no está disponible temporalmente. Verifica las dependencias locales e inténtalo de nuevo.",
  );
  assert.equal(
    messageForInvestigationStatus(401),
    "Tu sesión ya no es válida. Inicia sesión de nuevo para continuar.",
  );
  assert.equal(
    messageForInvestigationStatus(403),
    "No tienes permiso para investigar este proyecto.",
  );
  assert.equal(
    messageForInvestigationStatus(504), "La investigación tardó demasiado. Puedes reintentarlo.");
});

test("deterministic patterns retain repeated rule instances from distinct facts", () => {
  const patterns = [
    {
      ruleId: "operational-waiting",
      matchedFactIds: ["fact:evidence-1:event-14:waiting_requests"],
      evidenceRefs: ["evidence-1"],
    },
    {
      ruleId: "operational-waiting",
      matchedFactIds: ["fact:evidence-1:event-35:waiting_requests"],
      evidenceRefs: ["evidence-1"],
    },
  ];

  const keys = patterns.map(deterministicPatternKey);

  assert.equal(keys.length, 2);
  assert.equal(new Set(keys).size, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("the presentation preserves attested indicators, zeroes, units, timestamps, and evidence", () => {
  const observations = [
    fact({ factId: "active", eventId: "event-1", property: "active_connections", value: 20, timestamp: "2026-01-01T14:03:12.000Z" }),
    fact({ factId: "maximum", eventId: "event-1", property: "max_connections", value: 20, timestamp: "2026-01-01T14:03:12.000Z" }),
    fact({ factId: "idle", eventId: "event-1", property: "idle_connections", value: 0, timestamp: "2026-01-01T14:03:12.000Z" }),
    fact({ factId: "waiting-1", eventId: "event-1", property: "waiting_requests", value: 18, timestamp: "2026-01-01T14:03:12.000Z" }),
    fact({ factId: "waiting-2", eventId: "event-2", property: "waiting_requests", value: 31, timestamp: "2026-01-01T14:03:18.000Z" }),
    fact({ factId: "queue", eventId: "event-2", property: "queue_depth", value: 42, timestamp: "2026-01-01T14:03:18.000Z" }),
    fact({ factId: "retries", eventId: "event-3", property: "retries_last_minute", value: 120, unit: "requests/minute", timestamp: "2026-01-01T14:03:35.000Z" }),
  ];
  const patterns: InvestigationPattern[] = [
    { ruleId: "capacity-at-limit", description: "La capacidad activa observada alcanza o supera el límite en un mismo evento.", matchedFactIds: ["active", "maximum"], evidenceRefs: ["evidence-1"] },
    { ruleId: "no-idle-capacity", description: "No se observó capacidad inactiva en este evento.", matchedFactIds: ["idle"], evidenceRefs: ["evidence-1"] },
    { ruleId: "operational-waiting", description: "Se observaron solicitudes o elementos en espera en un mismo evento.", matchedFactIds: ["waiting-1"], evidenceRefs: ["evidence-1"] },
    { ruleId: "operational-waiting", description: "Se observaron solicitudes o elementos en espera en un mismo evento.", matchedFactIds: ["waiting-2"], evidenceRefs: ["evidence-1"] },
    { ruleId: "retries-observed", description: "Se observaron reintentos o intentos adicionales.", matchedFactIds: ["retries"], evidenceRefs: ["evidence-1"] },
  ];

  const presentation = presentationFor(deterministicResult({ observations, patterns }));
  const idle = presentation.indicators.find((indicator) => indicator.factId === "idle");
  const retries = presentation.indicators.find((indicator) => indicator.factId === "retries");
  const waiting = presentation.patternGroups.find((group) => group.ruleId === "operational-waiting");

  assert.equal(presentation.eventFacts.flatMap((event) => event.observations).length, observations.length);
  assert.equal(idle?.value, 0);
  assert.equal(idle?.context.timestamp, "2026-01-01T14:03:12.000Z");
  assert.equal(retries?.unit, "requests/minute");
  assert.equal(retries?.evidenceAlias, "E1");
  assert.equal(waiting?.instances.length, 2);
  assert.equal(new Set(waiting?.instances.map((instance) => instance.key)).size, 2);
  assert.match(presentation.summary.text, /causa raíz permanece sin confirmar/iu);
});

test("the presentation does not invent indicators or a causal summary when evidence is insufficient", () => {
  const presentation = presentationFor(
    deterministicResult({ observations: [] }),
    { reference: "INC-OTHER", title: "Incidente sin datos", serviceName: null },
  );

  assert.equal(presentation.indicators.length, 0);
  assert.equal(presentation.patternGroups.length, 0);
  assert.match(presentation.summary.text, /No se expusieron hechos verificados/);
  assert.doesNotMatch(presentation.summary.text, /causó|causa confirmada/iu);
});

test("the presentation keeps event associations in chronological order without joining measurements", () => {
  const later = fact({ factId: "later", eventId: "event-later", property: "queue_depth", value: 31, timestamp: "2026-01-01T14:03:35.000Z" });
  const earlier = fact({ factId: "earlier", eventId: "event-earlier", property: "queue_depth", value: 18, timestamp: "2026-01-01T14:03:12.000Z" });
  const presentation = presentationFor(deterministicResult({ observations: [later, earlier] }));

  assert.deepEqual(
    presentation.eventFacts.map((event) => event.eventId),
    ["event-earlier", "event-later"],
  );
  assert.deepEqual(
    presentation.eventFacts.map((event) => event.observations[0]?.value),
    [18, 31],
  );
});

test("a new result does not retain facts or mode metadata from the previous presentation", () => {
  const first = presentationFor(deterministicResult({
    observations: [fact({ factId: "first", eventId: "first-event", property: "queue_depth", value: 42, timestamp: "2026-01-01T14:03:12.000Z" })],
  }));
  const second = presentationFor({
    ...deterministicResult({ observations: [] }),
    mode: "hybrid",
  });

  assert.equal(first.eventFacts.length, 1);
  assert.equal(second.eventFacts.length, 0);
  assert.equal(second.indicators.length, 0);
  assert.equal(second.metadata.mode, "hybrid");
});

test("the presentation remains incident-agnostic and has no network side effects", () => {
  const observation = fact({
    factId: "cache-hit",
    eventId: "cache-event",
    property: "cache_hits",
    value: 7,
    timestamp: "2026-01-03T10:00:00.000Z",
    service: "cache-api",
  });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => {
      calls += 1;
      throw new Error("The presentation layer must not fetch data.");
    },
  });

  try {
    const presentation = presentationFor(
      deterministicResult({ observations: [observation] }),
      { reference: "INC-CACHE", title: "Disponibilidad de caché", serviceName: "cache-api" },
    );

    assert.equal(presentation.incident.title, "Disponibilidad de caché");
    assert.equal(presentation.eventFacts[0]?.context.service, "cache-api");
    assert.doesNotMatch(presentation.summary.text, /pedidos|postgresql/iu);
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});
