import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import {
  analysisSchema,
  diagnoseInvestigationResponse,
  normalizeInvestigationCitationDuplicates,
  registerInvestigationRoutes,
} from "../src/investigation-routes.js";
import { buildEvidenceCandidateInventory } from "../src/investigation-evidence-inventory.js";
import { renderInvestigationAnalysis } from "../src/investigation-analysis.js";
import { buildApp } from "../src/app.js";
import type {
  ChunkEmbeddingInput,
  CreateDocumentChunkInput,
  DocumentChunkRecord,
  PendingEmbeddingChunk,
  SemanticSearchChunkRecord,
} from "../src/chunk-repository.js";
import { registerChatRoutes } from "../src/chat-routes.js";
import { registerChunkRoutes } from "../src/chunk-routes.js";
import { registerEmbeddingRoutes } from "../src/embedding-routes.js";

import type {
  CreateDocumentInput,
  DocumentRecord,
} from "../src/document-repository.js";
import { registerDocumentRoutes } from "../src/document-routes.js";
import type {
  IncidentRecord,
  ProductStore,
  ProjectRecord,
  WorkspaceRecord,
} from "../src/product-repository.js";
import { registerProductRoutes } from "../src/product-routes.js";
import type {
  CreateProjectSourceInput,
  ProjectSourceRecord,
} from "../src/source-repository.js";
import { registerSourceRoutes } from "../src/source-routes.js";
import { createTestSecurity } from "./security-test-fixture.js";

const apps: FastifyInstance[] = [];
const sharedInvestigationSchema: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/shared-contracts/schemas/investigation-analysis.schema.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("Product API investigation schema matches the shared contract", () => {
  assert.deepEqual(analysisSchema, sharedInvestigationSchema);
});

test("candidate inventory preserves complete JSONL records without joining them", () => {
  const content = [
    '{"incident_id":"INC-001","event":"pool","idle_connections":0}',
    '{"incident_id":"INC-001","event":"payment","duration_ms":180}',
    '{"incident_id":"INC-001","event":',
  ].join("\n");
  const inventory = buildEvidenceCandidateInventory([{
    evidenceId: "11111111-1111-4111-8111-111111111111",
    chunkId: "11111111-1111-4111-8111-111111111111",
    documentId: "22222222-2222-4222-8222-222222222222",
    sourceId: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    runId: "55555555-5555-4555-8555-555555555555",
    requestId: "66666666-6666-4666-8666-666666666666",
    alias: "E1",
    incidentId: "INC-001",
    ordinal: 0,
    rank: 1,
    score: 0.8,
    content,
    contentHash: "a".repeat(64),
    evidenceScope: "incident_specific",
    retrievedAt: "2026-01-01T00:00:00.000Z",
  }]);
  assert.equal(inventory.version, "evidence-candidate-inventory-v1");
  assert.equal(inventory.records.length, 2);
  assert.deepEqual(inventory.records[0]?.fields, {
    incident_id: "INC-001", event: "pool", idle_connections: 0,
  });
  assert.equal(inventory.records[1]?.fields.duration_ms, 180);
  assert.notEqual(inventory.records[0]?.recordId, inventory.records[1]?.recordId);
});

function diagnoseAnalysis(
  analysis: unknown,
  evidenceCount = 1,
): Array<{ path: string; code: string }> {
  return diagnoseInvestigationResponse(
    {
      model: "test-model",
      response:
        typeof analysis === "string" ? analysis : JSON.stringify(analysis),
    },
    evidenceCount,
  );
}

test("investigation contract diagnostics accept a valid structured response", () => {
  assert.deepEqual(
    diagnoseAnalysis(JSON.parse(structuredInvestigationResponse())),
    [],
  );
});

test("citation normalization removes only exact aliases, preserves order, and is idempotent", () => {
  const original = JSON.parse(structuredInvestigationResponse(["E2", "E1", "E2"])) as Record<string, unknown>;
  original.observed_facts = [
    { claim: "Primer hecho.", evidence_refs: ["E1", "E1"] },
    { claim: "Segundo hecho.", evidence_refs: ["E2", "E2", "E1"] },
  ];
  original.hypotheses = [{
    statement: "Hipótesis de prueba.",
    status: "supported_unconfirmed",
    supporting_evidence: ["E1", "E1"],
    contradicting_evidence: ["E2", "E2"],
  }];
  const before = JSON.parse(JSON.stringify(original));

  const normalized = normalizeInvestigationCitationDuplicates(original);
  const result = normalized.value as Record<string, unknown>;

  assert.deepEqual(normalized.diagnostics, [
    { path: "$.response.summary_evidence_refs", removedDuplicates: 1 },
    { path: "$.response.observed_facts[0].evidence_refs", removedDuplicates: 1 },
    { path: "$.response.observed_facts[1].evidence_refs", removedDuplicates: 1 },
    { path: "$.response.hypotheses[0].supporting_evidence", removedDuplicates: 1 },
    { path: "$.response.hypotheses[0].contradicting_evidence", removedDuplicates: 1 },
  ]);
  assert.deepEqual(result.summary_evidence_refs, ["E2", "E1"]);
  assert.deepEqual((result.observed_facts as Array<Record<string, unknown>>)[0]?.evidence_refs, ["E1"]);
  assert.deepEqual((result.observed_facts as Array<Record<string, unknown>>)[1]?.evidence_refs, ["E2", "E1"]);
  assert.deepEqual((result.hypotheses as Array<Record<string, unknown>>)[0]?.supporting_evidence, ["E1"]);
  assert.deepEqual((result.hypotheses as Array<Record<string, unknown>>)[0]?.contradicting_evidence, ["E2"]);
  assert.equal((result.observed_facts as Array<Record<string, unknown>>)[0]?.claim, "Primer hecho.");
  assert.equal((result.hypotheses as Array<Record<string, unknown>>)[0]?.statement, "Hipótesis de prueba.");
  assert.deepEqual(original, before);
  assert.deepEqual(diagnoseAnalysis(result, 2), []);

  const repeatedAcrossClaims = result as Record<string, unknown>;
  assert.deepEqual((repeatedAcrossClaims.observed_facts as Array<Record<string, unknown>>)[0]?.evidence_refs, ["E1"]);
  assert.deepEqual((repeatedAcrossClaims.hypotheses as Array<Record<string, unknown>>)[0]?.supporting_evidence, ["E1"]);
  const repeated = normalizeInvestigationCitationDuplicates(result);
  assert.deepEqual(repeated.value, result);
  assert.deepEqual(repeated.diagnostics, []);

  const valid = JSON.parse(structuredInvestigationResponse()) as Record<string, unknown>;
  const unchanged = normalizeInvestigationCitationDuplicates(valid);
  assert.strictEqual(unchanged.value, valid);
  assert.deepEqual(unchanged.diagnostics, []);
});

test("citation normalization preserves invalid values and leaves them for strict rejection", () => {
  const unknown = JSON.parse(structuredInvestigationResponse(["E2", "E2"])) as Record<string, unknown>;
  const normalizedUnknown = normalizeInvestigationCitationDuplicates(unknown);
  assert.deepEqual((normalizedUnknown.value as Record<string, unknown>).summary_evidence_refs, ["E2"]);
  assert.ok(diagnoseAnalysis(normalizedUnknown.value).some(({ code }) => code === "evidence_reference_not_found"));

  const malformed = JSON.parse(structuredInvestigationResponse(["bad", "bad", null] as unknown as string[])) as Record<string, unknown>;
  malformed.unexpected = "remains-present";
  const normalizedMalformed = normalizeInvestigationCitationDuplicates(malformed);
  assert.deepEqual((normalizedMalformed.value as Record<string, unknown>).summary_evidence_refs, ["bad", "bad", null]);
  assert.ok(diagnoseAnalysis(normalizedMalformed.value).some(({ code }) => code === "malformed_citation"));
  assert.ok(diagnoseAnalysis(normalizedMalformed.value).some(({ code }) => code === "unexpected_field"));

  const empty = JSON.parse(structuredInvestigationResponse([])) as Record<string, unknown>;
  const normalizedEmpty = normalizeInvestigationCitationDuplicates(empty);
  assert.deepEqual((normalizedEmpty.value as Record<string, unknown>).summary_evidence_refs, []);
  assert.ok(diagnoseAnalysis(normalizedEmpty.value).some(({ code }) => code === "array_must_not_be_empty"));
});

test("investigation contract diagnostics identify invalid JSON without echoing content", () => {
  assert.deepEqual(diagnoseAnalysis("{private prompt and malformed JSON"), [
    { path: "$.response", code: "invalid_json" },
  ]);
});

test("investigation contract diagnostics identify invalid orchestrator envelopes", () => {
  assert.deepEqual(
    diagnoseInvestigationResponse({ response: {} }, 1),
    [
      { path: "$.model", code: "required_field_missing" },
      { path: "$.response", code: "expected_string" },
    ],
  );
});

test("investigation contract diagnostics identify missing and unexpected fields", () => {
  const analysis = JSON.parse(structuredInvestigationResponse()) as Record<
    string,
    unknown
  >;
  delete analysis.summary;
  analysis.internalPrompt = "must not appear in diagnostics";
  analysis["unsafe\nfield"] = "must not appear in diagnostics";

  const diagnostics = diagnoseAnalysis(analysis);
  assert.ok(
    diagnostics.some(
      ({ path, code }) =>
        path === "$.response.summary" && code === "required_field_missing",
    ),
  );
  assert.ok(
    diagnostics.some(
      ({ path, code }) =>
        path === "$.response.<unknown>" && code === "unexpected_field",
    ),
  );
  assert.ok(
    diagnostics.some(
      ({ path, code }) =>
        path === "$.response.<unknown>" && code === "unexpected_field",
    ),
  );
  assert.equal(JSON.stringify(diagnostics).includes("must not appear"), false);
});

test("investigation validation logs do not include attacker-controlled unknown keys", async () => {
  const logChunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(chunk.toString());
      callback();
    },
  });
  const app = createTestApp({
    logger: { level: "warn", stream: logStream },
  });
  const unknownKey = "attacker-key\r\nforged-log-entry";
  const unknownValue = "private-unknown-value";

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/embeddings")) {
        return Response.json(fakeEmbeddingPayload(1));
      }

      const analysis = JSON.parse(
        structuredInvestigationResponse(),
      ) as Record<string, unknown>;
      analysis[unknownKey] = unknownValue;
      return Response.json({
        model: "qwen3.5:4b",
        response: JSON.stringify(analysis),
      });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: { question: "Investiga este incidente." },
  });
  const actualLogs = logChunks.join("");

  assert.equal(response.statusCode, 502);
  assert.ok(actualLogs.includes("unexpected_field"));
  assert.ok(actualLogs.includes("$.response.<unknown>"));
  assert.equal(actualLogs.includes(unknownKey), false);
  assert.equal(actualLogs.includes(unknownValue), false);
});

test("investigation contract diagnostics identify wrong types and out-of-range values", () => {
  const analysis = JSON.parse(structuredInvestigationResponse()) as Record<
    string,
    unknown
  >;
  analysis.summary = 42;
  analysis.hypotheses = "not-an-array";

  const diagnostics = diagnoseAnalysis(analysis);
  assert.ok(
    diagnostics.some(
      ({ path, code }) =>
        path === "$.response.summary" && code === "expected_string",
    ),
  );
  assert.ok(
    diagnostics.some(
      ({ path, code }) =>
        path === "$.response.hypotheses" && code === "expected_array",
    ),
  );
});

test("investigation contract diagnostics distinguish malformed and unknown citations", () => {
  const malformed = JSON.parse(structuredInvestigationResponse()) as Record<
    string,
    unknown
  >;
  malformed.summary_evidence_refs = ["citation-1"];
  const malformedDiagnostics = diagnoseAnalysis(malformed);
  assert.ok(
    malformedDiagnostics.some(
      ({ path, code }) =>
        path === "$.response.summary_evidence_refs[0]" &&
        code === "malformed_citation",
    ),
  );

  const unknown = JSON.parse(structuredInvestigationResponse()) as Record<
    string,
    unknown
  >;
  unknown.summary_evidence_refs = ["E2"];
  const unknownDiagnostics = diagnoseAnalysis(unknown);
  assert.ok(
    unknownDiagnostics.some(
      ({ path, code }) =>
        path === "$.response.summary_evidence_refs[0]" &&
        code === "evidence_reference_not_found",
    ),
  );
});

test("investigation contract diagnostics identify unsupported IDs and semantic errors", () => {
  const analysis = JSON.parse(
    structuredInvestigationResponse(["E1"], "Resumen.", [
      {
        statement: "Hipótesis sin apoyo.",
        status: "confirmed_root_cause",
        supporting_evidence: [],
        contradicting_evidence: [],
      },
    ]),
  ) as Record<string, unknown>;
  const diagnostics = diagnoseAnalysis(analysis);
  assert.ok(
    diagnostics.some(
      ({ path, code }) =>
        path === "$.response.hypotheses[0].status" &&
        code === "identifier_not_recognized",
    ),
  );
});

test("hypothesis statuses enforce evidence relationships", () => {
  const cases: Array<{
    status: string;
    supporting: string[];
    contradicting: string[];
    valid: boolean;
  }> = [
    { status: "supported_unconfirmed", supporting: ["E1"], contradicting: [], valid: true },
    { status: "supported_unconfirmed", supporting: [], contradicting: [], valid: false },
    { status: "contradicted", supporting: [], contradicting: ["E1"], valid: true },
    { status: "contradicted", supporting: [], contradicting: [], valid: false },
    { status: "unverified", supporting: [], contradicting: [], valid: true },
    { status: "unverified", supporting: ["E1"], contradicting: [], valid: false },
    { status: "unverified", supporting: [], contradicting: ["E1"], valid: false },
    { status: "insufficient_evidence", supporting: ["E1"], contradicting: [], valid: true },
    { status: "insufficient_evidence", supporting: [], contradicting: [], valid: true },
    { status: "supported_unconfirmed", supporting: ["E2"], contradicting: [], valid: false },
  ];
  for (const item of cases) {
    const analysis = JSON.parse(structuredInvestigationResponse(["E1"], "Resumen.", [{
      statement: "Hipótesis de prueba.",
      status: item.status,
      supporting_evidence: item.supporting,
      contradicting_evidence: item.contradicting,
    }])) as unknown;
    assert.equal(diagnoseAnalysis(analysis).length === 0, item.valid, JSON.stringify(item));
  }
});

function structuredInvestigationResponse(
  summaryEvidenceRefs: string[] = ["E1"],
  summary = "El fragmento registra una observación.",
  hypotheses: Array<{
    statement: string;
    status: string;
    supporting_evidence: string[];
    contradicting_evidence: string[];
  }> = [],
): string {
  return JSON.stringify({
    summary,
    summary_evidence_refs: summaryEvidenceRefs,
    observed_facts: [
      {
        claim: "El fragmento registra una observación.",
        evidence_refs: ["E1"],
      },
    ],
    hypotheses,
    missing_information: [],
    next_checks: [],
    limitations: [],
  });
}

function createTestApp(
  options: Parameters<typeof buildApp>[0] = {},
): FastifyInstance {
  const security = createTestSecurity();
  const app = buildApp({
    logger: false,
    securityStore: security.securityStore,
    securityConfig: security.securityConfig,
    ...options,
  });
  app.addHook("onRequest", async (request, _reply) => {
    security.addTestCredentials(request);
  });
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

test("AI dependency returns 200 when the orchestrator is ready", async () => {
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
  assert.equal(requestedUrl, "http://127.0.0.1:8000/ready");
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

test("PostgreSQL dependency returns 200 when PostgreSQL is healthy", async () => {
  let healthCheckCalled = false;

  const app = createTestApp({
    postgresHealthCheck: async () => {
      healthCheckCalled = true;
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/postgres",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(healthCheckCalled, true);
  assert.deepEqual(response.json(), {
    status: "ok",
    service: "sentinelops-product-api",
    dependency: {
      name: "postgres",
      status: "ok",
    },
  });
});

test("PostgreSQL dependency returns 503 without exposing internal errors", async () => {
  const app = createTestApp({
    postgresHealthCheck: async () => {
      throw new Error("private connection details");
    },
  });

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/postgres",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "error",
    service: "sentinelops-product-api",
    dependency: {
      name: "postgres",
      status: "unavailable",
    },
    message: "PostgreSQL unavailable",
  });
  assert.equal(response.body.includes("private connection details"), false);
});

test("PostgreSQL dependency returns 503 when no health check is configured", async () => {
  const app = createTestApp();

  const response = await app.inject({
    method: "GET",
    url: "/health/dependencies/postgres",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "error",
    service: "sentinelops-product-api",
    dependency: {
      name: "postgres",
      status: "unavailable",
    },
    message: "PostgreSQL unavailable",
  });
});

const repositoryTestDate = new Date("2026-01-01T00:00:00.000Z");

const repositoryTestWorkspace: WorkspaceRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "sentinelops-team",
  name: "SentinelOps Team",
  status: "active",
  createdAt: repositoryTestDate,
  updatedAt: repositoryTestDate,
};

const repositoryTestProject: ProjectRecord = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId: repositoryTestWorkspace.id,
  slug: "incident-platform",
  name: "Incident Platform",
  description: "Proyecto de prueba",
  status: "active",
  settings: {},
  createdAt: repositoryTestDate,
  updatedAt: repositoryTestDate,
};

const repositoryTestIncident: IncidentRecord = {
  id: "33333333-3333-4333-8333-333333333333",
  projectId: repositoryTestProject.id,
  externalReference: null,
  title: "API response latency",
  description: "Elevated response time",
  serviceName: "product-api",
  severity: "high",
  status: "new",
  context: {},
  createdAt: repositoryTestDate,
  updatedAt: repositoryTestDate,
};

function createFakeProductStore(
  overrides: Partial<ProductStore> = {},
): ProductStore {
  const store: ProductStore = {
    listWorkspaces: async () => [repositoryTestWorkspace],

    createWorkspace: async (input) => ({
      ...repositoryTestWorkspace,
      slug: input.slug,
      name: input.name,
    }),

    listProjects: async (workspaceId) =>
      workspaceId === repositoryTestWorkspace.id
        ? [repositoryTestProject]
        : null,

    createProject: async (workspaceId, input) =>
      workspaceId === repositoryTestWorkspace.id
        ? {
            ...repositoryTestProject,
            workspaceId,
            slug: input.slug,
            name: input.name,
            description: input.description ?? null,
          }
        : null,

    listIncidents: async (projectId) =>
      projectId === repositoryTestProject.id
        ? [repositoryTestIncident]
        : null,

    createIncident: async (projectId, input) =>
      projectId === repositoryTestProject.id
        ? {
            ...repositoryTestIncident,
            projectId,
            externalReference: input.externalReference ?? null,
            title: input.title,
            description: input.description ?? null,
            serviceName: input.serviceName ?? null,
            severity: input.severity,
            context: input.context ?? {},
          }
        : null,
  };

  return { ...store, ...overrides };
}

test("GET /api/workspaces returns workspace records", async () => {
  const app = createTestApp();
  registerProductRoutes(app, createFakeProductStore());

  const response = await app.inject({
    method: "GET",
    url: "/api/workspaces",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.json().data[0].slug,
    repositoryTestWorkspace.slug,
  );
});

test("POST /api/workspaces creates a workspace", async () => {
  const app = createTestApp();
  registerProductRoutes(app, createFakeProductStore());

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: {
      slug: "new-team",
      name: "New Team",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.slug, "new-team");
  assert.equal(response.json().data.name, "New Team");
});

test("POST /api/workspaces rejects an invalid slug", async () => {
  let createCalled = false;

  const store = createFakeProductStore({
    createWorkspace: async () => {
      createCalled = true;
      return repositoryTestWorkspace;
    },
  });

  const app = createTestApp();
  registerProductRoutes(app, store);

  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    payload: {
      slug: "Invalid Slug",
      name: "Invalid Workspace",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(createCalled, false);
});

test("GET /api/workspaces/:workspaceId/projects returns projects", async () => {
  const app = createTestApp();
  registerProductRoutes(app, createFakeProductStore());

  const response = await app.inject({
    method: "GET",
    url: `/api/workspaces/${repositoryTestWorkspace.id}/projects`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(
    response.json().data[0].id,
    repositoryTestProject.id,
  );
});

test("GET projects returns 404 when the workspace does not exist", async () => {
  const app = createTestApp();
  registerProductRoutes(app, createFakeProductStore());

  const response = await app.inject({
    method: "GET",
    url: "/api/workspaces/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/projects",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Workspace not found",
  });
});

test("POST /api/workspaces/:workspaceId/projects creates a project", async () => {
  const app = createTestApp();
  registerProductRoutes(app, createFakeProductStore());

  const response = await app.inject({
    method: "POST",
    url: `/api/workspaces/${repositoryTestWorkspace.id}/projects`,
    payload: {
      slug: "new-project",
      name: "New Project",
      description: "Created in a route test",
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.json().data.workspaceId,
    repositoryTestWorkspace.id,
  );
  assert.equal(response.json().data.slug, "new-project");
});

test("POST /api/projects/:projectId/incidents creates an incident", async () => {
  const app = createTestApp();
  registerProductRoutes(app, createFakeProductStore());

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${repositoryTestProject.id}/incidents`,
    payload: {
      title: "Database latency",
      description: "Latency increased during the test",
      serviceName: "product-api",
      severity: "high",
      context: {
        environment: "test",
      },
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.projectId, repositoryTestProject.id);
  assert.equal(response.json().data.title, "Database latency");
  assert.equal(response.json().data.severity, "high");
});

test("POST incident returns 409 for a duplicate project external reference", async () => {
  const app = createTestApp();
  const store = createFakeProductStore({
    createIncident: async () => {
      throw Object.assign(new Error("duplicate external reference"), {
        code: "23505",
      });
    },
  });
  registerProductRoutes(app, store);

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${repositoryTestProject.id}/incidents`,
    payload: {
      externalReference: "INC-001",
      title: "Duplicate incident",
      severity: "high",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.equal(
    response.json().error,
    "Incident external reference already exists in this project",
  );
});

test("Product routes return 503 when persistence is not configured", async () => {
  const app = createTestApp();
  registerProductRoutes(app);

  const response = await app.inject({
    method: "GET",
    url: "/api/workspaces",
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "Persistence unavailable",
  });
});

const sourceTestDate = new Date("2026-01-01T00:00:00.000Z");

const sourceTestProjectId = "22222222-2222-4222-8222-222222222222";

const sourceTestRecord: ProjectSourceRecord = {
  id: "44444444-4444-4444-8444-444444444444",
  projectId: sourceTestProjectId,
  sourceType: "git_repository",
  name: "SentinelOps repository",
  locator: "https://example.com/sentinelops.git",
  status: "pending",
  metadata: {},
  createdAt: sourceTestDate,
  updatedAt: sourceTestDate,
};

function createFakeSourceStore(
  overrides: {
    listForProject?: (
      projectId: string,
    ) => Promise<ProjectSourceRecord[] | null>;
    createForProject?: (
      projectId: string,
      input: CreateProjectSourceInput,
    ) => Promise<ProjectSourceRecord | null>;
  } = {},
) {
  return {
    listForProject:
      overrides.listForProject ??
      (async (projectId: string) =>
        projectId === sourceTestProjectId ? [sourceTestRecord] : null),

    createForProject:
      overrides.createForProject ??
      (async (projectId: string, input: CreateProjectSourceInput) =>
        projectId === sourceTestProjectId
          ? {
              ...sourceTestRecord,
              projectId,
              sourceType: input.sourceType,
              name: input.name,
              locator: input.locator,
              metadata: input.metadata ?? {},
            }
          : null),
  };
}

test("GET /api/projects/:projectId/sources returns project sources", async () => {
  const app = createTestApp();
  registerSourceRoutes(app, createFakeSourceStore());

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${sourceTestProjectId}/sources`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.length, 1);
  assert.equal(
    response.json().data[0].sourceType,
    "git_repository",
  );
  assert.equal(
    response.json().data[0].projectId,
    sourceTestProjectId,
  );
});

test("POST /api/projects/:projectId/sources creates a source", async () => {
  const app = createTestApp();
  registerSourceRoutes(app, createFakeSourceStore());

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/sources`,
    payload: {
      sourceType: "git_repository",
      name: "SentinelOps repository",
      locator: "https://example.com/sentinelops.git",
      metadata: {
        branch: "main",
      },
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(
    response.json().data.sourceType,
    "git_repository",
  );
  assert.equal(
    response.json().data.locator,
    "https://example.com/sentinelops.git",
  );
  assert.equal(response.json().data.metadata.branch, "main");
});

test("POST project source rejects an unsupported source type", async () => {
  let createCalled = false;

  const store = createFakeSourceStore({
    createForProject: async () => {
      createCalled = true;
      return sourceTestRecord;
    },
  });

  const app = createTestApp();
  registerSourceRoutes(app, store);

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/sources`,
    payload: {
      sourceType: "arbitrary_source",
      name: "Invalid source",
      locator: "https://example.com/source",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(createCalled, false);
});

test("GET project sources returns 404 when the project does not exist", async () => {
  const app = createTestApp();
  registerSourceRoutes(app, createFakeSourceStore());

  const response = await app.inject({
    method: "GET",
    url: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/sources",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Project not found",
  });
});

test("POST project source returns 409 for a duplicate source", async () => {
  const app = createTestApp();

  registerSourceRoutes(
    app,
    createFakeSourceStore({
      createForProject: async () => {
        throw Object.assign(
          new Error("duplicate key details"),
          { code: "23505" },
        );
      },
    }),
  );

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/sources`,
    payload: {
      sourceType: "git_repository",
      name: "SentinelOps repository",
      locator: "https://example.com/sentinelops.git",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: "Source already exists for this project and type",
  });
  assert.equal(response.body.includes("duplicate key details"), false);
});

test("Project source routes return 503 when persistence is unavailable", async () => {
  const app = createTestApp();
  registerSourceRoutes(app);

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${sourceTestProjectId}/sources`,
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "Persistence unavailable",
  });
});

const documentTestDate = new Date("2026-01-01T00:00:00.000Z");

const documentTestRecord: DocumentRecord = {
  id: "55555555-5555-4555-8555-555555555555",
  projectId: sourceTestProjectId,
  sourceId: sourceTestRecord.id,
  sourceDocumentKey: "README.md",
  title: "README.md",
  mediaType: "text/markdown",
  contentSha256: "a".repeat(64),
  status: "discovered",
  metadata: {
    format: "markdown",
  },
  createdAt: documentTestDate,
  updatedAt: documentTestDate,
};

function createFakeDocumentStore(
  overrides: {
    listForProject?: (
      projectId: string,
    ) => Promise<DocumentRecord[] | null>;
    createForProject?: (
      projectId: string,
      input: CreateDocumentInput,
    ) => Promise<DocumentRecord | null>;
  } = {},
) {
  return {
    listForProject:
      overrides.listForProject ??
      (async (projectId: string) =>
        projectId === sourceTestProjectId
          ? [documentTestRecord]
          : null),

    createForProject:
      overrides.createForProject ??
      (async (projectId: string, input: CreateDocumentInput) =>
        projectId === sourceTestProjectId &&
        input.sourceId === sourceTestRecord.id
          ? {
              ...documentTestRecord,
              projectId,
              sourceId: input.sourceId,
              sourceDocumentKey: input.sourceDocumentKey ?? null,
              title: input.title,
              mediaType: input.mediaType ?? null,
              contentSha256: input.contentSha256 ?? null,
              metadata: input.metadata ?? {},
            }
          : null),
  };
}

test("GET /api/projects/:projectId/documents returns project documents", async () => {
  const app = createTestApp();
  registerDocumentRoutes(app, createFakeDocumentStore());

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${sourceTestProjectId}/documents`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.length, 1);
  assert.equal(response.json().data[0].title, "README.md");
  assert.equal(
    response.json().data[0].sourceId,
    sourceTestRecord.id,
  );
});

test("POST /api/projects/:projectId/documents creates a document", async () => {
  const app = createTestApp();
  registerDocumentRoutes(app, createFakeDocumentStore());

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents`,
    payload: {
      sourceId: sourceTestRecord.id,
      sourceDocumentKey: "README.md",
      title: "README.md",
      mediaType: "text/markdown",
      contentSha256: "a".repeat(64),
      extractedText: "# SentinelOps AI\nDocumento de prueba.",
      metadata: {
        format: "markdown",
      },
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.title, "README.md");
  assert.equal(response.json().data.sourceId, sourceTestRecord.id);
  assert.equal(response.json().data.status, "discovered");
  assert.equal(
    response.json().data.contentSha256,
    "a".repeat(64),
  );
});

test("POST document rejects an invalid SHA-256 hash", async () => {
  let createCalled = false;

  const store = createFakeDocumentStore({
    createForProject: async () => {
      createCalled = true;
      return documentTestRecord;
    },
  });

  const app = createTestApp();
  registerDocumentRoutes(app, store);

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents`,
    payload: {
      sourceId: sourceTestRecord.id,
      title: "README.md",
      contentSha256: "not-a-valid-hash",
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(createCalled, false);
});

test("GET project documents returns 404 when the project does not exist", async () => {
  const app = createTestApp();
  registerDocumentRoutes(app, createFakeDocumentStore());

  const response = await app.inject({
    method: "GET",
    url: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/documents",
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Project not found",
  });
});

test("POST document returns 404 when the source is not in the project", async () => {
  const app = createTestApp();

  registerDocumentRoutes(
    app,
    createFakeDocumentStore({
      createForProject: async () => null,
    }),
  );

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents`,
    payload: {
      sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "README.md",
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Project or source not found in this project",
  });
});

test("POST document returns 409 for a duplicate source document key", async () => {
  const app = createTestApp();

  registerDocumentRoutes(
    app,
    createFakeDocumentStore({
      createForProject: async () => {
        throw Object.assign(
          new Error("private database constraint details"),
          { code: "23505" },
        );
      },
    }),
  );

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents`,
    payload: {
      sourceId: sourceTestRecord.id,
      sourceDocumentKey: "README.md",
      title: "README.md",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: "Document key already exists for this source",
  });
  assert.equal(
    response.body.includes("private database constraint details"),
    false,
  );
});

test("Document routes return 503 when persistence is unavailable", async () => {
  const app = createTestApp();
  registerDocumentRoutes(app);

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${sourceTestProjectId}/documents`,
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "Persistence unavailable",
  });
});

const chunkTestDate = new Date("2026-01-01T00:00:00.000Z");

const chunkTestRecord: DocumentChunkRecord = {
  id: "66666666-6666-4666-8666-666666666666",
  projectId: sourceTestProjectId,
  documentId: documentTestRecord.id,
  ordinal: 0,
  content: "Documento de prueba para fragmentación RAG.",
  tokenCount: 7,
  startOffset: 0,
  endOffset: 45,
  metadata: {
    strategy: "test",
  },
  createdAt: chunkTestDate,
};

function createFakeChunkStore(
  overrides: {
    listForDocument?: (
      projectId: string,
      documentId: string,
    ) => Promise<DocumentChunkRecord[] | null>;
    createForDocument?: (
      projectId: string,
      documentId: string,
      input: CreateDocumentChunkInput,
    ) => Promise<DocumentChunkRecord | null>;
  } = {},
) {
  return {
    listForDocument:
      overrides.listForDocument ??
      (async (projectId: string, documentId: string) =>
        projectId === sourceTestProjectId &&
        documentId === documentTestRecord.id
          ? [chunkTestRecord]
          : null),

    createForDocument:
      overrides.createForDocument ??
      (async (
        projectId: string,
        documentId: string,
        input: CreateDocumentChunkInput,
      ) =>
        projectId === sourceTestProjectId &&
        documentId === documentTestRecord.id
          ? {
              ...chunkTestRecord,
              projectId,
              documentId,
              ordinal: input.ordinal,
              content: input.content,
              tokenCount: input.tokenCount ?? null,
              startOffset: input.startOffset ?? null,
              endOffset: input.endOffset ?? null,
              metadata: input.metadata ?? {},
            }
          : null),
  };
}

test("GET document chunks returns fragments in the document", async () => {
  const app = createTestApp();
  registerChunkRoutes(app, createFakeChunkStore());

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/chunks`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.length, 1);
  assert.equal(response.json().data[0].ordinal, 0);
  assert.equal(
    response.json().data[0].documentId,
    documentTestRecord.id,
  );
});

test("POST document chunks creates a fragment", async () => {
  const app = createTestApp();
  registerChunkRoutes(app, createFakeChunkStore());

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/chunks`,
    payload: {
      ordinal: 1,
      content: "Segundo fragmento para la prueba.",
      tokenCount: 6,
      startOffset: 45,
      endOffset: 79,
      metadata: {
        strategy: "test",
      },
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().data.ordinal, 1);
  assert.equal(
    response.json().data.content,
    "Segundo fragmento para la prueba.",
  );
  assert.equal(response.json().data.startOffset, 45);
  assert.equal(response.json().data.endOffset, 79);
});

test("POST document chunks rejects offsets when end is not greater than start", async () => {
  let createCalled = false;

  const store = createFakeChunkStore({
    createForDocument: async () => {
      createCalled = true;
      return chunkTestRecord;
    },
  });

  const app = createTestApp();
  registerChunkRoutes(app, store);

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/chunks`,
    payload: {
      ordinal: 1,
      content: "Invalid offsets",
      startOffset: 20,
      endOffset: 10,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(createCalled, false);
});

test("POST document chunks rejects a negative ordinal and blank content", async () => {
  const app = createTestApp();
  registerChunkRoutes(app, createFakeChunkStore());

  const negativeOrdinalResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/chunks`,
    payload: {
      ordinal: -1,
      content: "Valid content",
    },
  });

  assert.equal(negativeOrdinalResponse.statusCode, 400);

  const blankContentResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/chunks`,
    payload: {
      ordinal: 2,
      content: "   ",
    },
  });

  assert.equal(blankContentResponse.statusCode, 400);
});

test("GET document chunks returns 404 when the document is not in the project", async () => {
  const app = createTestApp();
  registerChunkRoutes(app, createFakeChunkStore());

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${sourceTestProjectId}/documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/chunks`,
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Document not found in this project",
  });
});

test("POST document chunks returns 409 for a duplicate ordinal", async () => {
  const app = createTestApp();

  registerChunkRoutes(
    app,
    createFakeChunkStore({
      createForDocument: async () => {
        throw Object.assign(
          new Error("private database constraint details"),
          { code: "23505" },
        );
      },
    }),
  );

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/chunks`,
    payload: {
      ordinal: 0,
      content: "Duplicate fragment",
    },
  });

  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.json(), {
    error: "Chunk ordinal already exists for this document",
  });
  assert.equal(
    response.body.includes("private database constraint details"),
    false,
  );
});

test("Document chunk routes return 503 when persistence is unavailable", async () => {
  const app = createTestApp();
  registerChunkRoutes(app);

  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/chunks`,
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "Persistence unavailable",
  });
});

interface EmbeddingTestStore {
  projectExists(projectId: string): Promise<boolean>;
  listWithoutEmbeddingsForDocument(
    projectId: string,
    documentId: string,
    limit?: number,
  ): Promise<PendingEmbeddingChunk[] | null>;
  saveEmbeddingsForDocument(
    projectId: string,
    documentId: string,
    embeddings: ChunkEmbeddingInput[],
  ): Promise<number | null>;
  searchSimilarChunks(
    projectId: string,
    embedding: number[],
    limit?: number,
  ): Promise<SemanticSearchChunkRecord[] | null>;
}

function createFakeEmbeddingStore(
  overrides: Partial<EmbeddingTestStore> = {},
): EmbeddingTestStore {
  return {
    projectExists:
      overrides.projectExists ??
      (async (projectId) => projectId === sourceTestProjectId),

    listWithoutEmbeddingsForDocument:
      overrides.listWithoutEmbeddingsForDocument ??
      (async (projectId, documentId) =>
        projectId === sourceTestProjectId &&
        documentId === documentTestRecord.id
          ? [
              {
                id: chunkTestRecord.id,
                ordinal: chunkTestRecord.ordinal,
                content: chunkTestRecord.content,
              },
            ]
          : null),

    saveEmbeddingsForDocument:
      overrides.saveEmbeddingsForDocument ??
      (async (_projectId, _documentId, embeddings) => embeddings.length),

    searchSimilarChunks:
      overrides.searchSimilarChunks ??
      (async (projectId) =>
        projectId === sourceTestProjectId
          ? [
              {
                id: chunkTestRecord.id,
                projectId: sourceTestProjectId,
                documentId: documentTestRecord.id,
                sourceId: sourceTestRecord.id,
                ordinal: chunkTestRecord.ordinal,
                content: chunkTestRecord.content,
                score: 0.91,
              },
            ]
          : null),
  };
}

const fakeEmbeddingVector = (): number[] =>
  Array.from({ length: 1024 }, () => 0.125);

function fakeEmbeddingPayload(count: number): unknown {
  return {
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: fakeEmbeddingVector(),
    })),
  };
}

test("POST document embeddings generates and stores pending vectors", async () => {
  let requestedUrl = "";
  let requestedTexts: string[] = [];
  let savedEmbeddings: ChunkEmbeddingInput[] = [];

  const store = createFakeEmbeddingStore({
    saveEmbeddingsForDocument: async (_projectId, _documentId, embeddings) => {
      savedEmbeddings = embeddings;
      return embeddings.length;
    },
  });

  const app = createTestApp();
  registerEmbeddingRoutes(app, store, {
    aiOrchestratorUrl: "http://127.0.0.1:8000",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      requestedTexts = body.texts;
      return Response.json(fakeEmbeddingPayload(body.texts.length));
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/embeddings`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requestedUrl, "http://127.0.0.1:8000/embeddings");
  assert.deepEqual(requestedTexts, [chunkTestRecord.content]);
  assert.equal(response.json().data.processed, 1);
  assert.equal(response.json().data.model, "qwen3-embedding:0.6b");
  assert.equal(response.json().data.hasMore, false);
  assert.equal(savedEmbeddings.length, 1);
  assert.equal(savedEmbeddings[0]?.id, chunkTestRecord.id);
  assert.equal(savedEmbeddings[0]?.embedding.length, 1024);
  assert.equal(savedEmbeddings[0]?.model, "qwen3-embedding:0.6b");
});

test("POST document embeddings returns 404 when document is not in project", async () => {
  let providerCalled = false;
  const store = createFakeEmbeddingStore({
    listWithoutEmbeddingsForDocument: async () => null,
  });

  const app = createTestApp();
  registerEmbeddingRoutes(app, store, {
    fetchImpl: async () => {
      providerCalled = true;
      return Response.json(fakeEmbeddingPayload(1));
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/embeddings`,
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Document not found in this project",
  });
  assert.equal(providerCalled, false);
});

test("POST document embeddings returns 503 when orchestrator is unavailable", async () => {
  const app = createTestApp();
  registerEmbeddingRoutes(app, createFakeEmbeddingStore(), {
    fetchImpl: async () => {
      throw new Error("private network failure details");
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/embeddings`,
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "Embedding service unavailable",
  });
  assert.equal(response.body.includes("private network failure details"), false);
});

test("POST document embeddings returns 504 when orchestrator times out", async () => {
  const app = createTestApp();
  registerEmbeddingRoutes(app, createFakeEmbeddingStore(), {
    fetchImpl: async () => new Response("timeout", { status: 504 }),
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/embeddings`,
  });

  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.json(), {
    error: "Embedding request timed out",
  });
});

test("POST project search returns semantic results", async () => {
  let requestedTexts: string[] = [];
  let capturedLimit: number | undefined;

  const store = createFakeEmbeddingStore({
    searchSimilarChunks: async (_projectId, embedding, limit) => {
      assert.equal(embedding.length, 1024);
      capturedLimit = limit;
      return [
        {
          id: chunkTestRecord.id,
          projectId: sourceTestProjectId,
          documentId: documentTestRecord.id,
          ordinal: 0,
          content: chunkTestRecord.content,
          score: 0.91,
        },
      ];
    },
  });

  const app = createTestApp();
  registerEmbeddingRoutes(app, store, {
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { texts: string[] };
      requestedTexts = body.texts;
      return Response.json(fakeEmbeddingPayload(body.texts.length));
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/search`,
    payload: {
      query: "¿Por qué presenta latencia la API?",
      limit: 3,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(requestedTexts, ["¿Por qué presenta latencia la API?"]);
  assert.equal(capturedLimit, 3);
  assert.equal(response.json().data.results.length, 1);
  assert.equal(response.json().data.results[0].score, 0.91);
  assert.equal(response.json().data.model, "qwen3-embedding:0.6b");
});

test("POST project search returns 404 before embedding unknown project", async () => {
  let providerCalled = false;
  const store = createFakeEmbeddingStore({
    projectExists: async () => false,
  });

  const app = createTestApp();
  registerEmbeddingRoutes(app, store, {
    fetchImpl: async () => {
      providerCalled = true;
      return Response.json(fakeEmbeddingPayload(1));
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/search`,
    payload: { query: "consulta de prueba" },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), { error: "Project not found" });
  assert.equal(providerCalled, false);
});

test("Embedding routes return 502 for invalid provider vector dimensions", async () => {
  const app = createTestApp();
  registerEmbeddingRoutes(app, createFakeEmbeddingStore(), {
    fetchImpl: async () =>
      Response.json({
        model: "qwen3-embedding:0.6b",
        dimensions: 1024,
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }),
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/embeddings`,
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: "Invalid embedding response",
  });
});

test("Embedding routes return 503 when persistence is unavailable", async () => {
  const app = createTestApp();
  registerEmbeddingRoutes(app);

  const batchResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/documents/${documentTestRecord.id}/embeddings`,
  });

  const searchResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/search`,
    payload: { query: "consulta de prueba" },
  });

  assert.equal(batchResponse.statusCode, 503);
  assert.equal(searchResponse.statusCode, 503);
  assert.deepEqual(batchResponse.json(), {
    error: "Persistence unavailable",
  });
  assert.deepEqual(searchResponse.json(), {
    error: "Persistence unavailable",
  });
});

test("POST project search rejects blank query and out-of-range limit", async () => {
  const app = createTestApp();
  registerEmbeddingRoutes(app, createFakeEmbeddingStore());

  const blankQuery = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/search`,
    payload: { query: "   " },
  });

  const excessiveLimit = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/search`,
    payload: { query: "consulta válida", limit: 100 },
  });

  assert.equal(blankQuery.statusCode, 400);
  assert.equal(excessiveLimit.statusCode, 400);
});

test("POST /api/chat forwards the prompt to the AI orchestrator", async () => {
  let requestedUrl = "";
  let requestedPrompt = "";

  const app = createTestApp();

  registerChatRoutes(app, {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);

      const body = JSON.parse(String(init?.body)) as {
        prompt: string;
      };

      requestedPrompt = body.prompt;

      return Response.json({
        model: "qwen3.5:4b",
        response: "Revisaría los logs del servicio.",
      });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: {
      prompt: "Investiga un error HTTP 503.",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(requestedUrl, "http://127.0.0.1:8001/chat");
  assert.equal(requestedPrompt, "Investiga un error HTTP 503.");

  assert.deepEqual(response.json(), {
    model: "qwen3.5:4b",
    response: "Revisaría los logs del servicio.",
  });
});

test("POST /api/chat rejects a blank prompt", async () => {
  let upstreamCalled = false;
  const app = createTestApp();

  registerChatRoutes(app, {
    fetchImpl: async () => {
      upstreamCalled = true;

      return Response.json({
        model: "qwen3.5:4b",
        response: "Respuesta",
      });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { prompt: "   " },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json(), {
    error: "Prompt must not be empty",
  });
  assert.equal(upstreamCalled, false);
});

test("POST /api/chat returns 503 when the orchestrator is unavailable", async () => {
  const app = createTestApp();

  registerChatRoutes(app, {
    fetchImpl: async () => {
      throw new Error("private connection details");
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { prompt: "Investiga un error HTTP 503." },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "AI service unavailable",
  });
  assert.equal(
    response.body.includes("private connection details"),
    false,
  );
});

test("POST /api/chat returns 504 when the orchestrator times out", async () => {
  const app = createTestApp();

  registerChatRoutes(app, {
    fetchImpl: async () => {
      throw new DOMException("Request timed out", "TimeoutError");
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { prompt: "Investiga un error HTTP 503." },
  });

  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.json(), {
    error: "AI model timed out",
  });
});

test("POST /api/chat returns 502 for an invalid model response", async () => {
  const app = createTestApp();

  registerChatRoutes(app, {
    fetchImpl: async () =>
      Response.json({
        model: "qwen3.5:4b",
        response: "",
      }),
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/chat",
    payload: { prompt: "Investiga un error HTTP 503." },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: "Invalid AI model response",
  });
});test("POST project investigate combines retrieved evidence and model response", async () => {
  const requestedUrls: string[] = [];
  let requestedPrompt = "";

  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url.endsWith("/embeddings")) {
        return Response.json(fakeEmbeddingPayload(1));
      }

      const body = JSON.parse(String(init?.body)) as {
        prompt: string;
        max_tokens: number;
        response_format: string;
        response_schema: { required: string[]; additionalProperties: boolean };
      };

      requestedPrompt = body.prompt;
      assert.equal(body.max_tokens, 1536);
      assert.equal(body.response_format, "json");
      assert.deepEqual(body.response_schema.required, [
        "summary",
        "summary_evidence_refs",
        "observed_facts",
        "hypotheses",
        "missing_information",
        "next_checks",
        "limitations",
      ]);
      assert.equal(body.response_schema.additionalProperties, false);

      return Response.json({
        model: "qwen3.5:4b",
        response: structuredInvestigationResponse(),
      });
    },
  });

  test("investigation preserves a valid 395-word response without regenerating", async () => {
    const analysis = {
      summary: "dato",
      summary_evidence_refs: ["E1"],
      observed_facts: [{ claim: "Observación registrada.", evidence_refs: ["E1"] }],
      hypotheses: [],
      missing_information: [],
      next_checks: [],
      limitations: [],
    };
    const initialWords = renderInvestigationAnalysis(analysis).trim().split(/\s+/u).length;
    analysis.summary = Array(396 - initialWords).fill("dato").join(" ");
    assert.equal(renderInvestigationAnalysis(analysis).trim().split(/\s+/u).length, 395);
    let chatCalls = 0;
    let prompt = "";
    const app = createTestApp();
    registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
      aiOrchestratorUrl: "http://127.0.0.1:8001",
      fetchImpl: async (input, init) => {
        if (String(input).endsWith("/embeddings")) {
          return Response.json(fakeEmbeddingPayload(1));
        }
        chatCalls += 1;
        const body = JSON.parse(String(init?.body)) as { prompt: string };
        prompt = body.prompt;
        return Response.json({ model: "test-model", response: JSON.stringify(analysis) });
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${sourceTestProjectId}/investigate`,
      payload: { question: "Investiga este incidente." },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(chatCalls, 1);
    assert.deepEqual(response.json().data.analysis, analysis);
    assert.equal(response.json().data.response, renderInvestigationAnalysis(analysis));
    assert.match(prompt, /unverified requiere supporting_evidence y contradicting_evidence vacíos/u);
  });

  test("investigation rejects an unverified hypothesis with references on the first response", async () => {
    let chatCalls = 0;
    const app = createTestApp();
    registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
      aiOrchestratorUrl: "http://127.0.0.1:8001",
      fetchImpl: async (input) => {
        if (String(input).endsWith("/embeddings")) {
          return Response.json(fakeEmbeddingPayload(1));
        }
        chatCalls += 1;
        return Response.json({
          model: "test-model",
          response: structuredInvestigationResponse(["E1"], "Resumen.", [{
            statement: "Una hipótesis.",
            status: "unverified",
            supporting_evidence: ["E1"],
            contradicting_evidence: [],
          }]),
        });
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${sourceTestProjectId}/investigate`,
      payload: { question: "Investiga este incidente." },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(chatCalls, 1);
    assert.deepEqual(response.json(), {
      error: "AI model response did not satisfy the structured contract",
    });
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "¿Qué información existe sobre este incidente?",
      limit: 3,
    },
  });

  assert.equal(response.statusCode, 200);

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:8001/embeddings",
    "http://127.0.0.1:8001/chat",
  ]);

  assert.ok(requestedPrompt.includes(chunkTestRecord.content));
  assert.ok(requestedPrompt.includes(chunkTestRecord.id));
  assert.ok(requestedPrompt.includes('"citation": "E1"'));
  assert.match(requestedPrompt, /evidence-candidate-inventory-v1/u);
  assert.match(requestedPrompt, /cronología neutral/u);

  const payload = response.json();

  assert.equal(payload.data.model, "qwen3.5:4b");
  assert.equal(
    payload.data.analysis.summary,
    "El fragmento registra una observación.",
  );
  assert.ok(payload.data.response.includes("[E1]"));

  assert.equal(payload.data.evidence.length, 1);
  assert.equal(payload.data.evidence[0].chunkId, chunkTestRecord.id);
  assert.equal(payload.data.evidence[0].score, 0.91);
  assert.equal(payload.data.evidence[0].sourceId, sourceTestRecord.id);
  assert.equal(payload.data.evidence[0].requestId, payload.data.requestId);
  assert.deepEqual(
    payload.data.evidence,
    payload.data.evidenceManifest,
  );
});

test("POST project investigate normalizes duplicate citations and logs only the adjustment metadata", async () => {
  const logChunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      logChunks.push(chunk.toString());
      callback();
    },
  });
  const app = createTestApp({ logger: { level: "info", stream: logStream } });
  let prompt = "";
  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input, init) => {
      if (String(input).endsWith("/embeddings")) {
        return Response.json(fakeEmbeddingPayload(1));
      }
      prompt = (JSON.parse(String(init?.body)) as { prompt: string }).prompt;
      const analysis = JSON.parse(structuredInvestigationResponse()) as Record<string, unknown>;
      analysis.summary_evidence_refs = ["E1", "E1"];
      analysis.observed_facts = [{
        claim: "El fragmento registra una observación.",
        evidence_refs: ["E1", "E1"],
      }];
      analysis.hypotheses = [{
        statement: "La observación requiere verificación adicional.",
        status: "supported_unconfirmed",
        supporting_evidence: ["E1", "E1"],
        contradicting_evidence: ["E1", "E1"],
      }];
      return Response.json({ model: "test-model", response: JSON.stringify(analysis) });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: { question: "Investiga este incidente." },
  });

  assert.equal(response.statusCode, 200);
  const analysis = response.json().data.analysis;
  assert.deepEqual(analysis.summary_evidence_refs, ["E1"]);
  assert.deepEqual(analysis.observed_facts[0].evidence_refs, ["E1"]);
  assert.deepEqual(analysis.hypotheses[0].supporting_evidence, ["E1"]);
  assert.deepEqual(analysis.hypotheses[0].contradicting_evidence, ["E1"]);
  assert.match(prompt, /alias únicos/u);
  const logs = logChunks.join("");
  assert.ok(logs.includes("citationNormalization"));
  assert.ok(logs.includes("$.response.summary_evidence_refs"));
  assert.ok(logs.includes("removedDuplicates"));
  assert.ok(logs.includes("accepted"));
  assert.equal(logs.includes("La observación requiere verificación adicional."), false);
});

test("POST project investigate rejects model citations outside retrieved evidence", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/embeddings")) {
        return Response.json(fakeEmbeddingPayload(1));
      }

      return Response.json({
        model: "qwen3.5:4b",
        response: structuredInvestigationResponse(["E2"]),
      });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "¿Qué información existe sobre este incidente?",
    },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: "AI model response did not satisfy the structured contract",
  });
});

test("POST project investigate rejects malformed structured model JSON", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/embeddings")) {
        return Response.json(fakeEmbeddingPayload(1));
      }

      return Response.json({
        model: "qwen3.5:4b",
        response: "{invalid-json",
      });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "¿Qué información existe sobre este incidente?",
    },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: "AI model response did not satisfy the structured contract",
  });
});

test("POST project investigate returns a sanitized error for malformed orchestrator JSON", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) =>
      String(input).endsWith("/embeddings")
        ? Response.json(fakeEmbeddingPayload(1))
        : new Response("private prompt and malformed body", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: { question: "Investiga este incidente." },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: "Invalid AI model response" });
  assert.equal(response.body.includes("private prompt"), false);
});

test("POST project investigate maps orchestrator HTTP 500 to a sanitized 503", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) =>
      String(input).endsWith("/embeddings")
        ? Response.json(fakeEmbeddingPayload(1))
        : new Response("private traceback", { status: 500 }),
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: { question: "Investiga este incidente." },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { error: "AI service unavailable" });
  assert.equal(response.body.includes("private traceback"), false);
});

test("POST project investigate maps an invalid orchestrator request to a sanitized 502", async () => {
  const app = createTestApp();
  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) =>
      String(input).endsWith("/embeddings")
        ? Response.json(fakeEmbeddingPayload(1))
        : new Response("prompt length detail", { status: 422 }),
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: { question: "Investiga este incidente." },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: "Invalid investigation request" });
  assert.equal(response.body.includes("prompt length detail"), false);
});

test("POST project investigate rejects unsupported hypothesis states", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/embeddings")) {
        return Response.json(fakeEmbeddingPayload(1));
      }

      return Response.json({
        model: "qwen3.5:4b",
        response: structuredInvestigationResponse(
          ["E1"],
          undefined,
          [
            {
              statement: "La causa está confirmada.",
              status: "confirmed_root_cause",
              supporting_evidence: ["E1"],
              contradicting_evidence: [],
            },
          ],
        ),
      });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "¿Qué información existe sobre este incidente?",
    },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: "AI model response did not satisfy the structured contract",
  });
});

test("POST project investigate rejects deterministic factuality violations", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async (input) => {
      if (String(input).endsWith("/embeddings")) {
        return Response.json(fakeEmbeddingPayload(1));
      }

      return Response.json({
        model: "qwen3.5:4b",
        response: structuredInvestigationResponse(
          ["E1"],
          "20 conexiones activas están disponibles.",
        ),
      });
    },
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "¿Qué información existe sobre este incidente?",
    },
  });

  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), {
    error: "AI response failed deterministic factuality validation",
  });
});

test("POST project investigate returns 404 when project does not exist", async () => {
  let aiServiceCalled = false;

  const store = createFakeEmbeddingStore({
    projectExists: async () => false,
  });

  const app = createTestApp();

  registerInvestigationRoutes(app, store, {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async () => {
      aiServiceCalled = true;
      return Response.json(fakeEmbeddingPayload(1));
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/investigate",
    payload: {
      question: "Investiga el incidente.",
    },
  });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json(), {
    error: "Project not found",
  });
  assert.equal(aiServiceCalled, false);
});

test("POST project investigate returns 503 when embedding service is unavailable", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async () =>
      new Response("Service unavailable", { status: 503 }),
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "Investiga el incidente.",
    },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: "Embedding service unavailable",
  });
});

test("POST project investigate returns 504 when embedding service times out", async () => {
  const app = createTestApp();

  registerInvestigationRoutes(app, createFakeEmbeddingStore(), {
    aiOrchestratorUrl: "http://127.0.0.1:8001",
    fetchImpl: async () =>
      new Response("timeout", { status: 504 }),
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "Investiga el incidente.",
    },
  });

  assert.equal(response.statusCode, 504);
  assert.deepEqual(response.json(), {
    error: "Embedding request timed out",
  });
});

test("POST project investigate returns empty evidence when no fragments match", async () => {
  const requestedUrls: string[] = [];
  const app = createTestApp();

  registerInvestigationRoutes(
    app,
    createFakeEmbeddingStore({
      searchSimilarChunks: async () => [],
    }),
    {
      aiOrchestratorUrl: "http://127.0.0.1:8001",
      fetchImpl: async (input) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url === "http://127.0.0.1:8001/embeddings") {
          return Response.json(fakeEmbeddingPayload(1));
        }

        // Respuesta de reserva: no debería llamarse al chat.
        return Response.json({
          model: "qwen3.5:4b",
          response: "Esta respuesta no debería utilizarse.",
        });
      },
    },
  );

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question: "¿Qué sabemos sobre este incidente?",
    },
  });

  assert.equal(response.statusCode, 200);

  const payload = response.json() as {
    data: {
      model: string;
      response: string;
      evidence: unknown[];
    };
  };

  assert.equal(payload.data.model, "not-invoked");
  assert.deepEqual(payload.data.evidence, []);

  assert.ok(
    payload.data.response.includes(
      "La recuperación no produjo evidencia",
    ),
  );

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:8001/embeddings",
  ]);
});
test("POST project investigate filters low-similarity matches without invoking chat", async () => {
  const requestedUrls: string[] = [];
  const app = createTestApp();

  registerInvestigationRoutes(
    app,
    createFakeEmbeddingStore({
      searchSimilarChunks: async () => [
        {
          id: "0adad1b6-e9f4-4f16-aeea-6da618741466",
          projectId: sourceTestProjectId,
          documentId: "2bf11722-4a62-4ed9-bc94-1fea8407edc9",
          ordinal: 0,
          content:
            "Documento de prueba almacenado en PostgreSQL para SentinelOps AI.",
          score: 0.3815711866063125,
        },
      ],
    }),
    {
      aiOrchestratorUrl: "http://127.0.0.1:8001",
      fetchImpl: async (input) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url === "http://127.0.0.1:8001/embeddings") {
          return Response.json(fakeEmbeddingPayload(1));
        }

        return Response.json({
          model: "qwen3.5:4b",
          response: "Esta respuesta no debería utilizarse.",
        });
      },
    },
  );

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question:
        "Which service produced an HTTP 500 error?",
    },
  });

  assert.equal(response.statusCode, 200);

  const payload = response.json() as {
    data: {
      model: string;
      response: string;
      evidence: unknown[];
    };
  };

  assert.equal(payload.data.model, "not-invoked");
  assert.deepEqual(payload.data.evidence, []);

  assert.ok(
    payload.data.response.includes(
      "La recuperación no produjo evidencia",
    ),
  );

  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:8001/embeddings",
  ]);
});

test("incident investigation retains measured relevant evidence above its calibrated threshold", async () => {
  const requestedUrls: string[] = [];
  const app = createTestApp();

  registerInvestigationRoutes(
    app,
    createFakeEmbeddingStore({
      searchSimilarChunks: async () => [
        {
          ...chunkTestRecord,
          sourceId: sourceTestRecord.id,
          score: 0.414,
          metadata: { incidentId: "INC-001" },
        },
      ],
    }),
    {
      aiOrchestratorUrl: "http://127.0.0.1:8001",
      fetchImpl: async (input) => {
        const url = String(input);
        requestedUrls.push(url);

        if (url === "http://127.0.0.1:8001/embeddings") {
          return Response.json(fakeEmbeddingPayload(1));
        }

        return Response.json({
          model: "qwen3.5:4b",
          response: structuredInvestigationResponse(),
        });
      },
    },
  );

  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${sourceTestProjectId}/investigate`,
    payload: {
      question:
        "Describe la cronología de INC-001, explica el significado de las métricas del pool y separa hechos, hipótesis e información faltante.",
      incidentId: "INC-001",
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.model, "qwen3.5:4b");
  assert.equal(response.json().data.evidence[0].score, 0.414);
  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:8001/embeddings",
    "http://127.0.0.1:8001/chat",
  ]);
});
