import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";

import {
  AuthRepository,
  digestToken,
  type AuditEvent,
  type AuthSession,
  type AuthorizationScope,
} from "../src/auth-repository.js";
import {
  defaultSecurityConfig,
  registerSecurityHooks,
  type SecurityAuthStore,
} from "../src/auth-security.js";

const sessionToken = "test-session-token";
const csrfToken = "test-csrf-token";

function createSecurityApp(authorized = false) {
  const audits: AuditEvent[] = [];
  const scopes: AuthorizationScope[] = [];
  const session: AuthSession = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "tester@example.test",
    instanceRole: null,
    lastLoginAt: null,
    csrfTokenHash: digestToken(csrfToken),
  };
  const store: SecurityAuthStore = {
    findSession: async (tokenHash) =>
      tokenHash === digestToken(sessionToken) ? session : null,
    authorize: async (_userId, _permission, scope) => {
      scopes.push(scope);
      return authorized;
    },
    recordAudit: async (event) => {
      audits.push(event);
    },
  };
  const app = Fastify({ logger: false });
  registerSecurityHooks(
    app,
    store,
    defaultSecurityConfig({
      NODE_ENV: "test",
      SESSION_COOKIE_SECURE: "false",
    }),
  );
  app.get("/api/auth/session", async (request) => ({
    data: request.authUser,
  }));
  app.get("/api/unmapped", async () => ({ status: "unreachable" }));
  app.post("/api/projects/:projectId/incidents", async () => ({
    status: "authorized",
  }));
  return { app, audits, scopes };
}

const authenticatedHeaders = {
  cookie: `sentinel_session=${sessionToken}; sentinel_csrf=${csrfToken}`,
  origin: "http://127.0.0.1:3000",
  "x-csrf-token": csrfToken,
};

test("requires a session for protected routes", async () => {
  const { app } = createSecurityApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session",
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("denies API routes without an explicit route policy", async () => {
  const { app, audits } = createSecurityApp();
  try {
    const response = await app.inject({
      method: "GET",
      url: "/api/unmapped",
    });
    assert.equal(response.statusCode, 403);
    assert.equal(audits.at(-1)?.action, "authorization.unmapped_route");
  } finally {
    await app.close();
  }
});

test("requires valid Origin and CSRF tokens for state-changing requests", async () => {
  const { app, audits } = createSecurityApp(true);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/incidents",
      headers: { ...authenticatedHeaders, origin: "https://attacker.test" },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(audits.at(-1)?.action, "authorization.origin_denied");
  } finally {
    await app.close();
  }
});

test("conceals project authorization failures and preserves the scope", async () => {
  const { app, audits, scopes } = createSecurityApp();
  try {
    const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/incidents`,
      headers: authenticatedHeaders,
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(scopes, [{ projectId }]);
    assert.equal(audits.at(-1)?.action, "authorization.permission_denied");
  } finally {
    await app.close();
  }
});

test("rejects insecure cookies for production configuration", () => {
  assert.throws(() =>
    defaultSecurityConfig({
      NODE_ENV: "production",
      APP_ORIGIN: "https://sentinelops.example",
      SESSION_COOKIE_SECURE: "false",
    }),
  );
});

test("stores passwords as scrypt hashes and verifies them", async () => {
  const password = "a-long-test-password";
  const hash = await AuthRepository.hashPassword(password);
  assert.match(hash, /^scrypt\$32768\$8\$1\$/u);
  assert.equal(await AuthRepository.verifyPassword(password, hash), true);
  assert.equal(
    await AuthRepository.verifyPassword("a-different-password", hash),
    false,
  );
});
