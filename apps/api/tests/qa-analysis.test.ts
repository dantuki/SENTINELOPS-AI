import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeQaProject,
  type QaRepositoryInventory,
  type QaSourceFile,
} from "../src/qa-analysis.js";
import {
  GithubImportError,
  importPublicGithubRepository,
  parseGithubRepositoryUrl,
} from "../src/github-repository-import.js";
import { buildApp } from "../src/app.js";
import { registerQaRoutes } from "../src/qa-routes.js";
import {
  registerQaConversationRoutes,
  type QaConversationMemoryStore,
} from "../src/qa-conversation-routes.js";
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

function inventory(overrides: Partial<QaRepositoryInventory> = {}): QaRepositoryInventory {
  return {
    selectionStrategy: "category_priority_v1",
    discoveredFiles: 2,
    selectedFiles: 2,
    categories: [
      { category: "manifest", discovered: 1, selected: 1 },
      { category: "test_configuration", discovered: 0, selected: 0 },
      { category: "source", discovered: 1, selected: 1 },
      { category: "test", discovered: 0, selected: 0 },
      { category: "documentation", discovered: 0, selected: 0 },
      { category: "other", discovered: 0, selected: 0 },
    ],
    testFiles: { discovered: 0, selected: 0 },
    ...overrides,
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
  assert.deepEqual(imported.files.map((item) => item.path), ["package.json", "src/index.ts", "README.md"]);
  assert.equal(imported.skipped.invalidPath, 1);
  assert.equal(imported.skipped.unsupported, 1);
  assert.match(imported.files.find((item) => item.path === "src/index.ts")?.content ?? "", /export const add/u);
  assert.equal(imported.inventory.testFiles.discovered, 0);
});

test("GitHub QA inventories test paths outside the bounded sample and selects representative categories deterministically", async () => {
  const contents: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "src/entry.ts": "export const entry = true;\n",
    "test/app.js": "test('app', () => {});\n",
    "tests/integration.spec.ts": "export {};\n",
    "README.md": "# Demo\n",
    "scripts/check.js": "console.log('check');\n",
  };
  const imported = await importPublicGithubRepository("https://github.com/acme/demo", {
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/acme/demo") return Response.json({ private: false, default_branch: "main" });
      if (url.pathname === "/repos/acme/demo/git/trees/main") {
        return Response.json({
          sha: "revision-coverage",
          truncated: false,
          tree: [
            ...Object.keys(contents).map((path) => ({ path, type: "blob", size: Buffer.byteLength(contents[path] ?? "", "utf8") })),
            { path: "tests/fixture.bin", type: "blob", size: 5 },
          ],
        });
      }
      const path = decodeURIComponent(url.pathname.replace("/repos/acme/demo/contents/", ""));
      const content = contents[path];
      return content === undefined
        ? new Response("not found", { status: 404 })
        : Response.json({ encoding: "base64", content: Buffer.from(content).toString("base64") });
    },
  });

  assert.deepEqual(imported.files.map((item) => item.path), [
    "package.json", "test/app.js", "tests/integration.spec.ts", "src/entry.ts", "README.md",
  ]);
  assert.deepEqual(imported.inventory.testFiles, { discovered: 3, selected: 2 });
  assert.deepEqual(imported.inventory.categories.find((item) => item.category === "test"), {
    category: "test", discovered: 3, selected: 2,
  });
});

test("GitHub tree order does not change the selected sample or revision identity", async () => {
  const contents: Record<string, string> = {
    "package.json": "{\"scripts\":{}}\n",
    "src/z.ts": "export const z = 1;\n",
    "src/a.ts": "export const a = 1;\n",
    "tests/app.spec.ts": "export {};\n",
    "README.md": "# Demo\n",
  };
  const importWithTreeOrder = async (paths: string[]) => importPublicGithubRepository("https://github.com/acme/demo", {
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/repos/acme/demo") return Response.json({ private: false, default_branch: "main" });
      if (url.pathname === "/repos/acme/demo/git/trees/main") {
        return Response.json({
          sha: "revision-stable",
          truncated: false,
          tree: paths.map((path) => ({ path, type: "blob", size: Buffer.byteLength(contents[path] ?? "", "utf8") })),
        });
      }
      const path = decodeURIComponent(url.pathname.replace("/repos/acme/demo/contents/", ""));
      return Response.json({ encoding: "base64", content: Buffer.from(contents[path] ?? "").toString("base64") });
    },
  });
  const forward = await importWithTreeOrder(Object.keys(contents));
  const reversed = await importWithTreeOrder(Object.keys(contents).reverse());
  assert.equal(forward.revision, reversed.revision);
  assert.deepEqual(forward.files.map((item) => item.path), reversed.files.map((item) => item.path));
  assert.deepEqual(forward.inventory, reversed.inventory);
});

test("GitHub import preserves repository and transport failure boundaries", async () => {
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/repos/acme/demo") return Response.json({ private: false, default_branch: "main" });
        return Response.json({ sha: "revision-limited", truncated: true, tree: [] });
      },
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "repository_limit_exceeded",
  );
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => { throw new Error("network unavailable"); },
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "github_unavailable",
  );
});

test("static QA findings retain precise evidence and redact private material", () => {
  const report = analyzeQaProject({
    repositoryUrl: "https://github.com/acme/demo",
    revision: "revision-123",
    inventory: inventory(),
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
  assert.equal(report.findings.some((item) => item.ruleId === "qa.testing.no_discovered_test_files"), false);
  assert.doesNotMatch(JSON.stringify(report), /global quality score|ejecutó pruebas/iu);
});

test("static QA never turns an incomplete sample into a claim that tests are absent", () => {
  const report = analyzeQaProject({
    repositoryUrl: "https://github.com/acme/demo",
    revision: "revision-tests-outside-sample",
    files: [file("package.json", JSON.stringify({ scripts: {} }))],
    inventory: inventory({
      discoveredFiles: 42,
      selectedFiles: 1,
      categories: [
        { category: "manifest", discovered: 1, selected: 1 },
        { category: "test_configuration", discovered: 1, selected: 0 },
        { category: "source", discovered: 30, selected: 0 },
        { category: "test", discovered: 10, selected: 0 },
        { category: "documentation", discovered: 0, selected: 0 },
        { category: "other", discovered: 0, selected: 0 },
      ],
      testFiles: { discovered: 10, selected: 0 },
    }),
  });
  assert.ok(report.findings.some((item) => item.ruleId === "qa.testing.missing_test_script"));
  assert.equal(report.findings.some((item) => item.ruleId === "qa.testing.no_discovered_test_files"), false);
  assert.deepEqual(report.inventory.testFiles, { discovered: 10, selected: 0 });
});

test("test declaration, inventory detection, and execution remain distinct when test bodies are omitted", () => {
  const report = analyzeQaProject({
    repositoryUrl: "https://github.com/acme/demo",
    revision: "revision-declared-tests",
    files: [file("package.json", JSON.stringify({ scripts: { test: "node --test" } }))],
    inventory: inventory({
      discoveredFiles: 12,
      selectedFiles: 1,
      testFiles: { discovered: 8, selected: 0 },
    }),
  });
  assert.equal(report.findings.some((item) => item.ruleId === "qa.testing.missing_test_script"), false);
  assert.deepEqual(report.inventory.testFiles, { discovered: 8, selected: 0 });
  assert.equal(report.testExecution.status, "not_executed");
});

test("a missing manifest leaves test declaration unknown rather than creating a negative finding", () => {
  const report = analyzeQaProject({
    repositoryUrl: "https://github.com/acme/demo",
    revision: "revision-no-manifest",
    files: [file("src/app.ts", "export const app = true;\n")],
    inventory: inventory({
      discoveredFiles: 1,
      selectedFiles: 1,
      categories: [
        { category: "manifest", discovered: 0, selected: 0 },
        { category: "test_configuration", discovered: 0, selected: 0 },
        { category: "source", discovered: 1, selected: 1 },
        { category: "test", discovered: 0, selected: 0 },
        { category: "documentation", discovered: 0, selected: 0 },
        { category: "other", discovered: 0, selected: 0 },
      ],
    }),
  });
  assert.equal(report.findings.some((item) => item.category === "testing"), false);
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

test("QA conversation memory routes retain project scope, pins, and message roles", async () => {
  const security = createTestSecurity();
  const app = buildApp({
    logger: false,
    securityStore: security.securityStore,
    securityConfig: security.securityConfig,
  });
  app.addHook("onRequest", async (request) => security.addTestCredentials(request));
  const conversation = {
    id: "33333333-3333-4333-8333-333333333333",
    projectId,
    title: "acme/demo",
    isPinned: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const messages: Array<{
    id: string; conversationId: string; projectId: string; authorUserId: string | null;
    role: "user" | "assistant" | "system"; body: string; createdAt: Date;
  }> = [];
  const store: QaConversationMemoryStore = {
    listConversations: async (id) => id === projectId ? [conversation] : [],
    createConversation: async () => conversation,
    getConversation: async (id, id2) => id === projectId && id2 === conversation.id ? conversation : null,
    setPinned: async (_id, _conversationId, isPinned) => ({ ...conversation, isPinned }),
    listMessages: async () => messages,
    addMessage: async (_projectId, conversationId, authorUserId, role, body) => {
      const message = { id: `message-${messages.length + 1}`, conversationId, projectId, authorUserId, role, body, createdAt: new Date() };
      messages.push(message);
      return message;
    },
  };
  registerQaConversationRoutes(app, store);
  try {
    const listed = await app.inject({ method: "GET", url: `/api/projects/${projectId}/qa/conversations` });
    assert.equal(listed.statusCode, 200);
    assert.equal((listed.json() as { data: unknown[] }).data.length, 1);
    const pin = await app.inject({
      method: "PATCH", url: `/api/projects/${projectId}/qa/conversations/${conversation.id}`,
      payload: { isPinned: true },
    });
    assert.equal(pin.statusCode, 200);
    assert.equal((pin.json() as { data: { isPinned: boolean } }).data.isPinned, true);
    const message = await app.inject({
      method: "POST", url: `/api/projects/${projectId}/qa/conversations/${conversation.id}/messages`,
      payload: { role: "user", body: "¿Qué encontraste?" },
    });
    assert.equal(message.statusCode, 201);
    assert.equal(messages[0]?.authorUserId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const detail = await app.inject({ method: "GET", url: `/api/projects/${projectId}/qa/conversations/${conversation.id}` });
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.json() as { data: { messages: unknown[] } }).data.messages.length, 1);
  } finally {
    await app.close();
  }
});
