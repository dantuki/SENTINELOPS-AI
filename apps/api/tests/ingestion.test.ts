import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";

import {
  type ChunkEmbeddingInput,
  type DocumentChunkRecord,
  type PendingEmbeddingChunk,
} from "../src/chunk-repository.js";
import {
  type DocumentRecord,
  type IngestionDocumentRecord,
  type IngestionState,
} from "../src/document-repository.js";
import { buildApp } from "../src/app.js";
import { registerIngestionRoutes } from "../src/ingestion-routes.js";
import type {
  CreateIncidentInput,
  IncidentRecord,
} from "../src/product-repository.js";
import {
  chunkTechnicalText,
  validateIngestionFile,
} from "../src/ingestion-utils.js";
import type {
  CreateProjectSourceInput,
  EnsureProjectSourceResult,
  ProjectSourceRecord,
  ProjectSourceStatus,
} from "../src/source-repository.js";

const projectId = "22222222-2222-4222-8222-222222222222";
const sourceId = "44444444-4444-4444-8444-444444444444";
const sourceDate = new Date("2026-01-01T00:00:00.000Z");
const sourceRecord: ProjectSourceRecord = {
  id: sourceId,
  projectId,
  sourceType: "file_upload",
  name: "Uploaded technical files",
  locator: "upload://",
  status: "pending",
  metadata: {},
  createdAt: sourceDate,
  updatedAt: sourceDate,
};

function documentId(index: number): string {
  return `55555555-5555-4555-8555-${index.toString().padStart(12, "0")}`;
}

function chunkId(index: number): string {
  return `66666666-6666-4666-8666-${index.toString().padStart(12, "0")}`;
}

function createIngestionTestContext(
  fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { texts: string[] };
    return Response.json(fakeEmbeddingPayload(body.texts.length));
  },
) {
  const documents = new Map<string, IngestionDocumentRecord>();
  const chunks = new Map<string, DocumentChunkRecord>();
  const embeddedChunkIds = new Set<string>();
  const sourceInputs: CreateProjectSourceInput[] = [];
  const sourceStatuses: ProjectSourceStatus[] = [];
  let currentSourceStatus: ProjectSourceStatus = "pending";
  const incidents = new Map<string, IncidentRecord>();
  const incidentInputs: Array<CreateIncidentInput & { externalReference: string }> = [];
  const embeddingBatches: string[][] = [];
  let nextDocumentId = 1;
  let nextChunkId = 1;

  const app = buildApp({ logger: false });

  registerIngestionRoutes(
    app,
    {
      sources: {
        ensureForProject: async (_id, input): Promise<EnsureProjectSourceResult> => {
          sourceInputs.push(input);
          return {
            source: {
              ...sourceRecord,
              sourceType: input.sourceType,
              name: input.name,
              locator: input.locator,
              status: currentSourceStatus,
              metadata: input.metadata ?? {},
            },
            created: sourceInputs.length === 1,
          };
        },
        getForProject: async (_projectId, id) =>
          id === sourceId
            ? { ...sourceRecord, status: currentSourceStatus }
            : null,
        activateIfEnabled: async (_projectId, id) => {
          if (id !== sourceId || currentSourceStatus === "disabled") {
            return false;
          }

          currentSourceStatus = "active";
          sourceStatuses.push(currentSourceStatus);
          return true;
        },
      },
      incidents: {
        ensureIncident: async (id, input) => {
          if (id !== projectId) {
            return null;
          }

          incidentInputs.push(input);
          const key = `${id}:${input.externalReference}`;
          const existing = incidents.get(key);
          if (existing) {
            return { incident: existing, created: false };
          }

          const incident: IncidentRecord = {
            id: "33333333-3333-4333-8333-333333333333",
            projectId: id,
            externalReference: input.externalReference,
            title: input.title,
            description: input.description ?? null,
            serviceName: input.serviceName ?? null,
            severity: input.severity,
            status: "new",
            context: input.context ?? {},
            createdAt: sourceDate,
            updatedAt: sourceDate,
          };
          incidents.set(key, incident);
          return { incident, created: true };
        },
      },
      documents: {
        createOrGetForProject: async (_projectId, input) => {
          const existing = [...documents.values()].find(
            (document) => document.contentSha256 === input.contentSha256,
          );
          if (existing) {
            return { document: existing, created: false };
          }

          const id = documentId(nextDocumentId++);
          const document: IngestionDocumentRecord = {
            id,
            projectId,
            sourceId: input.sourceId,
            sourceDocumentKey: input.sourceDocumentKey ?? null,
            title: input.title,
            mediaType: input.mediaType ?? null,
            contentSha256: input.contentSha256,
            status: "discovered",
            metadata: input.metadata ?? {},
            createdAt: sourceDate,
            updatedAt: sourceDate,
            extractedText: input.extractedText ?? null,
          };
          documents.set(id, document);
          return { document, created: true };
        },
        getForIngestion: async (_projectId, id) =>
          documents.get(id) ?? null,
        claimForProcessing: async (_projectId, id) => {
          const document = documents.get(id);
          if (!document) {
            return null;
          }

          if (
            document.status !== "discovered" &&
            document.status !== "failed"
          ) {
            return { document, claimed: false };
          }

          const metadata = document.metadata;
          const previous = isRecord(metadata.ingestion)
            ? metadata.ingestion
            : {};
          const oldAttempts = previous.attempts;
          const attempts =
            typeof oldAttempts === "number" ? oldAttempts + 1 : 1;
          const updated: IngestionDocumentRecord = {
            ...document,
            status: "processing",
            metadata: {
              ...metadata,
              ingestion: {
                ...previous,
                status: "processing",
                attempts,
                startedAt: new Date().toISOString(),
                completedAt: null,
                error: null,
              },
            },
          };
          documents.set(id, updated);
          return { document: updated, claimed: true };
        },
        setIngestionState: async (_projectId, id, state: IngestionState) => {
          const document = documents.get(id);
          if (!document) {
            return false;
          }

          const previous = isRecord(document.metadata.ingestion)
            ? document.metadata.ingestion
            : {};
          documents.set(id, {
            ...document,
            status: state.status,
            metadata: {
              ...document.metadata,
              ingestion: { ...previous, ...state },
            },
          });
          return true;
        },
      },
      chunks: {
        createOrGetForDocument: async (_projectId, docId, input) => {
          const key = `${docId}:${input.ordinal}`;
          const existing = chunks.get(key);
          if (existing) {
            if (existing.content !== input.content) {
              throw new Error("chunk content conflict");
            }
            return { chunk: existing, created: false };
          }

          const chunk: DocumentChunkRecord = {
            id: chunkId(nextChunkId++),
            projectId,
            documentId: docId,
            ordinal: input.ordinal,
            content: input.content,
            tokenCount: null,
            startOffset: input.startOffset,
            endOffset: input.endOffset,
            metadata: input.metadata,
            createdAt: sourceDate,
          };
          chunks.set(key, chunk);
          return { chunk, created: true };
        },
        listWithoutEmbeddingsForDocument: async (
          _projectId,
          docId,
          limit = 32,
        ): Promise<PendingEmbeddingChunk[]> =>
          [...chunks.values()]
            .filter(
              (chunk) =>
                chunk.documentId === docId &&
                !embeddedChunkIds.has(chunk.id),
            )
            .sort((first, second) => first.ordinal - second.ordinal)
            .slice(0, limit),
        saveEmbeddingsForDocument: async (
          _projectId,
          _docId,
          embeddings: ChunkEmbeddingInput[],
        ) => {
          for (const embedding of embeddings) {
            embeddedChunkIds.add(embedding.id);
          }
          return embeddings.length;
        },
      },
    },
    {
      aiOrchestratorUrl: "http://127.0.0.1:8000",
      fetchImpl: async (input, init) => {
        const requestBody = JSON.parse(String(init?.body)) as {
          texts: string[];
        };
        embeddingBatches.push(requestBody.texts);
        return fetchImpl(input, init);
      },
    },
  );

  return {
    app,
    documents,
    chunks,
    embeddedChunkIds,
    sourceInputs,
    sourceStatuses,
    setSourceStatus: (status: ProjectSourceStatus) => {
      currentSourceStatus = status;
    },
    incidents,
    incidentInputs,
    embeddingBatches,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function fakeEmbeddingPayload(count: number): unknown {
  return {
    model: "qwen3-embedding:0.6b",
    dimensions: 1024,
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: 1024 }, () => 0.125),
    })),
  };
}

const apps: FastifyInstance[] = [];

after(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

test("technical chunking preserves source offsets and format strategy", () => {
  const markdown = [
    "# Incident",
    "",
    "Database pool saturation was observed.",
    "",
    "## Follow-up",
    "Inspect the retry policy.",
  ].join("\n");
  const validated = validateIngestionFile("incident.md", markdown);
  const chunks = chunkTechnicalText(markdown, validated.strategy);

  assert.equal(validated.mediaType, "text/markdown");
  assert.equal(validated.strategy, "markdown");
  assert.ok(chunks.length > 0);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= 12_000);
    assert.equal(
      markdown.slice(chunk.startOffset, chunk.endOffset),
      chunk.content,
    );
  }
});

test("file validation rejects credential files, binaries and invalid JSONL", () => {
  assert.throws(() => validateIngestionFile(".env", "TOKEN=secret"));
  assert.throws(() => validateIngestionFile("private-key.pem", "key"));
  assert.throws(() => validateIngestionFile("archive.zip", "data"));
  assert.throws(() =>
    validateIngestionFile("events.jsonl", '{"broken":}\n'),
  );
});

test("POST ingestions hashes, chunks, embeds and indexes a technical file", async () => {
  const context = createIngestionTestContext();
  apps.push(context.app);

  const content =
    '{"timestamp":"2026-10-20T14:03:12Z","service":"postgresql","incident_id":"INC-001"}\n';
  const response = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload: { name: "observed-logs.jsonl", content },
  });

  assert.equal(response.statusCode, 200);
  const result = response.json().data;
  const document = context.documents.get(result.documentId);
  const chunk = [...context.chunks.values()][0];

  assert.equal(result.status, "indexed");
  assert.equal(result.deduplicated, false);
  assert.equal(result.chunksCreated, 1);
  assert.equal(result.embeddingsCreated, 1);
  assert.equal(result.model, "qwen3-embedding:0.6b");
  assert.match(document?.contentSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(document?.metadata.ingestion && isRecord(document.metadata.ingestion), true);
  assert.equal(chunk?.metadata.format, ".jsonl");
  assert.equal(context.embeddedChunkIds.size, 1);
  assert.deepEqual(context.embeddingBatches, [[content.trim()]]);
});

test("same project content is idempotent and is not embedded twice", async () => {
  const context = createIngestionTestContext();
  apps.push(context.app);
  const payload = {
    name: "service.py",
    content: "def health_check():\n    return True\n",
  };

  const first = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload,
  });
  const second = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload,
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().data.deduplicated, true);
  assert.equal(second.json().data.documentId, first.json().data.documentId);
  assert.equal(context.embeddingBatches.length, 1);
  assert.equal(context.documents.size, 1);
});

test("duplicate in-progress uploads are accepted without claiming indexing succeeded", async () => {
  const context = createIngestionTestContext();
  apps.push(context.app);
  const payload = {
    name: "database.log",
    content: "connection pool exhausted\n",
  };
  const first = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload,
  });
  const documentId = first.json().data.documentId as string;
  const document = context.documents.get(documentId);
  assert.ok(document);
  context.documents.set(documentId, { ...document, status: "processing" });

  const inProgress = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload,
  });

  assert.equal(first.statusCode, 200);
  assert.equal(inProgress.statusCode, 202);
  assert.equal(inProgress.json().data.status, "processing");
  assert.equal(context.embeddingBatches.length, 1);
});

test("archived documents are not reported as successfully re-indexed", async () => {
  const context = createIngestionTestContext();
  apps.push(context.app);
  const payload = {
    name: "database.log",
    content: "connection pool exhausted\n",
  };
  const first = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload,
  });
  const id = first.json().data.documentId as string;
  const document = context.documents.get(id);
  assert.ok(document);
  context.documents.set(id, { ...document, status: "archived" });

  const duplicate = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload,
  });

  assert.equal(duplicate.statusCode, 409);
  assert.equal(context.documents.get(id)?.status, "archived");
  assert.equal(context.embeddingBatches.length, 1);
});

test("disabled sources are not reactivated by upload or retry", async () => {
  const context = createIngestionTestContext();
  apps.push(context.app);

  const upload = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload: {
      name: "database.log",
      content: "connection pool exhausted\n",
    },
  });
  const document = [...context.documents.values()][0];
  assert.equal(upload.statusCode, 200);
  assert.ok(document);

  context.setSourceStatus("disabled");
  context.documents.set(document.id, {
    ...document,
    status: "failed",
  });

  const retry = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents/${document.id}/retry`,
  });
  const nextUpload = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload: {
      name: "another.log",
      content: "another event\n",
    },
  });

  assert.equal(retry.statusCode, 409);
  assert.equal(nextUpload.statusCode, 409);
  assert.equal(context.sourceStatuses.at(-1), "active");
  assert.equal(context.documents.size, 1);
});

test("embedding timeouts persist a retryable failure and return 504", async () => {
  const context = createIngestionTestContext(async () =>
    new Response("timeout", { status: 504 }),
  );
  apps.push(context.app);

  const response = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload: {
      name: "database.log",
      content: "connection pool exhausted\n",
    },
  });
  const document = [...context.documents.values()][0];

  assert.equal(response.statusCode, 504);
  assert.equal(document?.status, "failed");
  assert.equal(
    isRecord(document?.metadata.ingestion)
      ? document.metadata.ingestion.error
      : null,
    "embedding_service_timeout",
  );
});

test("failed embeddings persist a retryable state and retry reuses stored content", async () => {
  let unavailable = true;
  const context = createIngestionTestContext(async (_input, init) => {
    if (unavailable) {
      return new Response("private provider error", { status: 500 });
    }

    const body = JSON.parse(String(init?.body)) as { texts: string[] };
    return Response.json(fakeEmbeddingPayload(body.texts.length));
  });
  apps.push(context.app);

  const upload = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload: {
      name: "database.log",
      content: "connection pool exhausted\n",
    },
  });
  const document = [...context.documents.values()][0];

  assert.equal(upload.statusCode, 503);
  assert.equal(document?.status, "failed");
  assert.equal(
    isRecord(document?.metadata.ingestion)
      ? document.metadata.ingestion.error
      : null,
    "embedding_service_unavailable",
  );
  assert.equal(upload.body.includes("private provider error"), false);

  unavailable = false;
  const retry = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents/${document?.id}/retry`,
  });

  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().data.status, "indexed");
  assert.equal(
    isRecord(context.documents.get(document?.id ?? "")?.metadata.ingestion)
      ? context.documents.get(document?.id ?? "")?.metadata.ingestion.attempts
      : null,
    2,
  );
  assert.equal(context.embeddingBatches.length, 2);
});

test("retry persists a failed state when stored document validation fails", async () => {
  const context = createIngestionTestContext();
  apps.push(context.app);
  const upload = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions`,
    payload: {
      name: "database.log",
      content: "connection pool exhausted\n",
    },
  });
  const document = [...context.documents.values()][0];
  assert.equal(upload.statusCode, 200);
  assert.ok(document);

  context.documents.set(document.id, {
    ...document,
    title: "unsupported.exe",
    status: "failed",
  });

  const retry = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents/${document.id}/retry`,
  });

  assert.equal(retry.statusCode, 415);
  assert.equal(context.documents.get(document.id)?.status, "failed");
  assert.equal(context.sourceStatuses.at(-1), "active");
});

test("demo ingestion imports only the allow-listed synthetic logs and code", async () => {
  const context = createIngestionTestContext();
  apps.push(context.app);

  const response = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions/demo`,
  });

  assert.equal(response.statusCode, 200);
  const data = response.json().data;
  assert.equal(data.dataset, "sentinelops-synthetic-demo-v1");
  assert.deepEqual(
    data.files.map((file: { name: string }) => file.name),
    ["observed-logs.jsonl", "retry-dispatcher.synthetic.ts"],
  );
  assert.equal(
    data.files.some((file: { name: string }) => file.name.includes("ground-truth")),
    false,
  );
  assert.equal(context.documents.size, 2);
  assert.equal(
    [...context.documents.values()].every(
      (document) => document.metadata.synthetic === true,
    ),
    true,
  );
  assert.equal(
    [...context.chunks.values()].every(
      (chunk) => chunk.metadata.incidentId === "INC-001",
    ),
    true,
  );
  assert.equal(context.sourceInputs[0]?.sourceType, "log_bundle");
  assert.equal(context.incidents.size, 1);
  assert.equal(context.incidents.get(`${projectId}:INC-001`)?.externalReference, "INC-001");

  const secondImport = await context.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/ingestions/demo`,
  });
  assert.equal(secondImport.statusCode, 200);
  assert.equal(secondImport.json().data.files.every(
    (file: { deduplicated: boolean }) => file.deduplicated,
  ), true);
  assert.equal(context.incidents.size, 1);
});
