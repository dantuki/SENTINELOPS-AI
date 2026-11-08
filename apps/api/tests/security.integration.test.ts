import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import {
  AuthRepository,
  digestToken,
} from "../src/auth-repository.js";
import {
  defaultSecurityConfig,
} from "../src/auth-security.js";
import { buildApp } from "../src/app.js";
import { DocumentChunkRepository } from "../src/chunk-repository.js";
import { registerInvestigationRoutes } from "../src/investigation-routes.js";
import {
  ProductRepository,
} from "../src/product-repository.js";
import { registerProductRoutes } from "../src/product-routes.js";

const appOrigin = "http://127.0.0.1:3000";
const password = "integration-test-password";

interface LoginSession {
  cookie: string;
  csrf: string;
}

function getSetCookies(response: {
  headers: { "set-cookie"?: unknown };
}): string[] {
  const rawCookies = response.headers["set-cookie"];
  if (typeof rawCookies === "string") {
    return [rawCookies];
  }
  if (
    Array.isArray(rawCookies) &&
    rawCookies.every((cookie): cookie is string => typeof cookie === "string")
  ) {
    return rawCookies;
  }
  throw new Error("Authentication response omitted its session cookies.");
}

function sessionFromResponse(response: {
  headers: { "set-cookie"?: unknown };
}): LoginSession {
  const cookies = getSetCookies(response).map((cookie) =>
    cookie.split(";", 1)[0]!,
  );
  const sessionCookie = cookies.find((cookie) =>
    cookie.startsWith("sentinel_session="),
  );
  const csrfCookie = cookies.find((cookie) =>
    cookie.startsWith("sentinel_csrf="),
  );
  if (!sessionCookie || !csrfCookie) {
    throw new Error("Authentication response omitted a required cookie.");
  }
  return {
    cookie: `${sessionCookie}; ${csrfCookie}`,
    csrf: csrfCookie.slice(csrfCookie.indexOf("=") + 1),
  };
}

async function login(
  app: FastifyInstance,
  email: string,
  selectedPassword = password,
): Promise<{ statusCode: number; session?: LoginSession }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: appOrigin },
    payload: { email, password: selectedPassword },
  });
  return {
    statusCode: response.statusCode,
    ...(response.statusCode === 200
      ? { session: sessionFromResponse(response) }
      : {}),
  };
}

function sessionHeaders(session: LoginSession): Record<string, string> {
  return {
    cookie: session.cookie,
    origin: appOrigin,
    "x-csrf-token": session.csrf,
  };
}

test("PostgreSQL-backed authentication, RBAC, revocation, and tenant isolation", async () => {
  const database = process.env.POSTGRES_DB;
  if (!database || !/^sentinelops_phase31_isolation_\d+$/u.test(database)) {
    throw new Error(
      "POSTGRES_DB must identify the dedicated sentinelops_phase31_isolation_<timestamp> database.",
    );
  }
  const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    database,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    max: 5,
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
    query_timeout: 2_500,
  });
  const repository = new AuthRepository(pool);
  const productRepository = new ProductRepository(pool);
  const app = buildApp({
    logger: false,
    authRepository: repository,
    securityConfig: defaultSecurityConfig({
      NODE_ENV: "test",
      SESSION_COOKIE_SECURE: "false",
    }),
  });
  registerProductRoutes(app, productRepository);
  registerInvestigationRoutes(
    app,
    new DocumentChunkRepository(pool),
    {
      fetchImpl: async (input) => {
        if (String(input).endsWith("/embeddings")) {
          return Response.json({
            model: "synthetic-security-test",
            dimensions: 1024,
            data: [{ index: 0, embedding: [1, ...Array<number>(1023).fill(0)] }],
          });
        }
        throw new Error("Unexpected model generation request in security test.");
      },
    },
  );

  try {
    const identity = await pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    assert.equal(identity.rows[0]?.name, database);

    const suffix = randomBytes(6).toString("hex");
    const email = (role: string) => `${role}-${suffix}@example.test`;
    const admin = await repository.createInitialAdmin(
      email("instance-admin"),
      password,
      {},
    );
    const createUser = (role: string) =>
      repository.createUser(email(role), password, admin.id, {});
    const ownerA = await createUser("owner-a");
    const ownerB = await createUser("owner-b");
    const workspaceMember = await createUser("workspace-member");
    const investigator = await createUser("investigator");
    const viewer = await createUser("viewer");
    const projectAdmin = await createUser("project-admin");

    const workspaceA = await productRepository.createWorkspace(
      { slug: `security-a-${suffix}`, name: `Security workspace A ${suffix}` },
      ownerA.id,
    );
    const workspaceB = await productRepository.createWorkspace(
      { slug: `security-b-${suffix}`, name: `Security workspace B ${suffix}` },
      ownerB.id,
    );
    const projectA = await productRepository.createProject(
      workspaceA.id,
      { slug: `project-a-${suffix}`, name: "Security project A" },
      ownerA.id,
    );
    const projectB = await productRepository.createProject(
      workspaceB.id,
      { slug: `project-b-${suffix}`, name: "Security project B" },
      ownerB.id,
    );
    assert.ok(projectA);
    assert.ok(projectB);

    for (const user of [workspaceMember, investigator, viewer, projectAdmin]) {
      assert.equal(
        await repository.createWorkspaceMembership(
          workspaceA.id,
          user.id,
          "WORKSPACE_MEMBER",
          ownerA.id,
          {},
        ),
        true,
      );
    }
    assert.equal(
      await repository.createProjectMembership(
        projectA.id,
        investigator.id,
        "INVESTIGATOR",
        ownerA.id,
        {},
      ),
      true,
    );
    assert.equal(
      await repository.createProjectMembership(
        projectA.id,
        viewer.id,
        "VIEWER",
        ownerA.id,
        {},
      ),
      true,
    );
    assert.equal(
      await repository.createProjectMembership(
        projectA.id,
        projectAdmin.id,
        "PROJECT_ADMIN",
        ownerA.id,
        {},
      ),
      true,
    );

    const storedPassword = await pool.query<{ passwordHash: string }>(
      `SELECT password_hash AS "passwordHash" FROM users WHERE id = $1::uuid`,
      [admin.id],
    );
    assert.match(storedPassword.rows[0]?.passwordHash ?? "", /^scrypt\$/u);
    assert.notEqual(storedPassword.rows[0]?.passwordHash, password);

    const invalidLogin = await login(app, admin.email, "wrong-password-123");
    assert.equal(invalidLogin.statusCode, 401);
    const adminLogin = await login(app, admin.email);
    assert.equal(adminLogin.statusCode, 200);
    assert.ok(adminLogin.session);
    const adminToken = adminLogin.session.cookie
      .split(";")[0]!
      .split("=")[1]!;
    const persistedSession = await pool.query<{ tokenHash: string }>(
      `SELECT token_hash AS "tokenHash" FROM sessions WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
      [admin.id],
    );
    assert.equal(persistedSession.rows[0]?.tokenHash, digestToken(adminToken));
    assert.notEqual(persistedSession.rows[0]?.tokenHash, adminToken);

    const ownerSessionA = (await login(app, ownerA.email)).session!;
    const ownerSessionB = (await login(app, ownerB.email)).session!;
    const memberSession = (await login(app, workspaceMember.email)).session!;
    const investigatorSession = (await login(app, investigator.email)).session!;
    const viewerSession = (await login(app, viewer.email)).session!;
    const projectAdminSession = (await login(app, projectAdmin.email)).session!;

    const get = (path: string, session: LoginSession) =>
      app.inject({
        method: "GET",
        url: path,
        headers: sessionHeaders(session),
      });

    assert.equal(
      (await get(`/api/projects/${projectA.id}/incidents`, ownerSessionA))
        .statusCode,
      200,
    );
    assert.equal(
      (await get(`/api/projects/${projectA.id}/incidents`, investigatorSession))
        .statusCode,
      200,
    );
    assert.equal(
      (await get(`/api/projects/${projectA.id}/incidents`, viewerSession))
        .statusCode,
      200,
    );
    assert.equal(
      (await get(`/api/projects/${projectA.id}/incidents`, memberSession))
        .statusCode,
      404,
    );
    assert.equal(
      (await get(`/api/projects/${projectA.id}/incidents`, ownerSessionB))
        .statusCode,
      404,
    );
    assert.equal(
      (await get(`/api/projects/${projectB.id}/incidents`, ownerSessionA))
        .statusCode,
      404,
    );
    assert.equal(
      (await get(`/api/workspaces/${workspaceB.id}/projects`, ownerSessionA))
        .statusCode,
      404,
    );

    const workspaceList = await get("/api/workspaces", ownerSessionA);
    assert.deepEqual(
      workspaceList.json().data.map((item: { id: string }) => item.id),
      [workspaceA.id],
    );
    const projectList = await get(
      `/api/workspaces/${workspaceA.id}/projects`,
      memberSession,
    );
    assert.deepEqual(projectList.json().data, []);

    const instanceProjects = await get(
      `/api/projects/${projectA.id}/incidents`,
      adminLogin.session!,
    );
    assert.equal(instanceProjects.statusCode, 404);
    const administratorWorkspaceList = await get(
      "/api/workspaces",
      adminLogin.session!,
    );
    const apiWorkspaceIds = administratorWorkspaceList
      .json()
      .data.map((item: { id: string }) => item.id)
      .sort();
    const storedWorkspaces = await pool.query<{ id: string }>(
      "SELECT id FROM workspaces ORDER BY id",
    );
    assert.deepEqual(
      apiWorkspaceIds,
      storedWorkspaces.rows.map((row) => row.id).sort(),
    );
    assert.ok(apiWorkspaceIds.includes(workspaceA.id));
    assert.ok(apiWorkspaceIds.includes(workspaceB.id));

    const viewerInvestigation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectA.id}/investigate`,
      headers: sessionHeaders(viewerSession),
      payload: { question: "Can this viewer investigate?" },
    });
    assert.equal(viewerInvestigation.statusCode, 404);
    const investigatorMembers = await get(
      `/api/projects/${projectA.id}/members`,
      investigatorSession,
    );
    assert.equal(investigatorMembers.statusCode, 404);
    const adminMembers = await get(
      `/api/projects/${projectA.id}/members`,
      projectAdminSession,
    );
    assert.equal(adminMembers.statusCode, 200);

    const refreshSource = await login(app, workspaceMember.email);
    assert.ok(refreshSource.session);
    const refreshed = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: sessionHeaders(refreshSource.session),
    });
    assert.equal(refreshed.statusCode, 200);
    const refreshedSession = sessionFromResponse(refreshed);
    assert.equal(
      (await get("/api/auth/session", refreshSource.session)).statusCode,
      401,
    );
    assert.equal(
      (await get("/api/auth/session", refreshedSession)).statusCode,
      200,
    );

    const logoutSource = await login(app, investigator.email);
    assert.ok(logoutSource.session);
    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: sessionHeaders(logoutSource.session),
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(
      (await get("/api/auth/session", logoutSource.session)).statusCode,
      401,
    );

    const expiredToken = randomBytes(32).toString("base64url");
    const expiredCsrf = randomBytes(32).toString("base64url");
    await repository.createSession(
      investigator.id,
      digestToken(expiredToken),
      digestToken(expiredCsrf),
      new Date(Date.now() + 60_000),
      {},
    );
    await pool.query(
      `
        UPDATE sessions
        SET created_at = now() - interval '2 hours',
            expires_at = now() - interval '1 second'
        WHERE token_hash = $1
      `,
      [digestToken(expiredToken)],
    );
    assert.equal(
      (
        await get("/api/auth/session", {
          cookie: `sentinel_session=${expiredToken}; sentinel_csrf=${expiredCsrf}`,
          csrf: expiredCsrf,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await get("/api/auth/session", {
          cookie: "sentinel_session=nonexistent-session; sentinel_csrf=nonexistent-csrf",
          csrf: "nonexistent-csrf",
        })
      ).statusCode,
      401,
    );

    const inactiveUser = await createUser("inactive");
    const inactiveSession = (await login(app, inactiveUser.email)).session!;
    assert.equal(
      await repository.deactivateUser(inactiveUser.id, admin.id, {}),
      true,
    );
    assert.equal(
      (await get("/api/auth/session", inactiveSession)).statusCode,
      401,
    );
    assert.equal((await login(app, inactiveUser.email)).statusCode, 401);

    const permissionSession = (await login(app, workspaceMember.email)).session!;
    assert.equal(
      await repository.createProjectMembership(
        projectA.id,
        workspaceMember.id,
        "INVESTIGATOR",
        ownerA.id,
        {},
      ),
      true,
    );
    assert.equal(
      (await get("/api/auth/session", permissionSession)).statusCode,
      401,
    );
    const grantedMemberSession = (await login(app, workspaceMember.email)).session!;
    assert.equal(
      (await get(`/api/projects/${projectA.id}/incidents`, grantedMemberSession))
        .statusCode,
      200,
    );
    assert.equal(
      await repository.removeProjectMembership(
        projectA.id,
        workspaceMember.id,
        ownerA.id,
        {},
      ),
      true,
    );
    assert.equal(
      (await get("/api/auth/session", grantedMemberSession)).statusCode,
      401,
    );

    const auditActions = await pool.query<{ action: string; count: number }>(
      `
        SELECT action, count(*)::integer AS count
        FROM security_audit_events
        WHERE action = ANY($1::text[])
        GROUP BY action
      `,
      [[
        "auth.login",
        "auth.logout",
        "auth.session_rotated",
        "auth.sessions_revoked",
        "authorization.permission_denied",
        "workspace.created",
      ]],
    );
    const auditedActions = new Set(auditActions.rows.map((row) => row.action));
    for (const action of [
      "auth.login",
      "auth.logout",
      "auth.session_rotated",
      "auth.sessions_revoked",
      "authorization.permission_denied",
      "workspace.created",
    ]) {
      assert.ok(auditedActions.has(action), `Missing audit action ${action}.`);
    }
  } finally {
    await app.close();
    await pool.end();
  }
});
