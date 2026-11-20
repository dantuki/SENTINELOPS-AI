import { analyzeQaProject, type QaAnalysisReport } from "./qa-analysis.js";
import { requestPythonAstMetrics } from "./python-code-intelligence-client.js";
import {
  GithubImportError,
  importPublicGithubRepository,
  parseGithubRepositoryUrl,
  type GithubImportProgress,
} from "./github-repository-import.js";
import type {
  CreateProjectSourceInput,
  EnsureProjectSourceResult,
  ProjectSourceRecord,
} from "./source-repository.js";
import type {
  QaAnalysisRunRecord,
  QaConversationRecord,
  QaConversationRepository,
} from "./qa-conversation-repository.js";

export interface QaSourceStore {
  listForProject(projectId: string): Promise<ProjectSourceRecord[] | null>;
  ensureForProject(projectId: string, input: CreateProjectSourceInput): Promise<EnsureProjectSourceResult | null>;
  activateIfEnabled(projectId: string, sourceId: string): Promise<boolean>;
}

export type QaAnalysisExecutionStage =
  | "fetching_repository_metadata"
  | "listing_repository_files"
  | "selecting_analysis_files"
  | "reading_manifest"
  | "reading_source"
  | "reading_tests"
  | "reading_documentation"
  | "analyzing_files"
  | "verifying_findings"
  | "preparing_report";

export interface QaAnalysisExecutionProgress {
  stage: QaAnalysisExecutionStage;
  message: string;
  filePath?: string;
  processedFiles?: number;
  selectedFiles?: number;
}

export type QaAnalysisExecutionErrorCode =
  | "project_not_found"
  | "source_disabled"
  | "conversation_not_found"
  | "persistence_unavailable"
  | "analysis_integrity_failed";

export class QaAnalysisExecutionError extends Error {
  constructor(public readonly code: QaAnalysisExecutionErrorCode) {
    super(code);
    this.name = "QaAnalysisExecutionError";
  }
}

export interface QaAnalysisExecutionResult {
  source: {
    id: string;
    created: boolean;
    status: "active";
  };
  conversation: QaConversationRecord | null;
  analysisRun: QaAnalysisRunRecord | null;
  persistenceUnavailable: boolean;
  repository: {
    url: string;
    owner: string;
    name: string;
    defaultBranch: string;
    revision: string;
    inspectedFileCount: number;
    inventory: QaAnalysisReport["inventory"];
    skipped: {
      unsupported: number;
      tooLarge: number;
      invalidPath: number;
      limitReached: number;
    };
  };
  analysis: QaAnalysisReport;
}

function validateAnalysisReport(report: QaAnalysisReport, importedFiles: ReadonlyArray<{
  path: string;
  contentSha256: string;
  content: string;
}>): void {
  const fileByPath = new Map(importedFiles.map((file) => [file.path, file]));
  if (report.inspectedFiles.length !== importedFiles.length) {
    throw new QaAnalysisExecutionError("analysis_integrity_failed");
  }
  for (const inspected of report.inspectedFiles) {
    const source = fileByPath.get(inspected.path);
    if (!source || source.contentSha256 !== inspected.contentSha256) {
      throw new QaAnalysisExecutionError("analysis_integrity_failed");
    }
  }
  for (const finding of report.findings) {
    const source = fileByPath.get(finding.evidence.filePath);
    const lineCount = source?.content.split(/\r?\n/u).length ?? 0;
    if (
      !source ||
      finding.evidence.contentSha256 !== source.contentSha256 ||
      finding.evidence.startLine < 1 ||
      finding.evidence.endLine < finding.evidence.startLine ||
      finding.evidence.endLine > lineCount
    ) {
      throw new QaAnalysisExecutionError("analysis_integrity_failed");
    }
  }
}

function githubProgressToExecution(progress: GithubImportProgress): QaAnalysisExecutionProgress {
  return progress;
}

/**
 * Shared, bounded static analysis flow. Repository text exists only during this
 * function call; durable storage receives source metadata and evidence identity.
 */
export async function executeQaAnalysis(input: {
  projectId: string;
  userId?: string;
  repositoryUrl: string;
  conversationId?: string;
  sourceStore: QaSourceStore;
  conversationStore?: Pick<
    QaConversationRepository,
    "getConversation" | "createConversation" | "recordCompletedAnalysis" | "addMessage"
  >;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: QaAnalysisExecutionProgress) => void | Promise<void>;
  requirePersistence?: boolean;
}): Promise<QaAnalysisExecutionResult> {
  const reference = parseGithubRepositoryUrl(input.repositoryUrl);
  const existingSources = await input.sourceStore.listForProject(input.projectId);
  if (existingSources === null) throw new QaAnalysisExecutionError("project_not_found");
  if (existingSources.some((source) =>
    source.sourceType === "git_repository" &&
    source.locator === reference.canonicalUrl &&
    source.status === "disabled",
  )) {
    throw new QaAnalysisExecutionError("source_disabled");
  }

  let conversation: QaConversationRecord | null = null;
  if (input.conversationId && input.conversationStore) {
    conversation = await input.conversationStore.getConversation(input.projectId, input.conversationId);
    if (!conversation) throw new QaAnalysisExecutionError("conversation_not_found");
  }

  const imported = await importPublicGithubRepository(reference.canonicalUrl, {
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.onProgress
      ? { onProgress: async (progress: GithubImportProgress) => input.onProgress?.(githubProgressToExecution(progress)) }
      : {}),
  });
  const persisted = await input.sourceStore.ensureForProject(input.projectId, {
    sourceType: "git_repository",
    name: `${imported.owner}/${imported.repository}`,
    locator: imported.canonicalUrl,
    metadata: {
      provider: "github",
      owner: imported.owner,
      repository: imported.repository,
      defaultBranch: imported.defaultBranch,
      revision: imported.revision,
      inspectedFileCount: imported.files.length,
    },
  });
  if (!persisted) throw new QaAnalysisExecutionError("project_not_found");
  const active = persisted.source.status === "active" || await input.sourceStore.activateIfEnabled(
    input.projectId,
    persisted.source.id,
  );
  if (!active) throw new QaAnalysisExecutionError("source_disabled");

  await input.onProgress?.({
    stage: "analyzing_files",
    message: "Aplicando las reglas QA estáticas a los archivos seleccionados.",
    selectedFiles: imported.files.length,
  });
  const pythonMetrics = await requestPythonAstMetrics(imported.files);
  const analysis = analyzeQaProject({
    repositoryUrl: imported.canonicalUrl,
    revision: imported.revision,
    files: imported.files,
    inventory: imported.inventory,
    pythonMetrics,
  });
  await input.onProgress?.({
    stage: "verifying_findings",
    message: "Verificando la identidad y ubicación de cada hallazgo.",
    selectedFiles: imported.files.length,
  });
  validateAnalysisReport(analysis, imported.files);

  let analysisRun: QaAnalysisRunRecord | null = null;
  let persistenceUnavailable = !input.conversationStore || !input.userId;
  await input.onProgress?.({
    stage: "preparing_report",
    message: "Preparando el informe QA y sus referencias persistentes.",
    selectedFiles: imported.files.length,
  });
  if (input.conversationStore && input.userId) {
    try {
      if (!conversation) {
        conversation = await input.conversationStore.createConversation(
          input.projectId,
          input.userId,
          `${imported.owner}/${imported.repository}`,
        );
        if (!conversation) throw new QaAnalysisExecutionError("project_not_found");
      }
      analysisRun = await input.conversationStore.recordCompletedAnalysis({
        projectId: input.projectId,
        conversationId: conversation.id,
        sourceId: persisted.source.id,
        repositoryUrl: imported.canonicalUrl,
        revision: imported.revision,
        report: analysis,
      });
      if (!analysisRun) throw new QaAnalysisExecutionError("persistence_unavailable");
      const requestMessage = await input.conversationStore.addMessage(
        input.projectId,
        conversation.id,
        input.userId,
        "user",
        imported.canonicalUrl,
      );
      const reportMessage = await input.conversationStore.addMessage(
        input.projectId,
        conversation.id,
        null,
        "assistant",
        `Análisis completado: ${analysis.findings.length} hallazgos verificables en ${imported.files.length} archivos inspeccionados.`,
      );
      if (!requestMessage || !reportMessage) {
        throw new QaAnalysisExecutionError("persistence_unavailable");
      }
    } catch (error: unknown) {
      if (input.requirePersistence) throw error;
      conversation = null;
      analysisRun = null;
      persistenceUnavailable = true;
    }
  }

  if (input.requirePersistence && (!conversation || !analysisRun)) {
    throw new QaAnalysisExecutionError("persistence_unavailable");
  }

  return {
    source: { id: persisted.source.id, created: persisted.created, status: "active" },
    conversation,
    analysisRun,
    persistenceUnavailable,
    repository: {
      url: imported.canonicalUrl,
      owner: imported.owner,
      name: imported.repository,
      defaultBranch: imported.defaultBranch,
      revision: imported.revision,
      inspectedFileCount: imported.files.length,
      inventory: imported.inventory,
      skipped: imported.skipped,
    },
    analysis,
  };
}

export function isQaAnalysisExecutionError(error: unknown): error is QaAnalysisExecutionError {
  return error instanceof QaAnalysisExecutionError;
}

export function isGithubImportFailure(error: unknown): error is GithubImportError {
  return error instanceof GithubImportError;
}
