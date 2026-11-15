import type { FastifyInstance } from "fastify";

import {
  analyzeQaProject,
  type QaAnalysisReport,
} from "./qa-analysis.js";
import {
  GithubImportError,
  importPublicGithubRepository,
  parseGithubRepositoryUrl,
} from "./github-repository-import.js";
import type {
  CreateProjectSourceInput,
  EnsureProjectSourceResult,
  ProjectSourceRecord,
} from "./source-repository.js";

interface QaSourceStore {
  listForProject(projectId: string): Promise<ProjectSourceRecord[] | null>;
  ensureForProject(
    projectId: string,
    input: CreateProjectSourceInput,
  ): Promise<EnsureProjectSourceResult | null>;
  activateIfEnabled(projectId: string, sourceId: string): Promise<boolean>;
}

interface QaRouteOptions {
  sourceStore?: QaSourceStore;
  fetchImpl?: typeof fetch;
}

interface GithubImportRequest {
  repositoryUrl: string;
}

interface ApiError {
  error: string;
}

interface GithubQaResult {
  source: {
    id: string;
    created: boolean;
    status: "active";
  };
  repository: {
    url: string;
    owner: string;
    name: string;
    defaultBranch: string;
    revision: string;
    inspectedFileCount: number;
    inventory: QaAnalysisReport["inventory"];
    skipped: {
      unsupported: number;
      tooLarge: number;
      invalidPath: number;
      limitReached: number;
    };
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
    repositoryUrl: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
    },
  },
  required: ["repositoryUrl"],
  additionalProperties: false,
} as const;

const githubImportResponseSchema = {
  type: "object",
  properties: {
    data: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

function mapGithubImportError(error: GithubImportError): {
  statusCode: 400 | 404 | 409 | 422 | 502 | 503 | 504;
  message: string;
} {
  switch (error.code) {
    case "invalid_repository_url":
      return { statusCode: 400, message: "La URL debe ser un repositorio público canónico de github.com." };
    case "repository_not_found":
      return { statusCode: 404, message: "No se encontró el repositorio público indicado." };
    case "repository_not_public":
      return { statusCode: 422, message: "Solo se pueden importar repositorios públicos de GitHub." };
    case "repository_limit_exceeded":
      return { statusCode: 422, message: "El repositorio supera los límites seguros de inspección del MVP." };
    case "github_timeout":
      return { statusCode: 504, message: "GitHub tardó demasiado en responder." };
    case "github_invalid_response":
      return { statusCode: 502, message: "GitHub devolvió una respuesta no válida para el análisis." };
    case "github_unavailable":
      return { statusCode: 503, message: "GitHub no está disponible temporalmente." };
  }
}

/**
 * Registers a project-scoped, public-GitHub-only static QA import.
 * The route intentionally persists source metadata but never imported file bodies.
 */
export function registerQaRoutes(
  app: FastifyInstance,
  options: QaRouteOptions = {},
): void {
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
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.sourceStore) {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }

      let reference;
      try {
        reference = parseGithubRepositoryUrl(request.body.repositoryUrl);
      } catch (error: unknown) {
        if (error instanceof GithubImportError) {
          const mapped = mapGithubImportError(error);
          return reply.code(mapped.statusCode).send({ error: mapped.message });
        }
        return reply.code(400).send({ error: "La URL del repositorio no es válida." });
      }

      try {
        const existingSources = await options.sourceStore.listForProject(request.params.projectId);
        if (existingSources === null) {
          return reply.code(404).send({ error: "Project not found" });
        }
        if (existingSources.some((source) =>
          source.sourceType === "git_repository" &&
          source.locator === reference.canonicalUrl &&
          source.status === "disabled",
        )) {
          return reply.code(409).send({ error: "El origen de este repositorio está deshabilitado para el proyecto." });
        }

        const imported = await importPublicGithubRepository(
          reference.canonicalUrl,
          { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) },
        );
        const persisted = await options.sourceStore.ensureForProject(
          request.params.projectId,
          {
            sourceType: "git_repository",
            name: `${imported.owner}/${imported.repository}`,
            locator: imported.canonicalUrl,
            metadata: {
              provider: "github",
              owner: imported.owner,
              repository: imported.repository,
              defaultBranch: imported.defaultBranch,
              revision: imported.revision,
              inspectedFileCount: imported.files.length,
            },
          },
        );
        if (!persisted) {
          return reply.code(404).send({ error: "Project not found" });
        }
        const active = persisted.source.status === "active" || await options.sourceStore.activateIfEnabled(
          request.params.projectId,
          persisted.source.id,
        );
        if (!active) {
          return reply.code(409).send({ error: "El origen del repositorio no está habilitado para este proyecto." });
        }

        const analysis = analyzeQaProject({
          repositoryUrl: imported.canonicalUrl,
          revision: imported.revision,
          files: imported.files,
          inventory: imported.inventory,
        });
        const result: GithubQaResult = {
          source: { id: persisted.source.id, created: persisted.created, status: "active" },
          repository: {
            url: imported.canonicalUrl,
            owner: imported.owner,
            name: imported.repository,
            defaultBranch: imported.defaultBranch,
            revision: imported.revision,
            inspectedFileCount: imported.files.length,
            inventory: imported.inventory,
            skipped: imported.skipped,
          },
          analysis,
        };
        return reply.code(200).send({ data: result });
      } catch (error: unknown) {
        if (error instanceof GithubImportError) {
          const mapped = mapGithubImportError(error);
          return reply.code(mapped.statusCode).send({ error: mapped.message });
        }
        return reply.code(503).send({ error: "No se pudo completar la importación y el análisis." });
      }
    },
  );
}
