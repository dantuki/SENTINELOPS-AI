
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { buildApp } from "../src/app.js";

const app = buildApp({ logger: false });

after(async () => {
  await app.close();
});

test("GET /health returns the expected response", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "sentinelops-product-api",
  });
});

test("unknown routes return 404", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/route-that-does-not-exist",
  });

  assert.equal(response.statusCode, 404);
});
