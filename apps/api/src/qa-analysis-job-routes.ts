import type { FastifyInstance } from "fastify";

import { parseGithubRepositoryUrl, GithubImportError } from "./github-repository-import.js";
import { QaAnalysisJobRepository } from "./qa-analysis-job-repository.js";
import { QaAnalysisJobRunner } from "./qa-analysis-job-runner.js";
import type { QaConversationRepository } from "./qa-conversation-repository.js";
import { mapGithubImportError } from "./qa-routes.js";
import { QA_PERSISTENCE_UNAVAILABLE_MESSAGE } from "./qa-persistence.js";

interface QaAnalysisJobRouteOptions {
  jobStore?: QaAnalysisJobRepository;
  runner?: QaAnalysisJobRunner;
  conversationStore?: Pick<QaConversationRepository, "getConversation">;
}

interface CreateQaAnalysisJobRequest {
  repositoryUrl: string;
  conversationId?: string;
  idempotencyKey: string;
}

interface ApiError {
  error: string;
}

const apiErrorSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: false,
} as const;

const jobRequestSchema = {
  type: "object",
  properties: {
    repositoryUrl: { type: "string", minLength: 1, maxLength: 2048 },
    conversationId: { type: "string", format: "uuid" },
    idempotencyKey: { type: "string", format: "uuid" },
  },
  required: ["repositoryUrl", "idempotencyKey"],
  additionalProperties: false,
} as const;

const jobResponseSchema = {
  type: "object",
  properties: { data: { type: "object", additionalProperties: true } },
  required: ["data"],
  additionalProperties: false,
} as const;

/** Project-scoped durable job API. Events are read by authenticated polling. */
export function registerQaAnalysisJobRoutes(app: FastifyInstance, options: QaAnalysisJobRouteOptions = {}): void {
  app.post<{
    Params: { projectId: string };
    Body: CreateQaAnalysisJobRequest;
    Reply: { data: { job: unknown; created: boolean } } | ApiError;
  }>(
    "/api/projects/:projectId/qa/jobs",
    {
      schema: {
        params: {
          type: "object",
          properties: { projectId: { type: "string", format: "uuid" } },
          required: ["projectId"],
          additionalProperties: false,
        },
        body: jobRequestSchema,
        response: {
          202: jobResponseSchema,
          400: apiErrorSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
          429: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.jobStore || !options.runner) {
        return reply.code(503).send({ error: QA_PERSISTENCE_UNAVAILABLE_MESSAGE });
      }
      let canonicalUrl: string;
      try {
        canonicalUrl = parseGithubRepositoryUrl(request.body.repositoryUrl).canonicalUrl;
      } catch (error: unknown) {
        if (error instanceof GithubImportError) {
          const mapped = mapGithubImportError(error);
          return reply.code(mapped.statusCode).send({ error: mapped.message });
        }
        return reply.code(400).send({ error: "La URL del repositorio no es válida." });
      }
      if (request.body.conversationId && options.conversationStore) {
        const conversation = await options.conversationStore.getConversation(
          request.params.projectId,
          request.body.conversationId,
        );
        if (!conversation) return reply.code(404).send({ error: "Resource not found" });
      }
      if (!request.authUser) return reply.code(503).send({ error: "Authentication unavailable" });
      const created = await options.jobStore.createOrGet({
        projectId: request.params.projectId,
        userId: request.authUser.id,
        ...(request.body.conversationId ? { conversationId: request.body.conversationId } : {}),
        repositoryUrl: canonicalUrl,
        idempotencyKey: request.body.idempotencyKey,
      });
      if (!created) return reply.code(404).send({ error: "Resource not found" });
      if (created.job.status === "queued") options.runner.enqueue(request.params.projectId, created.job.id);
      return reply.code(202).send({ data: created });
    },
  );

  app.get<{
    Params: { projectId: string; jobId: string };
    Querystring: { afterSequence?: number };
    Reply: { data: { job: unknown; events: unknown } } | ApiError;
  }>(
    "/api/projects/:projectId/qa/jobs/:jobId",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            projectId: { type: "string", format: "uuid" },
            jobId: { type: "string", format: "uuid" },
          },
          required: ["projectId", "jobId"],
          additionalProperties: false,
        },
        querystring: {
          type: "object",
          properties: { afterSequence: { type: "integer", minimum: 0, maximum: 1000000 } },
          additionalProperties: false,
        },
        response: { 200: jobResponseSchema, 404: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request, reply) => {
      if (!options.jobStore) return reply.code(503).send({ error: QA_PERSISTENCE_UNAVAILABLE_MESSAGE });
      const job = await options.jobStore.get(request.params.projectId, request.params.jobId);
      if (!job) return reply.code(404).send({ error: "Resource not found" });
      const events = await options.jobStore.listEvents(
        request.params.projectId,
        request.params.jobId,
        request.query.afterSequence ?? 0,
      );
      if (events === null) return reply.code(404).send({ error: "Resource not found" });
      return reply.code(200).send({ data: { job, events } });
    },
  );
}
