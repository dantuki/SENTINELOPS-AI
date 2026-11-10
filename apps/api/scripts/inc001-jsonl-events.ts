import { createHash } from "node:crypto";

import type { EvidenceManifestItem } from "../src/retrieval-trace.js";
import { hashChunkContent } from "../src/retrieval-trace.js";
import type { TraceVerificationReport } from "../src/retrieval-trace-verifier.js";

export interface Inc001Event {
  id: string;
  evidenceId: string;
  documentId: string;
  sourceId: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  incidentId: string;
  event: string | null;
  timestamp: string | null;
  incidentRequestId: string | null;
  service: string | null;
  fields: Record<string, unknown>;
}

export interface Inc001EventIssue {
  evidenceId: string;
  startOffset: number;
  endOffset: number;
  reason:
    | "invalid_or_incomplete_json"
    | "record_not_object"
    | "incident_mismatch_or_missing"
    | "invalid_context_field";
}

export interface Inc001EventExtraction {
  events: Inc001Event[];
  issues: Inc001EventIssue[];
}

export interface Inc001ExtractionContext {
  runId: string;
  retrievalRequestId: string;
  projectId: string;
  incidentId: string;
  retrievedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

/**
 * Extract candidate records from one already-selected JSONL chunk. The caller
 * must retain the exact manifest passed to SQL verification: the v1 trace
 * report does not bind its per-evidence status to a content hash. Offsets are
 * UTF-16 indices within the chunk, not offsets in the source document.
 */
export function extractInc001JsonlEvents(
  item: EvidenceManifestItem,
  trace: TraceVerificationReport,
  context: Inc001ExtractionContext,
): Inc001EventExtraction {
  const statuses = trace.evidence.filter(
    ({ evidenceId }) => evidenceId === item.evidenceId,
  );
  if (
    trace.status !== "verified" ||
    trace.verificationErrors.length !== 0 ||
    trace.runId !== context.runId ||
    trace.requestId !== context.retrievalRequestId ||
    item.runId !== context.runId ||
    item.requestId !== context.retrievalRequestId ||
    item.projectId !== context.projectId ||
    item.incidentId !== context.incidentId ||
    item.retrievedAt !== context.retrievedAt ||
    item.evidenceScope !== "incident_specific" ||
    item.evidenceId !== item.chunkId ||
    item.contentHash !== hashChunkContent(item.content) ||
    statuses.length !== 1 ||
    statuses[0]?.status !== "verified" ||
    trace.verifiedEvidenceIds.filter((id) => id === item.evidenceId).length !== 1
  ) {
    throw new Error(
      "JSONL extraction requires evidence verified for the expected retrieval context.",
    );
  }

  const events: Inc001Event[] = [];
  const issues: Inc001EventIssue[] = [];
  const lines = item.content.matchAll(/[^\r\n]+/gu);
  for (const match of lines) {
    const raw = match[0];
    const startOffset = match.index;
    const endOffset = startOffset + raw.length;
    if (!raw.trim()) continue;

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      issues.push({
        evidenceId: item.evidenceId,
        startOffset,
        endOffset,
        reason: "invalid_or_incomplete_json",
      });
      continue;
    }

    if (!isRecord(value)) {
      issues.push({
        evidenceId: item.evidenceId,
        startOffset,
        endOffset,
        reason: "record_not_object",
      });
      continue;
    }
    if (value.incident_id !== context.incidentId) {
      issues.push({
        evidenceId: item.evidenceId,
        startOffset,
        endOffset,
        reason: "incident_mismatch_or_missing",
      });
      continue;
    }
    if (
      !optionalString(value.event) ||
      !optionalString(value.timestamp) ||
      !optionalString(value.request_id) ||
      !optionalString(value.service) ||
      (typeof value.timestamp === "string" && Number.isNaN(Date.parse(value.timestamp)))
    ) {
      issues.push({
        evidenceId: item.evidenceId,
        startOffset,
        endOffset,
        reason: "invalid_context_field",
      });
      continue;
    }
    const contentHash = createHash("sha256").update(raw, "utf8").digest("hex");
    events.push({
      id: `${item.chunkId}:${startOffset}:${contentHash}`,
      evidenceId: item.evidenceId,
      documentId: item.documentId,
      sourceId: item.sourceId,
      startOffset,
      endOffset,
      contentHash,
      incidentId: context.incidentId,
      event: value.event ?? null,
      timestamp: value.timestamp ?? null,
      incidentRequestId: value.request_id ?? null,
      service: value.service ?? null,
      fields: value,
    });
  }
  return { events, issues };
}
