
import type { FastifyInstance } from "fastify";

import type {
  CreateIncidentInput,
  CreateProjectInput,
  CreateWorkspaceInput,
  IncidentRecord,
  ProjectRecord,
  ProductStore,
  WorkspaceRecord,
} from "./product-repository.js";

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

const workspaceSchema = {
  type: "object",
  properties: {
    id: uuidSchema,
    slug: { type: "string" },
    name: { type: "string" },
    status: { type: "string", enum: ["active", "archived"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "slug", "name", "status", "createdAt", "updatedAt"],
  additionalProperties: false,
} as const;

const projectSchema = {
  type: "object",
  properties: {
    id: uuidSchema,
    workspaceId: uuidSchema,
    slug: { type: "string" },
    name: { type: "string" },
    description: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    status: { type: "string", enum: ["active", "archived"] },
    settings: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "workspaceId",
    "slug",
    "name",
    "description",
    "status",
    "settings",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const incidentSchema = {
  type: "object",
  properties: {
    id: uuidSchema,
    projectId: uuidSchema,
    externalReference: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    title: { type: "string" },
    description: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    serviceName: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    severity: {
      type: "string",
      enum: ["critical", "high", "medium", "low", "informational", "unknown"],
    },
    status: {
      type: "string",
      enum: ["new", "triaged", "investigating", "resolved", "closed"],
    },
    context: { type: "object", additionalProperties: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "projectId",
    "externalReference",
    "title",
    "description",
    "serviceName",
    "severity",
    "status",
    "context",
    "createdAt",
    "updatedAt",
  ],
  additionalProperties: false,
} as const;

const workspaceDataSchema = {
  type: "object",
  properties: { data: workspaceSchema },
  required: ["data"],
  additionalProperties: false,
} as const;

const workspaceListSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: workspaceSchema },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const projectDataSchema = {
  type: "object",
  properties: { data: projectSchema },
  required: ["data"],
  additionalProperties: false,
} as const;

const projectListSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: projectSchema },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const incidentDataSchema = {
  type: "object",
  properties: { data: incidentSchema },
  required: ["data"],
  additionalProperties: false,
} as const;

const incidentListSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: incidentSchema },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const slugSchema = {
  type: "string",
  minLength: 1,
  maxLength: 80,
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
} as const;

const createWorkspaceSchema = {
  type: "object",
  properties: {
    slug: slugSchema,
    name: { type: "string", minLength: 1, maxLength: 120 },
  },
  required: ["slug", "name"],
  additionalProperties: false,
} as const;

const createProjectSchema = {
  type: "object",
  properties: {
    slug: slugSchema,
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: {
      anyOf: [
        { type: "string", maxLength: 4000 },
        { type: "null" },
      ],
    },
  },
  required: ["slug", "name"],
  additionalProperties: false,
} as const;

const createIncidentSchema = {
  type: "object",
  properties: {
    externalReference: {
      anyOf: [
        { type: "string", maxLength: 200 },
        { type: "null" },
      ],
    },
    title: { type: "string", minLength: 1, maxLength: 300 },
    description: {
      anyOf: [
        { type: "string", maxLength: 10000 },
        { type: "null" },
      ],
    },
    serviceName: {
      anyOf: [
        { type: "string", maxLength: 200 },
        { type: "null" },
      ],
    },
    severity: {
      type: "string",
      enum: ["critical", "high", "medium", "low", "informational", "unknown"],
    },
    context: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["title", "severity"],
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

export function registerProductRoutes(
  app: FastifyInstance,
  store?: ProductStore,
): void {
  app.get<{ Reply: { data: WorkspaceRecord[] } | ApiError }>(
    "/api/workspaces",
    {
      schema: {
        response: {
          200: workspaceListSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (_request, reply) => {
      if (!store) {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }

      try {
        const data = await store.listWorkspaces();
        return reply.code(200).send({ data });
      } catch {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }
    },
  );

  app.post<{
    Body: CreateWorkspaceInput;
    Reply: { data: WorkspaceRecord } | ApiError;
  }>(
    "/api/workspaces",
    {
      schema: {
        body: createWorkspaceSchema,
        response: {
          201: workspaceDataSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }

      try {
        const data = await store.createWorkspace(request.body);
        return reply.code(201).send({ data });
      } catch (error: unknown) {
        if (isPostgresErrorCode(error, "23505")) {
          return reply.code(409).send({ error: "Workspace slug already exists" });
        }

        return reply.code(503).send({ error: "Persistence unavailable" });
      }
    },
  );

  app.get<{
    Params: { workspaceId: string };
    Reply: { data: ProjectRecord[] } | ApiError;
  }>(
    "/api/workspaces/:workspaceId/projects",
    {
      schema: {
        params: {
          type: "object",
          properties: { workspaceId: uuidSchema },
          required: ["workspaceId"],
          additionalProperties: false,
        },
        response: {
          200: projectListSchema,
          404: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }

      try {
        const data = await store.listProjects(request.params.workspaceId);

        if (data === null) {
          return reply.code(404).send({ error: "Workspace not found" });
        }

        return reply.code(200).send({ data });
      } catch {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }
    },
  );

  app.post<{
    Params: { workspaceId: string };
    Body: CreateProjectInput;
    Reply: { data: ProjectRecord } | ApiError;
  }>(
    "/api/workspaces/:workspaceId/projects",
    {
      schema: {
        params: {
          type: "object",
          properties: { workspaceId: uuidSchema },
          required: ["workspaceId"],
          additionalProperties: false,
        },
        body: createProjectSchema,
        response: {
          201: projectDataSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }

      try {
        const data = await store.createProject(
          request.params.workspaceId,
          request.body,
        );

        if (data === null) {
          return reply.code(404).send({ error: "Workspace not found" });
        }

        return reply.code(201).send({ data });
      } catch (error: unknown) {
        if (isPostgresErrorCode(error, "23505")) {
          return reply.code(409).send({
            error: "Project slug already exists in this workspace",
          });
        }

        return reply.code(503).send({ error: "Persistence unavailable" });
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Reply: { data: IncidentRecord[] } | ApiError;
  }>(
    "/api/projects/:projectId/incidents",
    {
      schema: {
        params: {
          type: "object",
          properties: { projectId: uuidSchema },
          required: ["projectId"],
          additionalProperties: false,
        },
        response: {
          200: incidentListSchema,
          404: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }

      try {
        const data = await store.listIncidents(request.params.projectId);

        if (data === null) {
          return reply.code(404).send({ error: "Project not found" });
        }

        return reply.code(200).send({ data });
      } catch {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }
    },
  );

  app.post<{
    Params: { projectId: string };
    Body: CreateIncidentInput;
    Reply: { data: IncidentRecord } | ApiError;
  }>(
    "/api/projects/:projectId/incidents",
    {
      schema: {
        params: {
          type: "object",
          properties: { projectId: uuidSchema },
          required: ["projectId"],
          additionalProperties: false,
        },
        body: createIncidentSchema,
        response: {
          201: incidentDataSchema,
          404: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!store) {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }

      try {
        const data = await store.createIncident(
          request.params.projectId,
          request.body,
        );

        if (data === null) {
          return reply.code(404).send({ error: "Project not found" });
        }

        return reply.code(201).send({ data });
      } catch {
        return reply.code(503).send({ error: "Persistence unavailable" });
      }
    },
  );
}
