import type { FastifyRequest } from "fastify";

import {
  digestToken,
  type AuthSession,
} from "../src/auth-repository.js";
import {
  defaultSecurityConfig,
  type SecurityAuthStore,
  type SecurityConfig,
} from "../src/auth-security.js";

export const TEST_SESSION_TOKEN = "sentinelops-test-session";
export const TEST_CSRF_TOKEN = "sentinelops-test-csrf-token";

const testUser: AuthSession = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "tester@example.test",
  instanceRole: "INSTANCE_ADMIN",
  lastLoginAt: null,
  csrfTokenHash: digestToken(TEST_CSRF_TOKEN),
};

export function createTestSecurity(): {
  securityStore: SecurityAuthStore;
  securityConfig: SecurityConfig;
  addTestCredentials: (request: FastifyRequest) => void;
} {
  return {
    securityConfig: defaultSecurityConfig({
      NODE_ENV: "test",
      SESSION_COOKIE_SECURE: "false",
    }),
    securityStore: {
      findSession: async (tokenHash) =>
        tokenHash === digestToken(TEST_SESSION_TOKEN) ? testUser : null,
      authorize: async () => true,
      recordAudit: async () => undefined,
    },
    addTestCredentials: (request) => {
      request.headers.cookie ??=
        `sentinel_session=${TEST_SESSION_TOKEN}; sentinel_csrf=${TEST_CSRF_TOKEN}`;
      request.headers.origin ??= "http://127.0.0.1:3000";
      if (request.method !== "GET" && request.method !== "HEAD") {
        request.headers["x-csrf-token"] ??= TEST_CSRF_TOKEN;
      }
    },
  };
}
