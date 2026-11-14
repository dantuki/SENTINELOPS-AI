import assert from "node:assert/strict";
import test from "node:test";

import { deterministicPatternKey } from "../src/lib/deterministic-pattern.ts";
import {
  createDirectedInvestigationView,
  recognizeDirectedQuery,
} from "../src/lib/directed-investigation.ts";
import {
  createInvestigationPresentation,
  labelForProperty,
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
  evidenceId?: string;
  evidenceAlias?: string;
}): InvestigationObservation {
  return {
    factId: input.factId,
    evidenceId: input.evidenceId ?? "evidence-1",
    evidenceAlias: input.evidenceAlias ?? "E1",
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
  evidence = [{ evidenceId: "evidence-1", alias: "E1" }],
) {
  return createInvestigationPresentation({
    incident,
    evidence,
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

test("the contextual summary links only attested facts and retrieved evidence without asserting causality", () => {
  const observations = [
    fact({ factId: "active", eventId: "capacity-event", property: "active_connections", value: 20, timestamp: "2026-01-01T14:03:12.000Z" }),
    fact({ factId: "maximum", eventId: "capacity-event", property: "max_connections", value: 20, timestamp: "2026-01-01T14:03:12.000Z" }),
    fact({ factId: "idle", eventId: "capacity-event", property: "idle_connections", value: 0, timestamp: "2026-01-01T14:03:12.000Z" }),
  ];
  const presentation = presentationFor(deterministicResult({
    observations,
    patterns: [
      {
        ruleId: "capacity-at-limit",
        description: "La capacidad activa observada alcanza o supera el límite en un mismo evento.",
        matchedFactIds: ["active", "maximum"],
        evidenceRefs: ["evidence-1"],
      },
      {
        ruleId: "no-idle-capacity",
        description: "No se observó capacidad inactiva en este evento.",
        matchedFactIds: ["idle"],
        evidenceRefs: ["evidence-1"],
      },
    ],
  }));

  const capacity = presentation.contextualSummary.statements.find(
    (statement) => statement.key === "summary:capacity-at-limit",
  );

  assert.deepEqual(capacity?.factIds, ["active", "maximum"]);
  assert.deepEqual(capacity?.evidence.map((reference) => reference.evidenceId), ["evidence-1"]);
  assert.equal(presentation.contextualSummary.supportingFacts.length, 3);
  assert.match(presentation.contextualSummary.uncertainty, /no determinada/iu);
  assert.doesNotMatch(
    presentation.contextualSummary.statements.map((statement) => statement.text).join(" "),
    /causó|causa raíz confirmada/iu,
  );
});

test("the presentation limits highlighted indicators while preserving every numeric measurement and exact labels", () => {
  const observations = Array.from({ length: 83 }, (_value, index) =>
    fact({
      factId: `fact-${index}`,
      eventId: `event-${index}`,
      property: index === 0 ? "active_connections" : `technical_metric_${index}`,
      value: index === 0 ? 0 : index,
      unit: index === 2 ? "requests/minute" : null,
      timestamp: `2026-01-01T14:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }),
  );
  const patterns: InvestigationPattern[] = Array.from({ length: 12 }, (_value, index) => ({
    ruleId: index % 2 === 0 ? "capacity-at-limit" : "operational-waiting",
    description: "Patrón atestado para comprobar preservación de instancias.",
    matchedFactIds: [`fact-${index}`],
    evidenceRefs: ["evidence-1"],
  }));
  const presentation = presentationFor(deterministicResult({ observations, patterns }));

  assert.equal(presentation.eventFacts.flatMap((event) => event.observations).length, 83);
  assert.equal(
    presentation.patternGroups.reduce((total, group) => total + group.instances.length, 0),
    12,
  );
  assert.equal(presentation.indicators.length, 83);
  assert.equal(presentation.highlightedIndicators.length, 5);
  assert.equal(presentation.highlightedIndicators[0]?.value, 0);
  assert.equal(labelForProperty("active_connections"), "Conexiones activas");
  assert.equal(labelForProperty("technical_metric_12"), "technical_metric_12");
  assert.equal(presentation.indicators[2]?.unit, "requests/minute");
  assert.equal(presentation.indicators[2]?.context.timestamp, "2026-01-01T14:02:00.000Z");
});

test("directed investigation recognition is closed, accent-tolerant, and conservative for ambiguous questions", () => {
  assert.deepEqual(recognizeDirectedQuery("¿Cuál es la cronología?"), {
    intent: "timeline",
    matchedIntents: ["timeline"],
  });
  assert.deepEqual(recognizeDirectedQuery("¿Qué errores HTTP 5xx hubo?"), {
    intent: "errors",
    matchedIntents: ["errors"],
  });
  assert.deepEqual(recognizeDirectedQuery("¿Hubo saturación del pool?"), {
    intent: "capacity",
    matchedIntents: ["capacity"],
  });
  assert.deepEqual(recognizeDirectedQuery("¿Se observaron reintentos?"), {
    intent: "retries",
    matchedIntents: ["retries"],
  });
  assert.deepEqual(recognizeDirectedQuery("¿Qué evidencias y fuentes hay?"), {
    intent: "evidence",
    matchedIntents: ["evidence"],
  });
  assert.deepEqual(recognizeDirectedQuery("¿Cuál fue la causa raíz?"), {
    intent: "unknown",
    matchedIntents: [],
  });
  assert.deepEqual(recognizeDirectedQuery("¿Errores y reintentos?"), {
    intent: "unknown",
    matchedIntents: ["errors", "retries"],
  });
});

test("directed investigation views navigate only facts, events, and evidence already attested", () => {
  const observations = [
    fact({ factId: "status", eventId: "error-event", property: "status_code", value: 503, timestamp: "2026-01-01T14:03:12.000Z" }),
    fact({ factId: "capacity", eventId: "capacity-event", property: "active_connections", value: 20, timestamp: "2026-01-01T14:03:15.000Z" }),
    fact({ factId: "retries", eventId: "retry-event", property: "retries_last_minute", value: 8, timestamp: "2026-01-01T14:03:18.000Z", evidenceId: "evidence-2", evidenceAlias: "E2" }),
  ];
  const presentation = presentationFor(deterministicResult({
    observations,
    patterns: [
      { ruleId: "http-5xx-observed", description: "Se observó HTTP 5xx.", matchedFactIds: ["status"], evidenceRefs: ["evidence-1"] },
      { ruleId: "capacity-at-limit", description: "Se observó capacidad al límite.", matchedFactIds: ["capacity"], evidenceRefs: ["evidence-1"] },
      { ruleId: "retries-observed", description: "Se observaron reintentos.", matchedFactIds: ["retries"], evidenceRefs: ["evidence-2"] },
    ],
  }), undefined, [
    { evidenceId: "evidence-1", alias: "E1" },
    { evidenceId: "evidence-2", alias: "E2" },
  ]);

  const errors = createDirectedInvestigationView(presentation, "¿Qué errores hubo?");
  const capacity = createDirectedInvestigationView(presentation, "¿Hubo saturación del pool?");
  const retries = createDirectedInvestigationView(presentation, "¿Se observaron reintentos?");
  const timeline = createDirectedInvestigationView(presentation, "Ver cronología");
  const ambiguous = createDirectedInvestigationView(presentation, "Errores y reintentos");
  const unknown = createDirectedInvestigationView(presentation, "¿Cuál fue la causa raíz?");

  assert.equal(errors.status, "resolved");
  assert.deepEqual(errors.facts.map((item) => item.factId), ["status"]);
  assert.deepEqual(errors.events.map((item) => item.eventId), ["error-event"]);
  assert.deepEqual(errors.evidence.map((item) => item.evidenceId), ["evidence-1"]);
  assert.deepEqual(capacity.facts.map((item) => item.factId), ["capacity"]);
  assert.deepEqual(retries.facts.map((item) => item.factId), ["retries"]);
  assert.deepEqual(retries.evidence.map((item) => item.alias), ["E2"]);
  assert.equal(timeline.status, "resolved");
  assert.deepEqual(timeline.events.map((item) => item.eventId), ["error-event", "capacity-event", "retry-event"]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(unknown.status, "unknown");
  assert.match(errors.message, /no una conclusión nueva/iu);
});

test("a recognized query without matching facts is explicitly unavailable rather than answered", () => {
  const presentation = presentationFor(deterministicResult({
    observations: [
      fact({ factId: "other", eventId: "event-1", property: "queue_depth", value: 1, timestamp: "2026-01-01T14:03:12.000Z" }),
    ],
  }));

  const view = createDirectedInvestigationView(presentation, "¿Cuál fue la saturación de capacidad?");

  assert.equal(view.status, "unavailable");
  assert.equal(view.facts.length, 0);
  assert.match(view.message, /no contiene hechos atestados suficientes/iu);
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
    assert.equal(
      createDirectedInvestigationView(presentation, "¿Qué evidencias hay?").status,
      "resolved",
    );
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  }
});
