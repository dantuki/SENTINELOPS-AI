import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticatedDestination,
  DEFAULT_AUTHENTICATED_DESTINATION,
  loginPathFor,
  safeReturnTo,
} from "../src/lib/auth-redirect.ts";

test("login defaults to QA and preserves only recognized protected destinations", () => {
  assert.equal(authenticatedDestination(null), DEFAULT_AUTHENTICATED_DESTINATION);
  assert.equal(authenticatedDestination("/qa"), "/qa");
  assert.equal(authenticatedDestination("/investigation"), "/investigation");
  assert.equal(authenticatedDestination("/knowledge-base"), "/knowledge-base");
  assert.equal(loginPathFor("/qa"), "/login");
  assert.equal(loginPathFor("/investigation"), "/login?returnTo=%2Finvestigation");
});

test("login returnTo rejects external, malformed, and public destinations", () => {
  for (const value of [
    "https://attacker.example/qa",
    "//attacker.example/qa",
    "\\\\attacker.example\\qa",
    "/qa?returnTo=https://attacker.example",
    "/login",
    "/",
    "/qa/../investigation",
    "/%2f%2fattacker.example",
    " /qa",
    "/qa ",
    "javascript:alert(1)",
  ]) {
    assert.equal(safeReturnTo(value), null, value);
    assert.equal(authenticatedDestination(value), "/qa", value);
  }
});
