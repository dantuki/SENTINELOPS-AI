import assert from "node:assert/strict";
import test from "node:test";

import { isInvestigationRequest } from "../src/lib/investigation-request.ts";
import { messageForInvestigationStatus } from "../src/lib/investigation-error.ts";

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
