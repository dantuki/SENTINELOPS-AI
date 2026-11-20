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
import { answerQaDeterministically, answerQaQuestion } from "../src/qa-assistant.js";
import { buildApp } from "../src/app.js";
import { mapGithubImportError, registerQaRoutes } from "../src/qa-routes.js";
import { registerQaAnalysisJobRoutes } from "../src/qa-analysis-job-routes.js";
import type { QaAnalysisJobRecord } from "../src/qa-analysis-job-repository.js";
import { QaAnalysisJobRunner } from "../src/qa-analysis-job-runner.js";
import { registerQaAssistantRoutes } from "../src/qa-assistant-routes.js";
import {
  registerQaConversationRoutes,
  type QaConversationMemoryStore,
} from "../src/qa-conversation-routes.js";
import { QaConversationRepository } from "../src/qa-conversation-repository.js";
import {
  isQaPersistenceSchemaReady,
  QA_PERSISTENCE_TABLES,
  QA_PERSISTENCE_UNAVAILABLE_MESSAGE,
} from "../src/qa-persistence.js";
import type {
  CreateProjectSourceInput,
  EnsureProjectSourceResult,
  ProjectSourceRecord,
} from "../src/source-repository.js";
import { createTestSecurity } from "./security-test-fixture.js";

const projectId = "11111111-1111-4111-8111-111111111111";

test("QA persistence readiness is a read-only complete-schema check", async () => {
  let query = "";
  let values: unknown[] = [];
  const ready = await isQaPersistenceSchemaReady({
    query: async (statement, parameters) => {
      query = statement;
      values = parameters;
      return { rows: [{ tables: QA_PERSISTENCE_TABLES.length }] };
    },
  });
  const incomplete = await isQaPersistenceSchemaReady({
    query: async () => ({ rows: [{ tables: QA_PERSISTENCE_TABLES.length - 1 }] }),
  });

  assert.equal(ready, true);
  assert.equal(incomplete, false);
  assert.match(query, /to_regclass/u);
  assert.deepEqual(values, [[...QA_PERSISTENCE_TABLES]]);
});

test("historical analysis lookup qualifies joined run columns and retains both scopes", async () => {
  let statement = "";
  let parameters: readonly unknown[] = [];
  const repository = new QaConversationRepository({
    query: async (query: string, values?: readonly unknown[]) => {
      statement = query;
      parameters = values ?? [];
      return { rows: [] };
    },
  } as never);

  await repository.listCompletedAnalyses(projectId, "22222222-2222-4222-8222-222222222222");

  assert.match(statement, /qa_analysis_runs\.id AS "id"/);
  assert.match(statement, /qa_analysis_findings\.analysis_run_id = qa_analysis_runs\.id/);
  assert.match(statement, /qa_analysis_runs\.project_id = \$1::uuid/);
  assert.match(statement, /qa_analysis_runs\.conversation_id = \$2::uuid/);
  assert.deepEqual(parameters, [projectId, "22222222-2222-4222-8222-222222222222"]);
});

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
  assert.deepEqual(imported.files.map((item) => item.path), ["package.json", "README.md", "src/index.ts"]);
  assert.equal(imported.skipped.invalidPath, 1);
  assert.equal(imported.skipped.unsupported, 1);
  assert.match(imported.files.find((item) => item.path === "src/index.ts")?.content ?? "", /export const add/u);
  assert.equal(imported.inventory.testFiles.discovered, 0);
});

test("GitHub import emits only stages reached by bounded repository operations", async () => {
  const progress: Array<{ stage: string; filePath?: string; processedFiles?: number }> = [];
  await importPublicGithubRepository("https://github.com/acme/demo", {
    fetchImpl: githubFixtureFetch(),
    onProgress: async (event) => { progress.push(event); },
  });
  assert.deepEqual(progress.slice(0, 3).map((event) => event.stage), [
    "fetching_repository_metadata",
    "listing_repository_files",
    "selecting_analysis_files",
  ]);
  assert.deepEqual(progress.slice(3).map((event) => event.filePath), [
    "package.json",
    "README.md",
    "src/index.ts",
  ]);
  assert.equal(progress.some((event) => event.stage === "analyzing_files"), false);
  assert.equal(progress[3]?.processedFiles, 0);
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
    "package.json", "README.md", "src/entry.ts", "test/app.js", "tests/integration.spec.ts",
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
    (error: unknown) => error instanceof GithubImportError && error.code === "repository_tree_truncated",
  );
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => { throw new Error("network unavailable"); },
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "github_unavailable",
  );
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => new Response("missing", { status: 404 }),
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "repository_not_found",
  );
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => Response.json({ private: true, default_branch: "main" }),
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "repository_not_public",
  );
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); },
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "github_timeout",
  );
});

test("QA job runner persists a bounded analysis timeout rather than a generic failed state", async () => {
  const job: QaAnalysisJobRecord = {
    id: "55555555-5555-4555-8555-555555555555",
    projectId,
    createdByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    conversationId: null,
    analysisRunId: null,
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
    repositoryUrl: "https://github.com/acme/demo",
    status: "queued",
    stage: "queued",
    nextSequence: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  let resolveFailure: (() => void) | undefined;
  const terminal = new Promise<void>((resolve) => { resolveFailure = resolve; });
  let failure: { code: string; message: string } | undefined;
  const runner = new QaAnalysisJobRunner({
    start: async () => ({ ...job, status: "running", stage: "validating_repository" }),
    appendProgress: async () => ({ ...job, status: "running" }),
    complete: async () => {
      throw new Error("A timed-out job cannot complete");
    },
    fail: async (input: { code: string; message: string }) => {
      failure = input;
      resolveFailure?.();
      return { ...job, status: "failed", stage: "failed", errorCode: input.code, errorMessage: input.message };
    },
  } as never, {
    sourceStore: {
      listForProject: async () => [],
      ensureForProject: async () => ({ source: fakeSource(), created: true }),
      activateIfEnabled: async () => true,
    },
    conversationStore: {
      getConversation: async () => null,
      createConversation: async () => null,
      recordCompletedAnalysis: async () => null,
      addMessage: async () => null,
    },
    fetchImpl: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }),
    maxJobRuntimeMs: 20,
  });

  runner.enqueue(projectId, job.id);
  await Promise.race([
    terminal,
    new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("QA job did not reach a terminal state")), 500)),
  ]);
  assert.deepEqual(failure, {
    projectId,
    jobId: job.id,
    code: "analysis_timeout",
    message: "El análisis excedió el tiempo seguro de ejecución.",
  });
});

test("GitHub import preserves upstream status and bounded rate-limit metadata", async () => {
  const cases: Array<{
    name: string;
    response: Response;
    code: GithubImportError["code"];
    statusCode: number;
  }> = [
    {
      name: "primary rate limit",
      response: new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1893456000",
          "x-github-request-id": "safe-request-id",
        },
      }),
      code: "github_rate_limited",
      statusCode: 429,
    },
    {
      name: "secondary rate limit",
      response: new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
        status: 403,
        headers: { "retry-after": "30" },
      }),
      code: "github_secondary_rate_limited",
      statusCode: 429,
    },
    {
      name: "forbidden response",
      response: new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 }),
      code: "github_forbidden",
      statusCode: 502,
    },
    {
      name: "too many requests",
      response: new Response(JSON.stringify({ message: "Too many requests" }), { status: 429 }),
      code: "github_rate_limited",
      statusCode: 429,
    },
    {
      name: "upstream unavailable",
      response: new Response("unavailable", { status: 503 }),
      code: "github_unavailable",
      statusCode: 503,
    },
    {
      name: "unexpected client response",
      response: new Response("bad request", { status: 400 }),
      code: "invalid_github_response",
      statusCode: 502,
    },
  ];

  for (const fixture of cases) {
    await assert.rejects(
      importPublicGithubRepository("https://github.com/acme/demo", {
        fetchImpl: async () => fixture.response.clone(),
      }),
      (error: unknown) => {
        if (!(error instanceof GithubImportError)) return false;
        assert.equal(error.code, fixture.code, fixture.name);
        assert.equal(error.status, fixture.response.status, fixture.name);
        assert.equal(mapGithubImportError(error).statusCode, fixture.statusCode, fixture.name);
        if (fixture.name === "primary rate limit") {
          assert.deepEqual(error.rateLimit, {
            remaining: 0,
            resetAt: 1_893_456_000,
            retryAfterSeconds: null,
            requestId: "safe-request-id",
          });
        }
        return true;
      },
    );
  }

  let quotaRequest = 0;
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => {
        quotaRequest += 1;
        return quotaRequest === 1
          ? Response.json({ private: false, default_branch: "main" })
          : Response.json(
            { sha: "quota-exhausted", truncated: false, tree: [{ path: "src/app.ts", type: "blob", size: 1 }] },
            { headers: { "x-ratelimit-remaining": "0" } },
          );
      },
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "github_rate_limited",
  );
  assert.equal(quotaRequest, 2);
});

test("GitHub import classifies repository boundaries without reducing an incomplete sample to success", async () => {
  const metadata = () => Response.json({ private: false, default_branch: "main" });
  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        return url.pathname === "/repos/acme/demo"
          ? metadata()
          : Response.json({ sha: "revision-too-large", truncated: false, tree: Array.from({ length: 2_001 }, (_, index) => ({ path: `src/${index}.ts`, type: "blob", size: 1 })) });
      },
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "repository_too_large",
  );

  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/repos/acme/demo") return metadata();
        if (url.pathname === "/repos/acme/demo/git/trees/main") {
          return Response.json({ sha: "revision-content", truncated: false, tree: [{ path: "src/app.ts", type: "blob", size: 1 }] });
        }
        return Response.json({ encoding: "binary", content: "not-base64" });
      },
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "unsupported_repository_content",
  );

  await assert.rejects(
    importPublicGithubRepository("https://github.com/acme/demo", {
      fetchImpl: async () => Response.json({ private: false }),
    }),
    (error: unknown) => error instanceof GithubImportError && error.code === "invalid_github_response",
  );
});

test("GitHub error mapping retains safe, distinct messages for analysis timeout and internal failure", () => {
  assert.deepEqual(mapGithubImportError(new GithubImportError("analysis_timeout")), {
    statusCode: 504,
    message: "El análisis excedió el tiempo seguro de ejecución.",
  });
  assert.deepEqual(mapGithubImportError(new GithubImportError("internal_analysis_error")), {
    statusCode: 503,
    message: "No se pudo completar la importación y el análisis.",
  });
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

test("static QA derives bounded TypeScript AST facts without executing or resolving imported code", () => {
  const report = analyzeQaProject({
    repositoryUrl: "https://github.com/acme/demo",
    revision: "revision-ast",
    inventory: inventory({ discoveredFiles: 3, selectedFiles: 3 }),
    files: [
      file("package.json", JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." }, dependencies: { fastify: "x" } })),
      file("README.md", "# Demo\n\n## Tests\n\nnpm test\n"),
      file("src/analysis.ts", [
        "import { helper } from './helper';",
        "const documentation = 'eval(userInput) is only text here';",
        "// eval(commentOnly)",
        "export function analyze(input: string) {",
        "  if (input && helper) return eval(input);",
        "  return input;",
        "}",
      ].join("\n")),
    ],
  });

  assert.equal(report.codeIntelligence.version, "qa-code-intelligence-v1");
  assert.equal(report.codeIntelligence.summary.parsedFileCount, 1);
  assert.equal(report.codeIntelligence.summary.languageCounts.typescript, 1);
  assert.deepEqual(report.codeIntelligence.manifests[0]?.scripts, ["lint", "test"]);
  assert.deepEqual(report.codeIntelligence.readmes[0]?.headings, ["Demo", "Tests"]);
  const analyzed = report.codeIntelligence.analyzedFiles[0];
  assert.equal(analyzed?.path, "src/analysis.ts");
  assert.ok(analyzed?.symbols.some((symbol) => symbol.name === "analyze" && symbol.kind === "function"));
  assert.ok(analyzed?.relations.some((relation) => relation.kind === "imports" && relation.to === "./helper"));
  assert.ok((analyzed?.cyclomaticComplexity ?? 0) >= 2);
  const evalFindings = report.findings.filter((item) => item.ruleId === "qa.security.dynamic_eval");
  assert.equal(evalFindings.length, 1);
  assert.equal(evalFindings[0]?.evidence.startLine, 5);
  assert.equal(report.limitations.some((item) => /no crea un Program/iu.test(item)), true);
});

test("static QA retains TypeScript parse diagnostics as bounded metadata", () => {
  const report = analyzeQaProject({
    repositoryUrl: "https://github.com/acme/demo",
    revision: "revision-parse-diagnostic",
    inventory: inventory({ discoveredFiles: 1, selectedFiles: 1 }),
    files: [file("src/broken.ts", "export const = ;\n")],
  });
  assert.equal(report.codeIntelligence.analyzedFiles[0]?.path, "src/broken.ts");
  assert.ok((report.codeIntelligence.analyzedFiles[0]?.parseDiagnostics ?? 0) > 0);
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

test("GitHub QA retains a completed report and identifies unavailable conversation persistence", async () => {
  const security = createTestSecurity();
  const app = buildApp({
    logger: false,
    securityStore: security.securityStore,
    securityConfig: security.securityConfig,
  });
  app.addHook("onRequest", async (request) => security.addTestCredentials(request));
  registerQaRoutes(app, {
    sourceStore: {
      listForProject: async () => [],
      ensureForProject: async () => ({ source: fakeSource(), created: true }),
      activateIfEnabled: async () => true,
    },
    conversationStore: {
      getConversation: async () => null,
      createConversation: async () => ({
        id: "33333333-3333-4333-8333-333333333333",
        projectId,
        title: "acme/demo",
        isPinned: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastMessageAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
      recordCompletedAnalysis: async () => null,
      addMessage: async () => null,
    },
    fetchImpl: githubFixtureFetch(),
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/github`,
      payload: { repositoryUrl: "https://github.com/acme/demo" },
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json() as {
      data: { analysis: { analysisId: string }; conversation?: unknown; persistence?: { status: string } };
    };
    assert.match(payload.data.analysis.analysisId, /^qa-/u);
    assert.equal(payload.data.conversation, undefined);
    assert.equal(payload.data.persistence?.status, "unavailable");
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

test("QA assistant answers only from persisted findings and rejects unknown generated citations", async () => {
  const analysis = {
    id: "44444444-4444-4444-8444-444444444444",
    projectId,
    conversationId: "33333333-3333-4333-8333-333333333333",
    analysisId: "qa-111111111111111111111111",
    repositoryUrl: "https://github.com/acme/demo",
    revision: "abc123",
    status: "completed" as const,
    completedAt: new Date("2026-01-01T00:00:00.000Z"),
    reportSummary: {
      rulesetVersion: "qa-static-v1",
      detectedStack: ["TypeScript"],
      inspectedFileCount: 2,
      findingCount: 1,
      limitations: ["No se ejecutó código."],
      testExecution: { status: "not_executed" as const, reason: "Solo análisis estático." },
    },
    inventory: inventory(),
    findings: [{
      id: "qa-11111111111111111111",
      ruleId: "qa.security.dynamic_eval",
      ruleVersion: "qa-static-v1",
      category: "security" as const,
      importance: "warning" as const,
      title: "Se detectó una llamada a eval",
      description: "El análisis estático encontró una llamada a eval.",
      recommendation: "Sustituye eval.",
      evidence: {
        filePath: "src/index.ts",
        startLine: 3,
        endLine: 3,
        contentSha256: "a".repeat(64),
      },
    }],
  };
  const deterministic = answerQaDeterministically(analysis, "¿Dónde está el problema?");
  assert.match(deterministic.verified, /src\/index/u);
  assert.deepEqual(deterministic.citations.map((citation) => citation.findingId), ["qa-11111111111111111111"]);
  const fallback = await answerQaQuestion({
    analysis,
    question: "Dame una explicación",
    provider: {
      explain: async () => ({
        model: "local-test",
        interpretation: "No debe conservarse.",
        citedFindingIds: ["finding-invented"],
      }),
    },
  });
  assert.equal(fallback.mode, "deterministic");
  assert.equal(fallback.generation.status, "unavailable");
});

test("QA assistant route persists server-created messages and remains project scoped", async () => {
  const security = createTestSecurity();
  const app = buildApp({ logger: false, securityStore: security.securityStore, securityConfig: security.securityConfig });
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
  const analysis = {
    id: "44444444-4444-4444-8444-444444444444",
    projectId,
    conversationId: conversation.id,
    analysisId: "qa-111111111111111111111111",
    repositoryUrl: "https://github.com/acme/demo",
    revision: "abc123",
    status: "completed" as const,
    completedAt: new Date(),
    reportSummary: {
      rulesetVersion: "qa-static-v1", detectedStack: ["TypeScript"], inspectedFileCount: 2, findingCount: 0,
      limitations: ["No se ejecutó código."], testExecution: { status: "not_executed" as const, reason: "Solo análisis estático." },
    },
    inventory: inventory(),
    findings: [],
  };
  const savedRoles: string[] = [];
  registerQaAssistantRoutes(app, {
    conversationStore: {
      getConversation: async (id, conversationId) => id === projectId && conversationId === conversation.id ? conversation : null,
      listCompletedAnalyses: async () => [analysis],
      addMessage: async (_project, conversationId, authorUserId, role, body) => {
        savedRoles.push(`${role}:${authorUserId === null ? "system" : "user"}`);
        return { id: `message-${savedRoles.length}`, projectId, conversationId, authorUserId, role, body, createdAt: new Date() };
      },
    },
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/conversations/${conversation.id}/assistant`,
      payload: { analysisRunId: analysis.id, question: "¿Qué se verificó?" },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(savedRoles, ["user:user", "assistant:system"]);
    assert.equal((response.json() as { data: { answer: { mode: string } } }).data.answer.mode, "deterministic");
  } finally {
    await app.close();
  }
});

test("QA job route uses an idempotency key and exposes ordered durable events", async () => {
  const security = createTestSecurity();
  const app = buildApp({ logger: false, securityStore: security.securityStore, securityConfig: security.securityConfig });
  app.addHook("onRequest", async (request) => security.addTestCredentials(request));
  const job: QaAnalysisJobRecord = {
    id: "55555555-5555-4555-8555-555555555555",
    projectId,
    createdByUserId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    conversationId: null,
    analysisRunId: null,
    idempotencyKey: "66666666-6666-4666-8666-666666666666",
    repositoryUrl: "https://github.com/acme/demo",
    status: "queued",
    stage: "queued",
    nextSequence: 1,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    startedAt: null,
    completedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const enqueued: string[] = [];
  registerQaAnalysisJobRoutes(app, {
    jobStore: {
      createOrGet: async () => ({ job, created: true }),
      get: async () => job,
      listEvents: async () => [{
        jobId: job.id,
        projectId,
        sequence: 1,
        stage: "queued",
        status: "queued",
        message: "El análisis está en cola.",
        filePath: null,
        processedFiles: null,
        selectedFiles: null,
        errorCode: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }],
    } as never,
    runner: { enqueue: (_projectId: string, jobId: string) => { enqueued.push(jobId); } } as QaAnalysisJobRunner,
  });
  try {
    const create = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/jobs`,
      payload: { repositoryUrl: "https://github.com/acme/demo", idempotencyKey: job.idempotencyKey },
    });
    assert.equal(create.statusCode, 202);
    assert.deepEqual(enqueued, [job.id]);
    const read = await app.inject({ method: "GET", url: `/api/projects/${projectId}/qa/jobs/${job.id}?afterSequence=0` });
    assert.equal(read.statusCode, 200);
    const body = read.json() as { data: { events: Array<{ sequence: number; message: string }> } };
    assert.deepEqual(body.data.events.map((event) => event.sequence), [1]);
    assert.equal(body.data.events[0]?.message, "El análisis está en cola.");
  } finally {
    await app.close();
  }
});

test("QA routes report unavailable persistence without attempting an import", async () => {
  const security = createTestSecurity();
  const app = buildApp({ logger: false, securityStore: security.securityStore, securityConfig: security.securityConfig });
  app.addHook("onRequest", async (request) => security.addTestCredentials(request));
  registerQaAnalysisJobRoutes(app);
  registerQaConversationRoutes(app);

  try {
    const conversations = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/qa/conversations`,
    });
    assert.equal(conversations.statusCode, 503);
    assert.equal((conversations.json() as { error: string }).error, QA_PERSISTENCE_UNAVAILABLE_MESSAGE);

    const job = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/jobs`,
      payload: {
        repositoryUrl: "https://github.com/acme/demo",
        idempotencyKey: "66666666-6666-4666-8666-666666666666",
      },
    });
    assert.equal(job.statusCode, 503);
    assert.equal((job.json() as { error: string }).error, QA_PERSISTENCE_UNAVAILABLE_MESSAGE);
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
    listCompletedAnalyses: async () => [{
      id: "44444444-4444-4444-8444-444444444444",
      projectId,
      conversationId: conversation.id,
      analysisId: "qa-111111111111111111111111",
      repositoryUrl: "https://github.com/acme/demo",
      revision: "abc123",
      status: "completed",
      completedAt: new Date("2026-01-01T00:00:00.000Z"),
      reportSummary: {
        rulesetVersion: "qa-static-v1",
        detectedStack: ["TypeScript"],
        inspectedFileCount: 2,
        findingCount: 1,
        limitations: ["No se ejecutó código."],
        testExecution: { status: "not_executed", reason: "Solo análisis estático." },
      },
      inventory: {
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
      },
      findings: [{
        id: "qa-11111111111111111111",
        ruleId: "qa.security.dynamic_eval",
        ruleVersion: "qa-static-v1",
        category: "security",
        importance: "warning",
        title: "Se detectó una llamada a eval",
        description: "El análisis estático encontró una llamada a eval.",
        recommendation: "Sustituye eval.",
        evidence: {
          filePath: "src/index.ts",
          startLine: 3,
          endLine: 3,
          contentSha256: "a".repeat(64),
        },
      }],
    }],
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
    const forgedAssistant = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/qa/conversations/${conversation.id}/messages`,
      payload: { role: "assistant", body: "Resultado inventado" },
    });
    assert.equal(forgedAssistant.statusCode, 400);
    const detail = await app.inject({ method: "GET", url: `/api/projects/${projectId}/qa/conversations/${conversation.id}` });
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.json() as { data: { messages: unknown[] } }).data.messages.length, 1);
    const analysis = (detail.json() as {
      data: { analyses: Array<{ analysisId: string; findings: Array<{ evidence: { contentSha256: string } }> }> };
    }).data.analyses[0];
    assert.equal(analysis?.analysisId, "qa-111111111111111111111111");
    assert.equal(analysis?.findings[0]?.evidence.contentSha256, "a".repeat(64));
  } finally {
    await app.close();
  }
});
