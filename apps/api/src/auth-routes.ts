import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  AuthRepository,
  digestToken,
  type ProjectMembershipRecord,
  type AuthUser,
  type ProjectRole,
  type WorkspaceMembershipRecord,
  type WorkspaceRole,
} from "./auth-repository.js";
import type { SecurityConfig } from "./auth-security.js";

interface ApiError {
  error: string;
}

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
  additionalProperties: false,
} as const;

const userSchema = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string" },
    instanceRole: {
      anyOf: [{ type: "string", const: "INSTANCE_ADMIN" }, { type: "null" }],
    },
    lastLoginAt: {
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    },
  },
  required: ["id", "email", "instanceRole", "lastLoginAt"],
  additionalProperties: false,
} as const;

const userResponseSchema = {
  type: "object",
  properties: { data: userSchema },
  required: ["data"],
  additionalProperties: false,
} as const;

const workspaceMembersSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: {
          userId: { type: "string", format: "uuid" },
          email: { type: "string" },
          role: {
            type: "string",
            enum: ["WORKSPACE_OWNER", "WORKSPACE_MEMBER"],
          },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["userId", "email", "role", "createdAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const projectMembersSchema = {
  type: "object",
  properties: {
    data: {
      type: "array",
      items: {
        type: "object",
        properties: {
          userId: { type: "string", format: "uuid" },
          email: { type: "string" },
          role: {
            type: "string",
            enum: ["PROJECT_ADMIN", "INVESTIGATOR", "VIEWER"],
          },
          createdAt: { type: "string", format: "date-time" },
        },
        required: ["userId", "email", "role", "createdAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["data"],
  additionalProperties: false,
} as const;

const emailSchema = {
  type: "string",
  minLength: 3,
  maxLength: 320,
  format: "email",
} as const;

const passwordSchema = {
  type: "string",
  minLength: 12,
  maxLength: 1024,
} as const;

const loginBodySchema = {
  type: "object",
  properties: { email: emailSchema, password: passwordSchema },
  required: ["email", "password"],
  additionalProperties: false,
} as const;

const createUserBodySchema = loginBodySchema;

const uuidParamsSchema = (properties: Record<string, unknown>) => ({
  type: "object",
  properties: Object.fromEntries(
    Object.entries(properties).map(([name]) => [
      name,
      { type: "string", format: "uuid" },
    ]),
  ),
  required: Object.keys(properties),
  additionalProperties: false,
});

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function auditContext(request: FastifyRequest) {
  return {
    requestId: request.id,
    remoteAddress: request.ip,
  };
}

function setSessionCookies(
  reply: { header(name: string, value: string[]): unknown },
  config: SecurityConfig,
  sessionToken: string,
  csrfToken: string,
): void {
  const secure = config.secureCookies ? "; Secure" : "";
  const age = 12 * 60 * 60;
  reply.header("set-cookie", [
    `${config.sessionCookieName}=${sessionToken}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure}`,
    `${config.csrfCookieName}=${csrfToken}; Path=/; Max-Age=${age}; SameSite=Strict${secure}`,
  ]);
}

function clearSessionCookies(
  reply: { header(name: string, value: string[]): unknown },
  config: SecurityConfig,
): void {
  const secure = config.secureCookies ? "; Secure" : "";
  reply.header("set-cookie", [
    `${config.sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure}`,
    `${config.csrfCookieName}=; Path=/; Max-Age=0; SameSite=Strict${secure}`,
  ]);
}

function isPostgresCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export function registerAuthRoutes(
  app: FastifyInstance,
  repository: AuthRepository | undefined,
  config: SecurityConfig,
): void {
  app.post<{
    Body: { email: string; password: string };
    Reply: { data: { id: string; email: string; instanceRole: string | null } } | ApiError;
  }>(
    "/api/auth/login",
    {
      schema: {
        body: loginBodySchema,
        response: {
          200: {
            type: "object",
            properties: {
              data: {
                type: "object",
                properties: {
                  id: { type: "string", format: "uuid" },
                  email: { type: "string" },
                  instanceRole: {
                    anyOf: [
                      { type: "string", const: "INSTANCE_ADMIN" },
                      { type: "null" },
                    ],
                  },
                },
                required: ["id", "email", "instanceRole"],
                additionalProperties: false,
              },
            },
            required: ["data"],
            additionalProperties: false,
          },
          401: errorSchema,
          429: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!repository) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }

      const email = normalizedEmail(request.body.email);
      let permitted: boolean;
      try {
        permitted = await repository.consumeLoginAttempt(
          email,
          request.ip,
          config.loginRateLimit,
          config.loginIpRateLimit,
          config.loginRateWindowSeconds,
        );
      } catch (error: unknown) {
        request.log.error({ err: error }, "Login rate limiter unavailable");
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      if (!permitted) {
        await repository.recordAudit({
          actorUserId: null,
          action: "auth.login_rate_limited",
          resourceType: "login",
          outcome: "denied",
          ...auditContext(request),
        });
        return reply.code(429).send({ error: "Too many login attempts" });
      }

      try {
        const user = await repository.findUserForLogin(email);
        const valid = await AuthRepository.verifyPassword(
          request.body.password,
          user?.passwordHash ?? null,
        );
        if (!user || !user.isActive || !valid) {
          await repository.recordAudit({
            actorUserId: user?.id ?? null,
            action: "auth.login",
            resourceType: "session",
            outcome: "failure",
            ...auditContext(request),
          });
          return reply.code(401).send({ error: "Invalid email or password" });
        }

        const sessionToken = randomBytes(32).toString("base64url");
        const csrfToken = randomBytes(32).toString("base64url");
        await repository.createSession(
          user.id,
          digestToken(sessionToken),
          digestToken(csrfToken),
          new Date(Date.now() + 12 * 60 * 60 * 1000),
          auditContext(request),
        );
        await repository.clearLoginAttempts(email);
        setSessionCookies(reply, config, sessionToken, csrfToken);
        reply.header("cache-control", "no-store");
        return reply.code(200).send({
          data: {
            id: user.id,
            email: user.email,
            instanceRole: user.instanceRole,
          },
        });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Login failed");
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
    },
  );

  app.get<{
    Reply: { data: AuthUser } | ApiError;
  }>(
    "/api/auth/session",
    {
      schema: {
        response: {
          200: userResponseSchema,
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.authUser) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      reply.header("cache-control", "no-store");
      return reply.code(200).send({ data: request.authUser });
    },
  );

  app.post(
    "/api/auth/logout",
    {
      schema: {
        response: {
          204: { type: "null" },
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser || !request.sessionTokenHash) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        await repository.revokeSession(
          request.sessionTokenHash,
          request.authUser.id,
          auditContext(request),
        );
        clearSessionCookies(reply, config);
        return reply.code(204).send();
      } catch (error: unknown) {
        request.log.error({ err: error }, "Logout failed");
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
    },
  );

  app.post(
    "/api/auth/refresh",
    {
      schema: {
        response: {
          200: userResponseSchema,
          401: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser || !request.sessionTokenHash) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      const sessionToken = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      try {
        const rotated = await repository.rotateSession(
          request.sessionTokenHash,
          request.authUser.id,
          digestToken(sessionToken),
          digestToken(csrfToken),
          new Date(Date.now() + 12 * 60 * 60 * 1000),
          auditContext(request),
        );
        if (!rotated) {
          return reply.code(401).send({ error: "Session expired" });
        }
        setSessionCookies(reply, config, sessionToken, csrfToken);
        reply.header("cache-control", "no-store");
        return reply.code(200).send({ data: request.authUser });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Session renewal failed");
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
    },
  );

  app.post<{
    Body: { email: string; password: string };
  }>(
    "/api/admin/users",
    {
      schema: {
        body: createUserBodySchema,
        response: {
          201: userResponseSchema,
          409: errorSchema,
          503: errorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const user = await repository.createUser(
          normalizedEmail(request.body.email),
          request.body.password,
          request.authUser.id,
          auditContext(request),
        );
        return reply.code(201).send({ data: user });
      } catch (error: unknown) {
        if (isPostgresCode(error, "23505")) {
          return reply.code(409).send({ error: "Email already registered" });
        }
        request.log.error({ err: error }, "User creation failed");
        return reply.code(503).send({ error: "User creation unavailable" });
      }
    },
  );

  app.put<{
    Params: { userId: string };
    Body: { isInstanceAdmin: boolean };
  }>(
    "/api/admin/users/:userId/instance-admin",
    {
      schema: {
        params: uuidParamsSchema({ userId: true }),
        body: {
          type: "object",
          properties: { isInstanceAdmin: { type: "boolean" } },
          required: ["isInstanceAdmin"],
          additionalProperties: false,
        },
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const updated = await repository.setInstanceAdmin(
          request.params.userId,
          request.body.isInstanceAdmin,
          request.authUser.id,
          auditContext(request),
        );
        return updated
          ? reply.code(204).send()
          : reply.code(404).send({ error: "User not found or last administrator" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Administrator role update failed");
        return reply.code(503).send({ error: "User update unavailable" });
      }
    },
  );

  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/deactivate",
    {
      schema: {
        params: uuidParamsSchema({ userId: true }),
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const deactivated = await repository.deactivateUser(
          request.params.userId,
          request.authUser.id,
          auditContext(request),
        );
        return deactivated
          ? reply.code(204).send()
          : reply.code(404).send({ error: "User not found or last administrator" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "User deactivation failed");
        return reply.code(503).send({ error: "User update unavailable" });
      }
    },
  );

  app.post<{ Params: { userId: string } }>(
    "/api/admin/users/:userId/activate",
    {
      schema: {
        params: uuidParamsSchema({ userId: true }),
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const activated = await repository.activateUser(
          request.params.userId,
          request.authUser.id,
          auditContext(request),
        );
        return activated
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Inactive user not found" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "User activation failed");
        return reply.code(503).send({ error: "User update unavailable" });
      }
    },
  );

  app.post<{
    Params: { userId: string };
    Body: { password: string };
  }>(
    "/api/admin/users/:userId/password-reset",
    {
      schema: {
        params: uuidParamsSchema({ userId: true }),
        body: {
          type: "object",
          properties: { password: passwordSchema },
          required: ["password"],
          additionalProperties: false,
        },
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const reset = await repository.resetUserPassword(
          request.params.userId,
          request.body.password,
          request.authUser.id,
          auditContext(request),
        );
        return reset
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Active user not found" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "User password reset failed");
        return reply.code(503).send({ error: "User update unavailable" });
      }
    },
  );

  app.get<{
    Params: { workspaceId: string };
    Reply: { data: WorkspaceMembershipRecord[] } | ApiError;
  }>(
    "/api/workspaces/:workspaceId/members",
    {
      schema: {
        params: uuidParamsSchema({ workspaceId: true }),
        response: { 200: workspaceMembersSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const data = await repository.listWorkspaceMembers(
          request.params.workspaceId,
        );
        return reply.code(200).send({ data });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Workspace member listing failed");
        return reply.code(503).send({ error: "Membership listing unavailable" });
      }
    },
  );

  app.get<{
    Params: { projectId: string };
    Reply: { data: ProjectMembershipRecord[] } | ApiError;
  }>(
    "/api/projects/:projectId/members",
    {
      schema: {
        params: uuidParamsSchema({ projectId: true }),
        response: { 200: projectMembersSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const data = await repository.listProjectMembers(request.params.projectId);
        return reply.code(200).send({ data });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Project member listing failed");
        return reply.code(503).send({ error: "Membership listing unavailable" });
      }
    },
  );

  app.put<{
    Params: { workspaceId: string; userId: string };
    Body: { role: WorkspaceRole };
  }>(
    "/api/workspaces/:workspaceId/members/:userId",
    {
      schema: {
        params: uuidParamsSchema({ workspaceId: true, userId: true }),
        body: {
          type: "object",
          properties: {
            role: { type: "string", enum: ["WORKSPACE_OWNER", "WORKSPACE_MEMBER"] },
          },
          required: ["role"],
          additionalProperties: false,
        },
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const updated = await repository.createWorkspaceMembership(
          request.params.workspaceId,
          request.params.userId,
          request.body.role,
          request.authUser.id,
          auditContext(request),
        );
        return updated
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Workspace or user not found" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Workspace membership update failed");
        return reply.code(503).send({ error: "Membership update unavailable" });
      }
    },
  );

  app.delete<{ Params: { workspaceId: string; userId: string } }>(
    "/api/workspaces/:workspaceId/members/:userId",
    {
      schema: {
        params: uuidParamsSchema({ workspaceId: true, userId: true }),
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const removed = await repository.removeWorkspaceMembership(
          request.params.workspaceId,
          request.params.userId,
          request.authUser.id,
          auditContext(request),
        );
        return removed
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Membership not found" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Workspace membership removal failed");
        return reply.code(503).send({ error: "Membership removal unavailable" });
      }
    },
  );

  app.put<{
    Params: { projectId: string; userId: string };
    Body: { role: ProjectRole };
  }>(
    "/api/projects/:projectId/members/:userId",
    {
      schema: {
        params: uuidParamsSchema({ projectId: true, userId: true }),
        body: {
          type: "object",
          properties: {
            role: {
              type: "string",
              enum: ["PROJECT_ADMIN", "INVESTIGATOR", "VIEWER"],
            },
          },
          required: ["role"],
          additionalProperties: false,
        },
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const updated = await repository.createProjectMembership(
          request.params.projectId,
          request.params.userId,
          request.body.role,
          request.authUser.id,
          auditContext(request),
        );
        return updated
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Project, workspace membership, or user not found" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Project membership update failed");
        return reply.code(503).send({ error: "Membership update unavailable" });
      }
    },
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/api/projects/:projectId/members/:userId",
    {
      schema: {
        params: uuidParamsSchema({ projectId: true, userId: true }),
        response: { 204: { type: "null" }, 404: errorSchema, 503: errorSchema },
      },
    },
    async (request, reply) => {
      if (!repository || !request.authUser) {
        return reply.code(503).send({ error: "Authentication unavailable" });
      }
      try {
        const removed = await repository.removeProjectMembership(
          request.params.projectId,
          request.params.userId,
          request.authUser.id,
          auditContext(request),
        );
        return removed
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Membership not found" });
      } catch (error: unknown) {
        request.log.error({ err: error }, "Project membership removal failed");
        return reply.code(503).send({ error: "Membership removal unavailable" });
      }
    },
  );
}
