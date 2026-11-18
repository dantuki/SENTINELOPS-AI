import {
  executeQaAnalysis,
  isGithubImportFailure,
  isQaAnalysisExecutionError,
  type QaSourceStore,
} from "./qa-analysis-execution.js";
import {
  QaAnalysisJobRepository,
  type QaAnalysisJobProgress,
} from "./qa-analysis-job-repository.js";
import type { QaConversationRepository } from "./qa-conversation-repository.js";
import { mapGithubImportError, mapQaAnalysisExecutionError } from "./qa-routes.js";

interface QaAnalysisJobRunnerOptions {
  sourceStore: QaSourceStore;
  conversationStore: Pick<
    QaConversationRepository,
    "getConversation" | "createConversation" | "recordCompletedAnalysis" | "addMessage"
  >;
  fetchImpl?: typeof fetch;
  onError?: (error: unknown, jobId: string) => void;
  maxConcurrentJobs?: number;
  maxJobRuntimeMs?: number;
}

/**
 * A small in-process worker backed by a durable job row. A restart marks an
 * unfinished job as failed rather than inventing a completion; a new request
 * with a new idempotency key is then required to retry it.
 */
export class QaAnalysisJobRunner {
  private readonly scheduled = new Set<string>();
  private readonly pending: Array<{ projectId: string; jobId: string }> = [];
  private activeCount = 0;

  constructor(
    private readonly jobs: QaAnalysisJobRepository,
    private readonly options: QaAnalysisJobRunnerOptions,
  ) {}

  enqueue(projectId: string, jobId: string): void {
    if (this.scheduled.has(jobId)) return;
    this.scheduled.add(jobId);
    this.pending.push({ projectId, jobId });
    this.drain();
  }

  async failInterruptedJobs(): Promise<number> {
    return this.jobs.failInterruptedJobs();
  }

  private async reportProgress(projectId: string, jobId: string, progress: QaAnalysisJobProgress): Promise<void> {
    const updated = await this.jobs.appendProgress(projectId, jobId, progress);
    if (!updated) throw new Error("QA job was no longer running while reporting progress");
  }

  private drain(): void {
    const limit = this.options.maxConcurrentJobs ?? 2;
    while (this.activeCount < limit && this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) return;
      this.activeCount += 1;
      void this.run(next.projectId, next.jobId).finally(() => {
        this.activeCount -= 1;
        this.scheduled.delete(next.jobId);
        this.drain();
      });
    }
  }

  private async run(projectId: string, jobId: string): Promise<void> {
    const job = await this.jobs.start(projectId, jobId);
    if (!job) return;
    const abortController = new AbortController();
    const timeoutMs = this.options.maxJobRuntimeMs ?? 120_000;
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const result = await executeQaAnalysis({
        projectId,
        userId: job.createdByUserId,
        repositoryUrl: job.repositoryUrl,
        ...(job.conversationId ? { conversationId: job.conversationId } : {}),
        sourceStore: this.options.sourceStore,
        conversationStore: this.options.conversationStore,
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        signal: abortController.signal,
        requirePersistence: true,
        onProgress: async (progress) => this.reportProgress(projectId, jobId, progress),
      });
      if (!result.conversation || !result.analysisRun) {
        throw new Error("A durable QA job completed without its persistent report");
      }
      const completed = await this.jobs.complete({
        projectId,
        jobId,
        conversationId: result.conversation.id,
        analysisRunId: result.analysisRun.id,
      });
      if (!completed) throw new Error("QA job could not transition to completed");
    } catch (error: unknown) {
      const failure = this.failureFor(error);
      try {
        await this.jobs.fail({ projectId, jobId, ...failure });
      } catch (failurePersistenceError: unknown) {
        this.options.onError?.(failurePersistenceError, jobId);
      }
      this.options.onError?.(error, jobId);
    } finally {
      clearTimeout(timeout);
    }
  }

  private failureFor(error: unknown): { code: string; message: string } {
    if (isGithubImportFailure(error)) {
      const mapped = mapGithubImportError(error);
      return { code: error.code, message: mapped.message };
    }
    if (isQaAnalysisExecutionError(error)) {
      const mapped = mapQaAnalysisExecutionError(error);
      return { code: error.code, message: mapped.message };
    }
    return {
      code: "analysis_failed",
      message: "El análisis no pudo completarse. Inicia uno nuevo para volver a intentarlo.",
    };
  }
}
