import assert from "node:assert/strict";
import test from "node:test";

import {
  answerQaQuestion,
  isQaAnalysisJob,
  isQaAnalysisJobEvent,
  isQaAssistantResponse,
  isQaImportResult,
  isQaPersistedAnalysis,
  type QaImportResult,
} from "../src/lib/qa-presentation.ts";
import { isGithubQaJobRequest, isGithubQaRequest } from "../src/lib/qa-request.ts";

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
  assert.equal(isGithubQaJobRequest({
    repositoryUrl: "https://github.com/acme/demo",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
  }), true);
  assert.equal(isGithubQaJobRequest({
    repositoryUrl: "https://github.com/acme/demo",
    idempotencyKey: "not-a-uuid",
  }), false);
  assert.equal(isGithubQaJobRequest({
    repositoryUrl: "https://github.com/acme/demo",
    idempotencyKey: "33333333-3333-4333-8333-333333333333",
    branch: "main",
  }), false);
});

test("QA job and assistant presentation contracts reject malformed server state", () => {
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    conversationId: null,
    analysisRunId: null,
    repositoryUrl: "https://github.com/acme/demo",
    status: "running",
    stage: "reading_source",
    nextSequence: 4,
    errorCode: null,
    errorMessage: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: null,
    updatedAt: "2026-01-01T00:00:02.000Z",
  };
  assert.equal(isQaAnalysisJob(job), true);
  assert.equal(isQaAnalysisJob({ ...job, stage: "imagined_stage" }), false);
  assert.equal(isQaAnalysisJobEvent({
    jobId: job.id, projectId: job.projectId, sequence: 4, stage: "reading_source", status: "running",
    message: "Leyendo src/index.ts.", filePath: "src/index.ts", processedFiles: 3, selectedFiles: 8,
    errorCode: null, createdAt: "2026-01-01T00:00:02.000Z",
  }), true);
  assert.equal(isQaAssistantResponse({
    mode: "deterministic", verified: "Hecho verificado.", interpretation: "no usar",
    citations: [{ findingId: "qa-1", filePath: "src/index.ts", startLine: 1, endLine: 1, contentSha256: "a".repeat(64) }],
    limitations: ["Sin cuerpos."], generation: { status: "not_requested" },
  }), true);
  assert.equal(isQaAssistantResponse({ mode: "hallucinated" }), false);
});

test("the QA presentation contract preserves source evidence and rejects malformed data", () => {
  const fixture = reportFixture();
  assert.equal(isQaImportResult(fixture), true);
  assert.equal(isQaImportResult({ ...fixture, source: { ...fixture.source, status: "pending" } }), false);
  assert.equal(isQaImportResult({ ...fixture, repository: { ...fixture.repository, skipped: {} } }), false);
  assert.equal(isQaImportResult({ ...fixture, conversation: { id: "x" } }), false);
  assert.equal(isQaImportResult({ ...fixture, persistence: { status: "unavailable" } }), true);
  assert.equal(isQaImportResult({ ...fixture, persistence: { status: "persisted" } }), false);
  assert.equal(isQaImportResult({ ...fixture, analysis: { ...fixture.analysis, inventory: { ...fixture.analysis.inventory, testFiles: {} as unknown as { discovered: number; selected: number } } } }), false);
});

test("the local report conversation preserves test-execution limits and evidence locations", () => {
  const report = reportFixture().analysis;
  assert.match(answerQaQuestion("¿Se ejecutaron pruebas?", report), /no ejecutado/iu);
  assert.match(answerQaQuestion("¿Dónde está la evidencia?", report), /src\/index\.ts, línea 7/iu);
  assert.match(answerQaQuestion("¿Qué debería corregir?", report), /Retira y rota/iu);
  assert.match(answerQaQuestion("¿Cuál fue la causa raíz?", report), /no genera conclusiones fuera del informe/iu);
});

test("a persisted QA report retains finding identity and references without requiring an excerpt", () => {
  const persisted = {
    id: "run-1",
    projectId: "project-1",
    conversationId: "conversation-1",
    analysisId: "qa-111111111111111111111111",
    repositoryUrl: "https://github.com/acme/demo",
    revision: "abc123",
    status: "completed",
    completedAt: "2026-01-01T00:00:00.000Z",
    reportSummary: {
      rulesetVersion: "qa-static-v1",
      detectedStack: ["TypeScript"],
      inspectedFileCount: 2,
      findingCount: 1,
      limitations: ["No se ejecutó código."],
      testExecution: { status: "not_executed", reason: "No se ejecuta código del repositorio importado." },
    },
    inventory: reportFixture().analysis.inventory,
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
  };
  assert.equal(isQaPersistedAnalysis(persisted), true);
  assert.equal(isQaPersistedAnalysis({ ...persisted, findings: [{ ...persisted.findings[0], evidence: { ...persisted.findings[0].evidence, contentSha256: null } }] }), false);
});
