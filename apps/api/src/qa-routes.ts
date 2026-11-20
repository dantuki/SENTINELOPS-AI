import type { FastifyInstance } from "fastify";

import type { QaAnalysisReport } from "./qa-analysis.js";
import {
  executeQaAnalysis,
  isGithubImportFailure,
  isQaAnalysisExecutionError,
  type QaSourceStore,
} from "./qa-analysis-execution.js";
import { GithubImportError } from "./github-repository-import.js";
import type { QaConversationRecord, QaConversationRepository } from "./qa-conversation-repository.js";

export type { QaSourceStore } from "./qa-analysis-execution.js";

interface QaRouteOptions {
  sourceStore?: QaSourceStore;
  fetchImpl?: typeof fetch;
  conversationStore?: Pick<
    QaConversationRepository,
    "getConversation" | "createConversation" | "recordCompletedAnalysis" | "addMessage"
  >;
}

interface GithubImportRequest {
  repositoryUrl: string;
  conversationId?: string;
}

interface ApiError {
  error: string;
}

interface GithubQaResult {
  source: { id: string; created: boolean; status: "active" };
  persistence?: { status: "unavailable" };
  conversation?: QaConversationRecord;
  repository: {
    url: string;
    owner: string;
    name: string;
    defaultBranch: string;
    revision: string;
    inspectedFileCount: number;
    inventory: QaAnalysisReport["inventory"];
    skipped: { unsupported: number; tooLarge: number; invalidPath: number; limitReached: number };
  };
  analysis: QaAnalysisReport;
}

const apiErrorSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: false,
} as const;

const githubImportRequestSchema = {
  type: "object",
  properties: {
    repositoryUrl: { type: "string", minLength: 1, maxLength: 2048 },
    conversationId: { type: "string", format: "uuid" },
  },
  required: ["repositoryUrl"],
  additionalProperties: false,
} as const;

const githubImportResponseSchema = {
  type: "object",
  properties: { data: { type: "object", additionalProperties: true } },
  required: ["data"],
  additionalProperties: false,
} as const;

export function mapGithubImportError(error: GithubImportError): {
  statusCode: 400 | 404 | 409 | 422 | 429 | 502 | 503 | 504;
  message: string;
} {
  switch (error.code) {
    case "invalid_repository_url":
      return { statusCode: 400, message: "La URL debe ser un repositorio público canónico de github.com." };
    case "repository_not_found":
      return { statusCode: 404, message: "No se encontró el repositorio público indicado." };
    case "repository_not_public":
      return { statusCode: 422, message: "Solo se pueden importar repositorios públicos de GitHub." };
    case "github_rate_limited":
      return { statusCode: 429, message: "GitHub limitó temporalmente las solicitudes. Espera antes de iniciar un nuevo análisis." };
    case "github_secondary_rate_limited":
      return { statusCode: 429, message: "GitHub limitó temporalmente esta actividad. Espera antes de iniciar un nuevo análisis." };
    case "github_forbidden":
      return { statusCode: 502, message: "GitHub rechazó la solicitud de análisis para este repositorio público." };
    case "repository_too_large":
      return { statusCode: 422, message: "El repositorio supera los límites seguros de inspección del MVP." };
    case "repository_tree_truncated":
      return { statusCode: 422, message: "GitHub devolvió un inventario de archivos truncado; no es seguro analizarlo de forma parcial." };
    case "unsupported_repository_content":
      return { statusCode: 422, message: "El repositorio contiene contenido no compatible con la inspección segura." };
    case "github_timeout":
      return { statusCode: 504, message: "GitHub tardó demasiado en responder." };
    case "analysis_timeout":
      return { statusCode: 504, message: "El análisis excedió el tiempo seguro de ejecución." };
    case "invalid_github_response":
      return { statusCode: 502, message: "GitHub devolvió una respuesta no válida para el análisis." };
    case "github_unavailable":
      return { statusCode: 503, message: "GitHub no está disponible temporalmente." };
    case "internal_analysis_error":
      return { statusCode: 503, message: "No se pudo completar la importación y el análisis." };
  }
}

export function mapQaAnalysisExecutionError(error: { code: string }): {
  statusCode: 404 | 409 | 422 | 503;
  message: string;
} {
  switch (error.code) {
    case "project_not_found":
    case "conversation_not_found":
      return { statusCode: 404, message: "Resource not found" };
    case "source_disabled":
      return { statusCode: 409, message: "El origen de este repositorio está deshabilitado para el proyecto." };
    case "analysis_integrity_failed":
      return { statusCode: 422, message: "El análisis no superó la verificación de evidencia." };
    case "persistence_unavailable":
      return { statusCode: 503, message: "No se pudo confirmar la persistencia del análisis." };
    default:
      return { statusCode: 503, message: "No se pudo completar la importación y el análisis." };
  }
}

/** Legacy synchronous endpoint, retained for compatible callers. */
export function registerQaRoutes(app: FastifyInstance, options: QaRouteOptions = {}): void {
  app.post<{
    Params: { projectId: string };
    Body: GithubImportRequest;
    Reply: { data: GithubQaResult } | ApiError;
  }>(
    "/api/projects/:projectId/qa/github",
    {
      schema: {
        params: {
          type: "object",
          properties: { projectId: { type: "string", format: "uuid" } },
          required: ["projectId"],
          additionalProperties: false,
        },
        body: githubImportRequestSchema,
        response: {
          200: githubImportResponseSchema,
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
      if (!options.sourceStore) return reply.code(503).send({ error: "Persistence unavailable" });
      try {
        const result = await executeQaAnalysis({
          projectId: request.params.projectId,
          userId: request.authUser?.id,
          repositoryUrl: request.body.repositoryUrl,
          conversationId: request.body.conversationId,
          sourceStore: options.sourceStore,
          conversationStore: options.conversationStore,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        const body: GithubQaResult = {
          source: result.source,
          repository: result.repository,
          analysis: result.analysis,
          ...(result.conversation ? { conversation: result.conversation } : {}),
          ...(result.persistenceUnavailable ? { persistence: { status: "unavailable" } } : {}),
        };
        return reply.code(200).send({ data: body });
      } catch (error: unknown) {
        if (isGithubImportFailure(error)) {
          const mapped = mapGithubImportError(error);
          return reply.code(mapped.statusCode).send({ error: mapped.message });
        }
        if (isQaAnalysisExecutionError(error)) {
          const mapped = mapQaAnalysisExecutionError(error);
          return reply.code(mapped.statusCode).send({ error: mapped.message });
        }
        request.log.error({ err: error }, "QA static analysis failed");
        return reply.code(503).send({ error: "No se pudo completar la importación y el análisis." });
      }
    },
  );
}
