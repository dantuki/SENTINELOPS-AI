import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeQaProject,
  type QaSourceFile,
} from "../src/qa-analysis.js";
import {
  GithubImportError,
  importPublicGithubRepository,
  parseGithubRepositoryUrl,
} from "../src/github-repository-import.js";
import { buildApp } from "../src/app.js";
import { registerQaRoutes } from "../src/qa-routes.js";
import type {
  CreateProjectSourceInput,
  EnsureProjectSourceResult,
  ProjectSourceRecord,
} from "../src/source-repository.js";
import { createTestSecurity } from "./security-test-fixture.js";

const projectId = "11111111-1111-4111-8111-111111111111";

function file(path: string, content: string): QaSourceFile {
  return {
    path,
    content,
    contentSha256: "a".repeat(64),
    byteLength: Buffer.byteLength(content, "utf8"),
  };
}

function githubFixtureFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/demo") {
      return Response.json({ private: false, default_branch: "main" });
    }
    if (url.pathname === "/repos/acme/demo/git/trees/main") {
      return Response.json({
        sha: "revision-123",
        truncated: false,
        tree: [
          { path: "package.json", type: "blob", size: 80 },
          { path: "src/index.ts", type: "blob", size: 60 },
          { path: "README.md", type: "blob", size: 20 },
          { path: "../unsafe.ts", type: "blob", size: 10 },
          { path: "node_modules/ignored.js", type: "blob", size: 10 },
        ],
      });
    }
    if (url.pathname === "/repos/acme/demo/contents/package.json") {
      return Response.json({
        encoding: "base64",
        content: Buffer.from(JSON.stringify({ scripts: { test: "node --test" } })).toString("base64"),
      });
    }
    if (url.pathname === "/repos/acme/demo/contents/src/index.ts") {
      return Response.json({
        encoding: "base64",
        content: Buffer.from("export const add = (left: number, right: number) => left + right;\n").toString("base64"),
      });
    }
    if (url.pathname === "/repos/acme/demo/contents/README.md") {
      return Response.json({
        encoding: "base64",
        content: Buffer.from("# Demo\n").toString("base64"),
      });
    }
    return new Response("not found", { status: 404 });
  };
}

function fakeSource(status: ProjectSourceRecord["status"] = "pending"): ProjectSourceRecord {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId,
    sourceType: "git_repository",
    name: "acme/demo",
    locator: "https://github.com/acme/demo",
    status,
    metadata: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

test("GitHub repository URLs accept only canonical public repository locators", () => {
  assert.deepEqual(parseGithubRepositoryUrl("https://github.com/acme/demo.git"), {
    owner: "acme",
    repository: "demo",
    canonicalUrl: "https://github.com/acme/demo",
  });
  for (const value of [
    "http://github.com/acme/demo",
    "https://github.com/acme/demo/tree/main",
    "https://api.github.com/repos/acme/demo",
    "https://github.com@attacker.test/acme/demo",
    "https://github.com/acme/../demo",
  ]) {
    assert.throws(
      () => parseGithubRepositoryUrl(value),
      (error: unknown) => error instanceof GithubImportError && error.code === "invalid_repository_url",
    );
  }
});

test("public GitHub import uses bounded API content, ignores unsafe paths, and does not execute files", async () => {
  const imported = await importPublicGithubRepository("https://github.com/acme/demo", {
    fetchImpl: githubFixtureFetch(),
  });

  assert.equal(imported.revision, "revision-123");
  assert.deepEqual(imported.files.map((item) => item.path), ["README.md", "package.json", "src/index.ts"]);
  assert.equal(imported.skipped.invalidPath, 1);
  assert.equal(imported.skipped.unsupported, 1);
  assert.match(imported.files.find((item) => item.path === "src/index.ts")?.content ?? "", /export const add/u);
});

test("static QA findings retain precise evidence and redact private material", () => {
  const report = analyzeQaProject({
    repositoryUrl: "https://github.com/acme/demo",
    revision: "revision-123",
    files: [
      file("package.json", JSON.stringify({ scripts: {} }, null, 2)),
      file("src/runtime.ts", [
        "const key = '-----BEGIN PRIVATE KEY-----';",
        "const dynamic = eval(input);",
      ].join("\n")),
    ],
  });

  assert.equal(report.testExecution.status, "not_executed");
  assert.ok(report.findings.some((item) => item.ruleId === "qa.testing.missing_test_script"));
  const key = report.findings.find((item) => item.ruleId === "qa.security.private_key_material");
  assert.equal(key?.evidence.filePath, "src/runtime.ts");
  assert.equal(key?.evidence.startLine, 1);
  assert.match(key?.evidence.excerpt ?? "", /redactado/u);
  assert.equal(key?.evidence.excerpt.includes("PRIVATE KEY-----';"), false);
  assert.ok(report.findings.some((item) => item.ruleId === "qa.security.dynamic_eval"));
  assert.doesNotMatch(JSON.stringify(report), /global quality score|ejecutó pruebas/iu);
});

test("GitHub QA rejects missing Origin and session before any external fetch", async () => {
  const security = createTestSecurity();
  const app = buildApp({
    logger: false,
    securityStore: security.securityStore,
    securityConfig: security.securityConfig,
  });
  let fetched = false;
  registerQaRoutes(app, {
    sourceStore: {
      listForProject: async () => [],
      ensureForProject: async () => ({ source: fakeSource(), created: true }),
      activateIfEnabled: async () => true,
    },
    fetchImpl: async () => {
      fetched = true;
      return Response.json({});
    },
  });

  try {
    const originRejected = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/github`,
      payload: { repositoryUrl: "https://github.com/acme/demo" },
    });
    assert.equal(originRejected.statusCode, 403);
    const unauthenticated = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/github`,
      headers: { origin: "http://127.0.0.1:3000" },
      payload: { repositoryUrl: "https://github.com/acme/demo" },
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(fetched, false);
  } finally {
    await app.close();
  }
});

test("GitHub QA route requires persistence, authorizes project scope, and persists only source metadata after import", async () => {
  const security = createTestSecurity();
  const stored: CreateProjectSourceInput[] = [];
  const app = buildApp({
    logger: false,
    securityStore: security.securityStore,
    securityConfig: security.securityConfig,
  });
  app.addHook("onRequest", async (request) => {
    security.addTestCredentials(request);
  });
  const store = {
    listForProject: async (id: string) => id === projectId ? [] : null,
    ensureForProject: async (_id: string, input: CreateProjectSourceInput): Promise<EnsureProjectSourceResult | null> => {
      stored.push(input);
      return { source: fakeSource(), created: true };
    },
    activateIfEnabled: async () => true,
  };
  registerQaRoutes(app, { sourceStore: store, fetchImpl: githubFixtureFetch() });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/github`,
      payload: { repositoryUrl: "https://github.com/acme/demo" },
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as { data: { analysis: { testExecution: { status: string } }; repository: { inspectedFileCount: number } } };
    assert.equal(payload.data.repository.inspectedFileCount, 3);
    assert.equal(payload.data.analysis.testExecution.status, "not_executed");
    assert.deepEqual(stored, [{
      sourceType: "git_repository",
      name: "acme/demo",
      locator: "https://github.com/acme/demo",
      metadata: {
        provider: "github",
        owner: "acme",
        repository: "demo",
        defaultBranch: "main",
        revision: "revision-123",
        inspectedFileCount: 3,
      },
    }]);
  } finally {
    await app.close();
  }
});

test("disabled GitHub sources cannot be reimported and do not trigger an external fetch", async () => {
  const security = createTestSecurity();
  const app = buildApp({
    logger: false,
    securityStore: security.securityStore,
    securityConfig: security.securityConfig,
  });
  app.addHook("onRequest", async (request) => {
    security.addTestCredentials(request);
  });
  let fetched = false;
  registerQaRoutes(app, {
    sourceStore: {
      listForProject: async () => [fakeSource("disabled")],
      ensureForProject: async () => {
        throw new Error("must not persist disabled source");
      },
      activateIfEnabled: async () => false,
    },
    fetchImpl: async () => {
      fetched = true;
      return Response.json({});
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/github`,
      payload: { repositoryUrl: "https://github.com/acme/demo" },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(fetched, false);
  } finally {
    await app.close();
  }
});
