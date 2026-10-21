
import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";

const apps: FastifyInstance[] = [];

function createTestApp(
  options: Parameters<typeof buildApp>[0] = {},
): FastifyInstance {
  const app = buildApp({ logger: false, ...options });
  apps.push(app);
  return app;
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

test("GET /health preserves the product API health response", async () => {
  const app = createTestApp();

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

test("AI dependency returns 200 when the orchestrator is healthy", async () => {
  let requestedUrl = "";

  const app = createTestApp({
    aiOrchestratorUrl: "http://127.0.0.1:8000",
    fetchImpl: async (input) => {
      requestedUrl = String(input);

      return Response.json({
        status: "ok",
        service: "sentinelops-ai-orchestrator",
      });
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/ai",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requestedUrl, "http://127.0.0.1:8000/health");
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "sentinelops-product-api",
    dependency: {
      name: "sentinelops-ai-orchestrator",
      status: "ok",
    },
  });
});

test("AI dependency returns 503 when the orchestrator returns HTTP 500", async () => {
  const app = createTestApp({
    fetchImpl: async () =>
      new Response("Internal server error", { status: 500 }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/ai",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "error",
    service: "sentinelops-product-api",
    dependency: {
      name: "sentinelops-ai-orchestrator",
      status: "unavailable",
    },
    message: "AI orchestrator unavailable",
  });
  assert.equal(response.body.includes("Internal server error"), false);
});

test("AI dependency returns 503 when the connection fails", async () => {
  const app = createTestApp({
    fetchImpl: async () => {
      throw new Error("private connection details");
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/ai",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.body.includes("private connection details"), false);
});

test("AI dependency returns 503 when the request times out", async () => {
  const app = createTestApp({
    timeoutMs: 10,
    fetchImpl: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;

        if (!signal) {
          reject(new Error("Missing timeout signal"));
          return;
        }

        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/ai",
  });

  assert.equal(response.statusCode, 503);
});

test("AI dependency returns 503 for malformed JSON", async () => {
  const app = createTestApp({
    fetchImpl: async () =>
      new Response("{invalid-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/ai",
  });

  assert.equal(response.statusCode, 503);
});

test("AI dependency returns 503 when the response contract is incorrect", async () => {
  const app = createTestApp({
    fetchImpl: async () =>
      Response.json({
        status: "ok",
        service: "some-other-service",
      }),
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/ai",
  });

  assert.equal(response.statusCode, 503);
});

test("AI dependency rejects an invalid URL without crashing the API", async () => {
  const app = createTestApp({
    aiOrchestratorUrl: "not-a-valid-url",
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/ai",
  });

  assert.equal(response.statusCode, 503);

  const healthResponse = await app.inject({
    method: "GET",
    url: "/health",
  });

  assert.equal(healthResponse.statusCode, 200);
});

test("unknown routes still return 404", async () => {
  const app = createTestApp();

  const response = await app.inject({
    method: "GET",
    url: "/route-that-does-not-exist",
  });

  assert.equal(response.statusCode, 404);
});
