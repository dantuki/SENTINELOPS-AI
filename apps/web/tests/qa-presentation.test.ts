import assert from "node:assert/strict";
import test from "node:test";

import {
  answerQaQuestion,
  isQaImportResult,
  type QaImportResult,
} from "../src/lib/qa-presentation.ts";
import { isGithubQaRequest } from "../src/lib/qa-request.ts";

function reportFixture(): QaImportResult {
  return {
    source: { id: "source-1", created: true, status: "active" },
    repository: {
      url: "https://github.com/acme/demo",
      owner: "acme",
      name: "demo",
      defaultBranch: "main",
      revision: "abc123",
      inspectedFileCount: 2,
      inventory: {
        selectionStrategy: "category_priority_v1",
        discoveredFiles: 3,
        selectedFiles: 2,
        categories: [
          { category: "manifest", discovered: 1, selected: 1 },
          { category: "test_configuration", discovered: 0, selected: 0 },
          { category: "source", discovered: 1, selected: 1 },
          { category: "test", discovered: 1, selected: 0 },
          { category: "documentation", discovered: 0, selected: 0 },
          { category: "other", discovered: 0, selected: 0 },
        ],
        testFiles: { discovered: 1, selected: 0 },
      },
      skipped: { unsupported: 1, tooLarge: 0, invalidPath: 0, limitReached: 0 },
    },
    analysis: {
      analysisId: "analysis-1",
      rulesetVersion: "qa-static-v1",
      repositoryUrl: "https://github.com/acme/demo",
      revision: "abc123",
      detectedStack: ["TypeScript"],
      inventory: {
        selectionStrategy: "category_priority_v1",
        discoveredFiles: 3,
        selectedFiles: 2,
        categories: [
          { category: "manifest", discovered: 1, selected: 1 },
          { category: "test_configuration", discovered: 0, selected: 0 },
          { category: "source", discovered: 1, selected: 1 },
          { category: "test", discovered: 1, selected: 0 },
          { category: "documentation", discovered: 0, selected: 0 },
          { category: "other", discovered: 0, selected: 0 },
        ],
        testFiles: { discovered: 1, selected: 0 },
      },
      inspectedFiles: [{ path: "src/index.ts", contentSha256: "a".repeat(64), byteLength: 80 }],
      checksPerformed: ["Revisión estática de material de clave privada."],
      findings: [
        {
          id: "finding-1",
          ruleId: "qa.security.private_key_material",
          ruleVersion: "1",
          category: "security",
          importance: "high",
          title: "Posible material de clave privada",
          description: "Se detectó una cabecera de clave privada.",
          whyItMatters: "Una clave expuesta puede comprometer sistemas.",
          recommendation: "Retira y rota el material de clave.",
          verificationStatus: "verified_static",
          evidence: {
            filePath: "src/index.ts",
            startLine: 7,
            endLine: 7,
            excerpt: "[REDACTED_PRIVATE_KEY_MARKER]",
            contentSha256: "a".repeat(64),
          },
        },
      ],
      limitations: ["No se ejecutó código."],
      testExecution: { status: "not_executed", reason: "No se ejecuta código del repositorio importado." },
    },
  };
}

test("the QA import request has a closed payload shape", () => {
  assert.equal(isGithubQaRequest({ repositoryUrl: "https://github.com/acme/demo" }), true);
  assert.equal(isGithubQaRequest({
    repositoryUrl: "https://github.com/acme/demo",
    conversationId: "33333333-3333-4333-8333-333333333333",
  }), true);
  assert.equal(isGithubQaRequest({ repositoryUrl: "https://github.com/acme/demo", branch: "main" }), false);
  assert.equal(isGithubQaRequest({ repositoryUrl: "https://github.com/acme/demo", conversationId: "//other-project" }), false);
  assert.equal(isGithubQaRequest({ repositoryUrl: "" }), false);
});

test("the QA presentation contract preserves source evidence and rejects malformed data", () => {
  const fixture = reportFixture();
  assert.equal(isQaImportResult(fixture), true);
  assert.equal(isQaImportResult({ ...fixture, source: { ...fixture.source, status: "pending" } }), false);
  assert.equal(isQaImportResult({ ...fixture, repository: { ...fixture.repository, skipped: {} } }), false);
  assert.equal(isQaImportResult({ ...fixture, conversation: { id: "x" } }), false);
  assert.equal(isQaImportResult({ ...fixture, analysis: { ...fixture.analysis, inventory: { ...fixture.analysis.inventory, testFiles: {} as unknown as { discovered: number; selected: number } } } }), false);
});

test("the local report conversation preserves test-execution limits and evidence locations", () => {
  const report = reportFixture().analysis;
  assert.match(answerQaQuestion("¿Se ejecutaron pruebas?", report), /no ejecutado/iu);
  assert.match(answerQaQuestion("¿Dónde está la evidencia?", report), /src\/index\.ts, línea 7/iu);
  assert.match(answerQaQuestion("¿Qué debería corregir?", report), /Retira y rota/iu);
  assert.match(answerQaQuestion("¿Cuál fue la causa raíz?", report), /no genera conclusiones fuera del informe/iu);
});
