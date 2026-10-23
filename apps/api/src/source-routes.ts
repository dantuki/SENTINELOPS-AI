
import type { FastifyInstance } from "fastify";

import type {
  CreateProjectSourceInput,
  ProjectSourceRecord,
} from "./source-repository.js";

interface ProjectSourceStore {
  listForProject(
    projectId: string,
  ): Promise<ProjectSourceRecord[] | null>;

  createForProject(
    projectId: string,
    input: CreateProjectSourceInput,
  ): Promise<ProjectSourceRecord | null>;
}

interface ApiError {
  error: string;
}

const apiErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
  required: ["error"],
  additionalProperties: false,
} as const;

const uuidSchema = {
  type: "string",
  format: "uuid",
} as const;

const sourceSchema = {
  type: "object",
  properties: {
    id: uuidSchema,
    projectId: uuidSchema,
    sourceType: {
      type: "string",
      enum: [
        "file_upload",
        "git_repository",
        "web_url",
        "manual",
        "log_bundle",
      ],
    },
    name: { type: "string" },
    locator: { type: "string" },
    status: {
      type: "string",
      enum: ["pending", "active", "disabled", "failed"],
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "projectId",
    "sourceType",
    "name",
    "locator",
    "status",
    "metadata",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const sourceListSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: sourceSchema,
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const sourceDataSchema = {
  type: "object",
  properties: {
    data: sourceSchema,
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const createSourceSchema = {
  type: "object",
  properties: {
    sourceType: {
      type: "string",
      enum: [
        "file_upload",
        "git_repository",
        "web_url",
        "manual",
        "log_bundle",
      ],
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      pattern: "\\S",
    },
    locator: {
      type: "string",
      minLength: 1,
      maxLength: 2048,
      pattern: "\\S",
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["sourceType", "name", "locator"],
  additionalProperties: false,
} as const;

function isPostgresErrorCode(
  error: unknown,
  expectedCode: string,
): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expectedCode
  );
}

export function registerSourceRoutes(
  app: FastifyInstance,
  store?: ProjectSourceStore,
): void {
  app.get<{
    Params: { projectId: string };
    Reply: { data: ProjectSourceRecord[] } | ApiError;
  }>(
    "/api/projects/:projectId/sources",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            projectId: uuidSchema,
          },
          required: ["projectId"],
          additionalProperties: false,
        },
        response: {
          200: sourceListSchema,
          404: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      try {
        const data = await store.listForProject(
          request.params.projectId,
        );

        if (data === null) {
          return reply.code(404).send({
            error: "Project not found",
          });
        }

        return reply.code(200).send({ data });
      } catch {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: CreateProjectSourceInput;
    Reply: { data: ProjectSourceRecord } | ApiError;
  }>(
    "/api/projects/:projectId/sources",
    {
      schema: {
        params: {
          type: "object",
          properties: {
            projectId: uuidSchema,
          },
          required: ["projectId"],
          additionalProperties: false,
        },
        body: createSourceSchema,
        response: {
          201: sourceDataSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }

      try {
        const data = await store.createForProject(
          request.params.projectId,
          request.body,
        );

        if (data === null) {
          return reply.code(404).send({
            error: "Project not found",
          });
        }

        return reply.code(201).send({ data });
      } catch (error: unknown) {
        if (isPostgresErrorCode(error, "23505")) {
          return reply.code(409).send({
            error: "Source already exists for this project and type",
          });
        }

        return reply.code(503).send({
          error: "Persistence unavailable",
        });
      }
    },
  );
}
