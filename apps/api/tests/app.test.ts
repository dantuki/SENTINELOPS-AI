import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../src/app.js";
import type {
  CreateDocumentChunkInput,
  DocumentChunkRecord,
} from "../src/chunk-repository.js";
import { registerChunkRoutes } from "../src/chunk-routes.js";
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
