import { timingSafeEqual } from "node:crypto";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  digestToken,
  type AuthUser,
  type AuthSession,
  type AuditEvent,
  type AuthorizationScope,
} from "./auth-repository.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
    sessionTokenHash: string | null;
    csrfTokenHash: string | null;
  }
}

export interface SecurityConfig {
  appOrigins: string[];
  secureCookies: boolean;
  sessionCookieName: string;
  csrfCookieName: string;
  loginRateLimit: number;
  loginIpRateLimit: number;
  loginRateWindowSeconds: number;
}

export interface SecurityAuthStore {
  findSession(tokenHash: string): Promise<AuthSession | null>;
  authorize(
    userId: string,
    permission: string,
    scope: AuthorizationScope,
  ): Promise<boolean>;
  recordAudit(event: AuditEvent): Promise<void>;
}

interface RoutePolicy {
  permission?: string;
  authOnly?: boolean;
  public?: boolean;
}

const policies = new Map<string, RoutePolicy>([
  ["GET /api/auth/session", { authOnly: true }],
  ["POST /api/auth/login", { public: true }],
  ["POST /api/auth/logout", { authOnly: true }],
  ["POST /api/auth/refresh", { authOnly: true }],
  ["GET /api/workspaces", { permission: "workspace.list" }],
  ["POST /api/workspaces", { permission: "instance.admin" }],
  [
    "GET /api/workspaces/:workspaceId/projects",
    { permission: "workspace.projects.read" },
  ],
  [
    "POST /api/workspaces/:workspaceId/projects",
    { permission: "workspace.project.create" },
  ],
  [
    "GET /api/projects/:projectId/incidents",
    { permission: "project.read" },
  ],
  [
    "POST /api/projects/:projectId/incidents",
    { permission: "project.manage" },
  ],
  [
    "GET /api/projects/:projectId/sources",
    { permission: "project.read" },
  ],
  [
    "POST /api/projects/:projectId/sources",
    { permission: "project.manage" },
  ],
  [
    "GET /api/projects/:projectId/documents",
    { permission: "project.read" },
  ],
  [
    "POST /api/projects/:projectId/documents",
    { permission: "project.manage" },
  ],
  [
    "GET /api/projects/:projectId/documents/:documentId/chunks",
    { permission: "project.read" },
  ],
  [
    "POST /api/projects/:projectId/documents/:documentId/chunks",
    { permission: "project.manage" },
  ],
  [
    "POST /api/projects/:projectId/documents/:documentId/embeddings",
    { permission: "project.manage" },
  ],
  [
    "POST /api/projects/:projectId/search",
    { permission: "project.read" },
  ],
  [
    "POST /api/projects/:projectId/ingestions",
    { permission: "project.manage" },
  ],
  [
    "POST /api/projects/:projectId/ingestions/demo",
    { permission: "project.manage" },
  ],
  [
    "POST /api/projects/:projectId/documents/:documentId/retry",
    { permission: "project.manage" },
  ],
  [
    "POST /api/projects/:projectId/investigate",
    { permission: "project.investigate" },
  ],
  ["POST /api/chat", { permission: "chat.use" }],
  ["POST /api/admin/users", { permission: "instance.admin" }],
  [
    "GET /api/workspaces/:workspaceId/members",
    { permission: "workspace.members.read" },
  ],
  [
    "GET /api/projects/:projectId/members",
    { permission: "project.members.manage" },
  ],
  [
    "PUT /api/admin/users/:userId/instance-admin",
    { permission: "instance.admin" },
  ],
  [
    "POST /api/admin/users/:userId/deactivate",
    { permission: "instance.admin" },
  ],
  [
    "POST /api/admin/users/:userId/activate",
    { permission: "instance.admin" },
  ],
  [
    "POST /api/admin/users/:userId/password-reset",
    { permission: "instance.admin" },
  ],
  [
    "PUT /api/workspaces/:workspaceId/members/:userId",
    { permission: "workspace.members.manage" },
  ],
  [
    "DELETE /api/workspaces/:workspaceId/members/:userId",
    { permission: "workspace.members.manage" },
  ],
  [
    "PUT /api/projects/:projectId/members/:userId",
    { permission: "project.members.manage" },
  ],
  [
    "DELETE /api/projects/:projectId/members/:userId",
    { permission: "project.members.manage" },
  ],
]);

export function defaultSecurityConfig(
  env: NodeJS.ProcessEnv = process.env,
): SecurityConfig {
  const isProduction = env.NODE_ENV === "production";
  const isDevelopment = env.NODE_ENV === "development";
  const isTest = env.NODE_ENV === "test";
  if (!isProduction && !isDevelopment && !isTest) {
    throw new Error("Set NODE_ENV to development or production.");
  }
  const configuredOrigin = env.APP_ORIGIN?.trim();
  if (!isDevelopment && !isTest && !configuredOrigin) {
    throw new Error("APP_ORIGIN must be set outside local development.");
  }

  const secureValue = env.SESSION_COOKIE_SECURE;
  if (secureValue && !["true", "false"].includes(secureValue)) {
    throw new Error("SESSION_COOKIE_SECURE must be true or false.");
  }
  if (isDevelopment && secureValue === undefined) {
    throw new Error(
      "Set SESSION_COOKIE_SECURE explicitly for local development.",
    );
  }
  const secureCookies =
    secureValue === undefined ? !isDevelopment && !isTest : secureValue === "true";
  if (isProduction && !secureCookies) {
    throw new Error("Secure session cookies are required in production.");
  }

  const origins = configuredOrigin
    ? [configuredOrigin]
    : ["http://127.0.0.1:3000", "http://localhost:3000"];
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      (isProduction && parsed.protocol !== "https:")
    ) {
      throw new Error("APP_ORIGIN must be a canonical origin.");
    }
  }
  if (!secureCookies) {
    const apiHost = env.API_HOST ?? "127.0.0.1";
    const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
    if (
      !isDevelopment && !isTest ||
      !localHosts.has(apiHost) ||
      origins.some((origin) => {
        const hostname = new URL(origin).hostname;
        return (
          !localHosts.has(hostname) ||
          new URL(origin).protocol !== "http:"
        );
      })
    ) {
      throw new Error(
        "Insecure cookies are allowed only for isolated loopback development.",
      );
    }
  }

  const rawLimit = Number(env.LOGIN_RATE_LIMIT ?? "10");
  const rawIpLimit = Number(env.LOGIN_IP_RATE_LIMIT ?? "60");
  const rawWindow = Number(env.LOGIN_RATE_WINDOW_SECONDS ?? "900");
  if (
    !Number.isInteger(rawLimit) ||
    rawLimit < 1 ||
    rawLimit > 100 ||
    !Number.isInteger(rawIpLimit) ||
    rawIpLimit < 1 ||
    rawIpLimit > 1000 ||
    !Number.isInteger(rawWindow) ||
    rawWindow < 60 ||
    rawWindow > 86_400
  ) {
    throw new Error("Login rate-limit configuration is invalid.");
  }

  return {
    appOrigins: origins,
    secureCookies,
    sessionCookieName: secureCookies
      ? "__Host-sentinel_session"
      : "sentinel_session",
    csrfCookieName: secureCookies
      ? "__Host-sentinel_csrf"
      : "sentinel_csrf",
    loginRateLimit: rawLimit,
    loginIpRateLimit: rawIpLimit,
    loginRateWindowSeconds: rawWindow,
  };
}

function cookieValue(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) {
      continue;
    }
    return pair.slice(separator + 1).trim();
  }
  return null;
}

function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function routeScope(request: FastifyRequest): AuthorizationScope {
  const params: unknown = request.params;
  if (typeof params !== "object" || params === null) {
    return {};
  }
  const record = params as Record<string, unknown>;
  return {
    ...(typeof record.workspaceId === "string"
      ? { workspaceId: record.workspaceId }
      : {}),
    ...(typeof record.projectId === "string"
      ? { projectId: record.projectId }
      : {}),
  };
}

function routeKey(request: FastifyRequest): string {
  return `${request.method} ${request.routeOptions.url}`;
}

function isStateChanging(request: FastifyRequest): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

export function registerSecurityHooks(
  app: FastifyInstance,
  repository: SecurityAuthStore | undefined,
  config: SecurityConfig,
): void {
  app.decorateRequest("authUser", null);
  app.decorateRequest("sessionTokenHash", null);
  app.decorateRequest("csrfTokenHash", null);

  app.addHook("preHandler", async (request, reply) => {
    const route = request.routeOptions.url ?? "";
    if (route.startsWith("/health")) {
      return;
    }

    const policy = policies.get(routeKey(request));
    if (!policy) {
      if (route.startsWith("/api/")) {
        await deny(request, reply, repository, "authorization.unmapped_route");
      }
      return;
    }

    if (
      isStateChanging(request) &&
      !hasAllowedOrigin(request, config.appOrigins)
    ) {
      await deny(request, reply, repository, "authorization.origin_denied", 403);
      return;
    }

    if (policy.public) {
      return;
    }

    if (!repository) {
      return reply.code(503).send({ error: "Authentication unavailable" });
    }

    const rawToken = cookieValue(request, config.sessionCookieName);
    const tokenHash = rawToken ? digestToken(rawToken) : null;
    const session = tokenHash
      ? await repository.findSession(tokenHash)
      : null;
    if (!session) {
      await deny(request, reply, repository, "authorization.unauthenticated", 401);
      return;
    }
    request.authUser = {
      id: session.id,
      email: session.email,
      instanceRole: session.instanceRole,
      lastLoginAt: session.lastLoginAt,
    };
    request.sessionTokenHash = tokenHash;
    request.csrfTokenHash = session.csrfTokenHash;

    if (isStateChanging(request)) {
      const csrfCookie = cookieValue(request, config.csrfCookieName);
      const csrfHeader = request.headers["x-csrf-token"];
      if (
        !csrfCookie ||
        typeof csrfHeader !== "string" ||
        !secureEquals(csrfCookie, csrfHeader) ||
        !secureEquals(digestToken(csrfCookie), session.csrfTokenHash)
      ) {
        await deny(request, reply, repository, "authorization.csrf_denied", 403);
        return;
      }
    }

    if (policy.authOnly) {
      return;
    }

    if (
      policy.permission &&
      !(await repository.authorize(
        session.id,
        policy.permission,
        routeScope(request),
      ))
    ) {
      await deny(
        request,
        reply,
        repository,
        "authorization.permission_denied",
        routeScope(request).projectId || routeScope(request).workspaceId
          ? 404
          : 403,
        session.id,
      );
    }
  });
}

export function hasAllowedOrigin(
  request: FastifyRequest,
  allowedOrigins: string[],
): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string") {
    return false;
  }
  return allowedOrigins.includes(origin);
}

async function deny(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: SecurityAuthStore | undefined,
  action: string,
  statusCode = 403,
  actorUserId: string | null = null,
): Promise<void> {
  if (repository) {
    await repository.recordAudit({
      actorUserId,
      action,
      resourceType: "http_request",
      resourceId: request.routeOptions.url,
      outcome: "denied",
      requestId: request.id,
      remoteAddress: request.ip,
    });
  }
  reply.code(statusCode).send({
    error:
      statusCode === 401
        ? "Authentication required"
        : statusCode === 404
          ? "Resource not found"
          : "Access denied",
  });
}
