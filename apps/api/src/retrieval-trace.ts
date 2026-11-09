import { createHash } from "node:crypto";
import type { Pool } from "pg";

import type { SemanticSearchChunkRecord } from "./chunk-repository.js";

export type EvidenceScope =
  | "incident_specific"
  | "project_context"
  | "other_incident"
  | "unknown_scope";

export interface EvidenceManifestItem {
  evidenceId: string;
  alias: string;
  runId: string;
  requestId: string;
  projectId: string;
  incidentId: string | null;
  chunkId: string;
  documentId: string;
  sourceId: string;
  ordinal: number;
  rank: number;
  score: number;
  content: string;
  contentHash: string;
  evidenceScope: EvidenceScope;
  retrievedAt: string;
}

export interface CreateRetrievalTraceInput {
  runId: string;
  requestId: string;
  projectId: string;
  incidentId: string | null;
  items: EvidenceManifestItem[];
}

export interface RetrievalTraceStore {
  createTrace(input: CreateRetrievalTraceInput): Promise<void>;
}

export function hashChunkContent(content: string): string {
  // Exact UTF-8 bytes from document_chunks.content; no Unicode or whitespace normalization.
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function classifyEvidenceScope(
  metadata: Record<string, unknown>,
  requestedIncidentId: string | undefined,
): EvidenceScope {
  const chunkIncidentId = metadata.incidentId;
  if (typeof chunkIncidentId !== "string" || !chunkIncidentId.trim()) {
    return "project_context";
  }
  if (!requestedIncidentId) return "unknown_scope";
  return chunkIncidentId === requestedIncidentId
    ? "incident_specific"
    : "other_incident";
}

export function buildEvidenceManifest(
  matches: SemanticSearchChunkRecord[],
  identity: Omit<CreateRetrievalTraceInput, "items">,
  now: Date = new Date(),
): EvidenceManifestItem[] {
  return matches.map((match, index) => ({
    evidenceId: match.id,
    alias: `E${index + 1}`,
    ...identity,
    chunkId: match.id,
    documentId: match.documentId,
    // The repository always returns sourceId. The fallback preserves older mock
    // compatibility only; a real verifier will reject mismatched lineage.
    sourceId: match.sourceId ?? match.documentId,
    ordinal: match.ordinal,
    rank: index + 1,
    score: match.score,
    content: match.content,
    contentHash: hashChunkContent(match.content),
    evidenceScope: classifyEvidenceScope(match.metadata ?? {}, identity.incidentId ?? undefined),
    retrievedAt: now.toISOString(),
  }));
}

export class PostgresRetrievalTraceStore implements RetrievalTraceStore {
  constructor(private readonly pool: Pool) {}

  async createTrace(input: CreateRetrievalTraceInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO retrieval_events (run_id, request_id, project_id, incident_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text)`,
        [input.runId, input.requestId, input.projectId, input.incidentId],
      );
      for (const item of input.items) {
        await client.query(
          `INSERT INTO retrieval_event_items
           (request_id, rank, chunk_id, document_id, source_id, project_id, ordinal, score, content_sha256, evidence_scope)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10)`,
          [item.requestId, item.rank, item.chunkId, item.documentId, item.sourceId,
            item.projectId, item.ordinal, item.score, item.contentHash, item.evidenceScope],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* retain original error */ }
      throw error;
    } finally { client.release(); }
  }
}

/** Test adapter only. Production wires PostgresRetrievalTraceStore in server.ts. */
export class MemoryRetrievalTraceStore implements RetrievalTraceStore {
  readonly traces: CreateRetrievalTraceInput[] = [];
  async createTrace(input: CreateRetrievalTraceInput): Promise<void> {
    if (this.traces.some((trace) => trace.requestId === input.requestId)) {
      throw new Error("A retrieval event already exists for this request.");
    }
    this.traces.push(structuredClone(input));
  }
}
