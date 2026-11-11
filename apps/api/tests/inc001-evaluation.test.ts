import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateInc001Response,
  type Inc001GroundTruth,
} from "../src/inc001-evaluation.js";

const groundTruth: Inc001GroundTruth = {
  expected_observations: [
    { id: "OBS-01" },
    { id: "OBS-02" },
    { id: "OBS-03" },
    { id: "OBS-04" },
    { id: "OBS-05" },
    { id: "OBS-06" },
  ],
  must_not_claim: [],
};

test("INC-001 evaluator measures retrieved facts, answer coverage, and citations", () => {
  const evidence = [
    {
      id: "chunk-1",
      content:
        '{"request_id":"req-7841","attempts":5,"retry_mode":"parallel"}',
    },
    {
      id: "chunk-2",
      content:
        '{"active_connections":20,"idle_connections":0,"waiting_requests":18}',
    },
  ];
  const response =
    "Cinco intentos paralelos comparten req-7841 [E1]. El pool reporta 20 conexiones activas, 0 inactivas y 18 solicitudes en espera [E2].";

  const result = evaluateInc001Response(
    response,
    evidence,
    groundTruth,
  );

  assert.equal(result.retrievalRecall, 2 / 6);
  assert.equal(result.answerCoverage, 2 / 6);
  assert.deepEqual(result.retrievedObservationIds, ["OBS-01", "OBS-02"]);
  assert.deepEqual(result.responseObservationIds, ["OBS-01", "OBS-02"]);
  assert.deepEqual(result.citations, {
    count: 2,
    invalid: [],
  });
  assert.deepEqual(result.factualityViolations, []);
});

test("INC-001 evaluator recognizes all six observations in a complete response", () => {
  const evidence = [
    {
      id: "log-chunk",
      content: [
        '{"request_id":"req-7841","attempts":5,"retry_mode":"parallel"}',
        '{"active_connections":20,"idle_connections":0,"waiting_requests":18}',
        '{"status_code":500,"error":"Timeout acquiring a connection","request_id":"req-7841"}',
        '{"queue_depth":42,"retries_started_last_minute":120}',
        '{"active_connections":20,"waiting_requests":31}',
        '{"service":"payment-gateway","status_code":200,"duration_ms":180}',
      ].join("\n"),
    },
  ];
  const response = [
    "Cinco intentos paralelos comparten req-7841 [E1].",
    "El pool llegó a 20 conexiones activas, cero inactivas y 18 solicitudes esperando [E1].",
    "POST /api/orders devolvió HTTP 500 tras un timeout al adquirir una conexión [E1].",
    "La cola de reintentos alcanzó 42 y registró 120 reintentos iniciados por minuto [E1].",
    "La saturación persistió con 20 conexiones activas y 31 solicitudes esperando [E1].",
    "payment-gateway terminó su solicitud con HTTP 200 en 180 ms [E1].",
  ].join(" ");

  const result = evaluateInc001Response(
    response,
    evidence,
    groundTruth,
  );

  assert.equal(result.retrievalRecall, 1);
  assert.equal(result.answerCoverage, 1);
  assert.deepEqual(result.retrievedObservationIds, [
    "OBS-01",
    "OBS-02",
    "OBS-03",
    "OBS-04",
    "OBS-05",
    "OBS-06",
  ]);
  assert.deepEqual(result.responseObservationIds, [
    "OBS-01",
    "OBS-02",
    "OBS-03",
    "OBS-04",
    "OBS-05",
    "OBS-06",
  ]);
  assert.deepEqual(result.factualityViolations, []);
});

test("INC-001 evaluator recognizes concise paraphrases of all observed values", () => {
  const evidence = [
    {
      id: "log-chunk",
      content: [
        '{"request_id":"req-7841","attempts":5,"retry_mode":"parallel"}',
        '{"active_connections":20,"idle_connections":0,"waiting_requests":18}',
        '{"status_code":500,"error":"Timeout acquiring a connection","request_id":"req-7841"}',
        '{"queue_depth":42,"retries_started_last_minute":120}',
        '{"active_connections":20,"waiting_requests":31}',
        '{"service":"payment-gateway","status_code":200,"duration_ms":180}',
      ].join("\n"),
    },
  ];
  const response = [
    "Cinco intentos paralelos comparten req-7841 [E1].",
    "El pool llegó al máximo (20/20), con cero conexiones libres y 18 solicitudes esperando [E1].",
    "req-7841 agotó el tiempo de espera al adquirir conexión y recibió HTTP 500 [E1].",
    "La cola de reintentos alcanzó 42, con 120 reintentos iniciados por minuto [E1].",
    "La saturación persistió y llegó a 31 solicitudes pendientes [E1].",
    "payment-gateway registró HTTP 200 en 180 ms [E1].",
  ].join(" ");

  const result = evaluateInc001Response(
    response,
    evidence,
    groundTruth,
  );

  assert.equal(result.retrievalRecall, 1);
  assert.equal(result.answerCoverage, 1);
  assert.deepEqual(result.responseObservationIds, [
    "OBS-01",
    "OBS-02",
    "OBS-03",
    "OBS-04",
    "OBS-05",
    "OBS-06",
  ]);
});

test("INC-001 evaluator detects the specified factuality errors", () => {
  const response = [
    "Hay 18 transacciones bloqueadas.",
    "20 conexiones activas están disponibles.",
    "0 conexiones inactivas están ocupadas.",
    "payment-gateway HTTP 200 demuestra que create_order fue exitoso.",
    "El éxito de payment-gateway demuestra que la operación de negocio fue exitosa.",
    "El HTTP 500 confirma el resultado del negocio como fallo total.",
    "La saturación del pool provocó el error HTTP 500.",
    "La saturación del pool ocurrió debido a intentos concurrentes.",
    "La similitud demuestra la causa raíz con probabilidad causal.",
    "El código sintético fue ejecutado en producción.",
    "La coincidencia temporal demuestra la causalidad.",
    "La evidencia citada es [E4].",
  ].join(" ");

  const result = evaluateInc001Response(response, [], groundTruth);

  assert.deepEqual(
    result.factualityViolations.map((violation) => violation.id),
    [
      "waiting-requests-as-blocked-transactions",
      "active-connections-as-available",
      "idle-connections-as-occupied",
      "component-http-200-as-business-success",
      "unsupported-http-500-business-outcome",
      "unproven-pool-root-cause",
      "unproven-retry-causality",
      "similarity-as-causal-probability",
      "synthetic-code-as-production-execution",
      "temporal-coincidence-as-proven-causality",
    ],
  );
  assert.deepEqual(result.citations, {
    count: 1,
    invalid: ["[E4]"],
  });
});

test("INC-001 evaluator does not flag explicit denials of unsupported claims", () => {
  const response = [
    "No hay evidencia de 18 transacciones bloqueadas.",
    "El HTTP 200 de payment-gateway no demuestra que create_order fuera exitoso.",
    "El HTTP 500 no demuestra que la operación completa fallara.",
    "La coincidencia temporal no demuestra causalidad.",
    "El código sintético no se ejecutó en producción.",
    "Hipótesis respaldada, no confirmada: la saturación podría deberse a intentos concurrentes.",
  ].join(" ");

  const result = evaluateInc001Response(response, [], groundTruth);

  assert.deepEqual(result.factualityViolations, []);
});
