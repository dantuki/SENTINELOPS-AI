import assert from "node:assert/strict";
import test from "node:test";

import { isInvestigationRequest } from "../src/lib/investigation-request.ts";

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
