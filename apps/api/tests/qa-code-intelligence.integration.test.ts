import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { AuthRepository } from "../src/auth-repository.js";
import { defaultSecurityConfig } from "../src/auth-security.js";
import { buildApp } from "../src/app.js";
import { ProductRepository } from "../src/product-repository.js";
import { registerQaAssistantRoutes } from "../src/qa-assistant-routes.js";
import { QaConversationRepository } from "../src/qa-conversation-repository.js";
import { registerQaConversationRoutes } from "../src/qa-conversation-routes.js";
import { registerQaRoutes } from "../src/qa-routes.js";
import { ProjectSourceRepository } from "../src/source-repository.js";

const origin = "http://127.0.0.1:3000";
const password = "qa-e2e-integration-password";

function sessionFrom(response: { headers: { "set-cookie"?: unknown } }): { cookie: string; csrf: string } {
  const raw = response.headers["set-cookie"];
  const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const cookies = values.filter((value): value is string => typeof value === "string").map((value) => value.split(";", 1)[0]!);
  const session = cookies.find((cookie) => cookie.startsWith("sentinel_session="));
  const csrf = cookies.find((cookie) => cookie.startsWith("sentinel_csrf="));
  assert.ok(session);
  assert.ok(csrf);
  return { cookie: `${session}; ${csrf}`, csrf: csrf.slice(csrf.indexOf("=") + 1) };
}

function headers(session: { cookie: string; csrf: string }): Record<string, string> {
  return { cookie: session.cookie, origin, "x-csrf-token": session.csrf };
}

function githubFixtureFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/acme/python-demo") return Response.json({ private: false, default_branch: "main" });
    if (url.pathname === "/repos/acme/python-demo/git/trees/main") {
      return Response.json({
        sha: "qa-python-ast-fixture-v1",
        truncated: false,
        tree: [
          { path: "package.json", type: "blob", size: 80 },
          { path: "README.md", type: "blob", size: 80 },
          { path: "src/worker.py", type: "blob", size: 160 },
        ],
      });
    }
    const contents: Record<string, string> = {
      "/repos/acme/python-demo/contents/package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
      "/repos/acme/python-demo/contents/README.md": "# Python demo\n\nPython implementation with `src/worker.py`.\n",
      "/repos/acme/python-demo/contents/src/worker.py": "import subprocess\n\nasync def analyze(value, command):\n    if value:\n        return eval(value)\n    return subprocess.run(command, shell=True)\n",
    };
    const content = contents[url.pathname];
    return content === undefined
      ? new Response("not found", { status: 404 })
      : Response.json({ encoding: "base64", content: Buffer.from(content).toString("base64") });
  };
}

test("authenticated QA import persists Python AST facts and restores them after reload", async () => {
  const database = process.env.POSTGRES_DB;
  if (!database || !/^sentinelops_phase31_isolation_\d+$/u.test(database)) {
    throw new Error("POSTGRES_DB must name the dedicated temporary integration database.");
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
  const auth = new AuthRepository(pool);
  const product = new ProductRepository(pool);
  const sources = new ProjectSourceRepository(pool);
  const conversations = new QaConversationRepository(pool);
  const app = buildApp({
    logger: false,
    authRepository: auth,
    securityConfig: defaultSecurityConfig({ NODE_ENV: "test", SESSION_COOKIE_SECURE: "false" }),
  });
  registerQaRoutes(app, { sourceStore: sources, conversationStore: conversations, fetchImpl: githubFixtureFetch() });
  registerQaConversationRoutes(app, conversations);
  registerQaAssistantRoutes(app, { conversationStore: conversations });
  try {
    const suffix = randomBytes(6).toString("hex");
    const admin = (await pool.query<{ id: string }>(
      "SELECT id FROM users WHERE instance_role = 'INSTANCE_ADMIN' ORDER BY created_at ASC LIMIT 1",
    )).rows[0];
    assert.ok(admin, "The security bootstrap integration must create an instance administrator first.");
    const owner = await auth.createUser(`qa-owner-${suffix}@example.test`, password, admin.id, {});
    const outsider = await auth.createUser(`qa-outsider-${suffix}@example.test`, password, admin.id, {});
    const workspace = await product.createWorkspace({ slug: `qa-${suffix}`, name: "QA AST E2E" }, owner.id);
    const project = await product.createProject(workspace.id, { slug: "python-ast", name: "Python AST" }, owner.id);
    assert.ok(project);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: owner.email, password } });
    assert.equal(login.statusCode, 200);
    const ownerSession = sessionFrom(login);

    const imported = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/qa/github`,
      headers: headers(ownerSession),
      payload: { repositoryUrl: "https://github.com/acme/python-demo" },
    });
    assert.equal(imported.statusCode, 200);
    const payload = imported.json() as { data: { conversation: { id: string }; analysis: { findings: Array<{ ruleId: string }>; codeIntelligence: { summary: { parsedFileCount: number; languageCounts: { python: number } } } } } };
    assert.equal(payload.data.analysis.codeIntelligence.summary.languageCounts.python, 1);
    assert.equal(payload.data.analysis.codeIntelligence.summary.parsedFileCount, 1);
    assert.ok(payload.data.analysis.findings.some((finding) => finding.ruleId === "qa.security.python_eval"));
    assert.ok(payload.data.analysis.findings.some((finding) => finding.ruleId === "qa.security.python_shell_true_nonliteral"));

    const restored = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/qa/conversations/${payload.data.conversation.id}`,
      headers: headers(ownerSession),
    });
    assert.equal(restored.statusCode, 200);
    const restoredData = restored.json() as { data: { analyses: Array<{ id: string; reportSummary: { codeIntelligence?: { structuralIndex?: { files: Array<{ path: string; symbols: Array<{ name: string }> }> } } } }> } };
    const analysisRun = restoredData.data.analyses[0];
    assert.ok(analysisRun);
    assert.equal(analysisRun.reportSummary.codeIntelligence?.structuralIndex?.files[0]?.path, "src/worker.py");
    assert.ok(analysisRun.reportSummary.codeIntelligence?.structuralIndex?.files[0]?.symbols.some((symbol) => symbol.name === "analyze"));

    const answer = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/qa/conversations/${payload.data.conversation.id}/assistant`,
      headers: headers(ownerSession),
      payload: { analysisRunId: analysisRun.id, question: "¿Qué funciones se identificaron?" },
    });
    assert.equal(answer.statusCode, 200);
    assert.match(JSON.stringify(answer.json()), /analyze/u);
    const pinned = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/qa/conversations/${payload.data.conversation.id}`,
      headers: headers(ownerSession),
      payload: { isPinned: true },
    });
    assert.equal(pinned.statusCode, 200);
    assert.equal((pinned.json() as { data: { isPinned: boolean } }).data.isPinned, true);

    const outsiderLogin = await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin }, payload: { email: outsider.email, password } });
    const denied = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/qa/conversations/${payload.data.conversation.id}`,
      headers: headers(sessionFrom(outsiderLogin)),
    });
    assert.equal(denied.statusCode, 404);

    const stored = await pool.query<{ summary: Record<string, unknown> }>(
      `SELECT report_summary AS summary FROM qa_analysis_runs WHERE id = $1::uuid`,
      [analysisRun.id],
    );
    assert.equal(JSON.stringify(stored.rows[0]?.summary).includes("return eval(value)"), false);
  } finally {
    await app.close();
    await pool.end();
  }
});
