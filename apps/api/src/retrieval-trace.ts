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
  retrievedAt: string;
  items: EvidenceManifestItem[];
}

export interface RetrievalTraceStore {
  createTrace(input: CreateRetrievalTraceInput): Promise<void>;
  /** Available only to the production store after its transaction commits. */
  getVerificationPool?(): Pick<Pool, "query">;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validateTraceInput(input: CreateRetrievalTraceInput): void {
  if (
    !isUuid(input.runId) ||
    !isUuid(input.requestId) ||
    !isUuid(input.projectId) ||
    (input.incidentId !== null &&
      (typeof input.incidentId !== "string" || input.incidentId.length === 0)) ||
    Number.isNaN(Date.parse(input.retrievedAt))
  ) {
    throw new TypeError("Retrieval trace identity is invalid.");
  }
  const seenChunkIds = new Set<string>();
  input.items.forEach((item, index) => {
    if (
      item.runId !== input.runId ||
      item.requestId !== input.requestId ||
      item.projectId !== input.projectId ||
      item.incidentId !== input.incidentId ||
      item.rank !== index + 1 ||
      item.alias !== `E${index + 1}` ||
      item.evidenceId !== item.chunkId ||
      !isUuid(item.chunkId) ||
      !isUuid(item.documentId) ||
      !isUuid(item.sourceId) ||
      item.contentHash !== hashChunkContent(item.content) ||
      item.retrievedAt !== input.retrievedAt ||
      seenChunkIds.has(item.chunkId)
    ) {
      throw new TypeError("Retrieval trace manifest is inconsistent.");
    }
    seenChunkIds.add(item.chunkId);
  });
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
  if (chunkIncidentId === undefined || chunkIncidentId === null) {
    return "project_context";
  }
  if (typeof chunkIncidentId !== "string" || !chunkIncidentId.trim()) {
    return "unknown_scope";
  }
  if (!requestedIncidentId) return "other_incident";
  return chunkIncidentId === requestedIncidentId
    ? "incident_specific"
    : "other_incident";
}

export function buildEvidenceManifest(
  matches: SemanticSearchChunkRecord[],
  identity: Omit<CreateRetrievalTraceInput, "items" | "retrievedAt">,
  now: Date = new Date(),
): EvidenceManifestItem[] {
  const retrievedAt = now.toISOString();
  const ids = new Set<string>();
  return matches.map((match, index) => {
    if (
      !isUuid(match.id) ||
      !isUuid(match.projectId) ||
      !isUuid(match.documentId) ||
      !isUuid(match.sourceId) ||
      match.projectId !== identity.projectId ||
      !Number.isInteger(match.ordinal) ||
      match.ordinal < 0 ||
      !Number.isFinite(match.score) ||
      typeof match.content !== "string" ||
      match.content.length === 0 ||
      ids.has(match.id)
    ) {
      throw new Error("Retrieved evidence has invalid identity or content.");
    }
    ids.add(match.id);
    return {
      evidenceId: match.id,
      alias: `E${index + 1}`,
      ...identity,
      chunkId: match.id,
      documentId: match.documentId,
      sourceId: match.sourceId,
      ordinal: match.ordinal,
      rank: index + 1,
      score: match.score,
      content: match.content,
      contentHash: hashChunkContent(match.content),
      evidenceScope: classifyEvidenceScope(
        match.metadata ?? {},
        identity.incidentId ?? undefined,
      ),
      retrievedAt,
    };
  });
}

export class PostgresRetrievalTraceStore implements RetrievalTraceStore {
  constructor(private readonly pool: Pool) {}

  getVerificationPool(): Pick<Pool, "query"> {
    return this.pool;
  }

  async createTrace(input: CreateRetrievalTraceInput): Promise<void> {
    validateTraceInput(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO retrieval_events
         (run_id, request_id, project_id, incident_id, retrieved_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::text, $5::timestamptz)`,
        [input.runId, input.requestId, input.projectId, input.incidentId, input.retrievedAt],
      );
      for (const item of input.items) {
        await client.query(
          `INSERT INTO retrieval_event_items
           (request_id, rank, chunk_id, document_id, source_id, project_id, ordinal, score, content_sha256, evidence_scope, retrieved_at)
           VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9, $10, $11::timestamptz)`,
          [item.requestId, item.rank, item.chunkId, item.documentId, item.sourceId,
            item.projectId, item.ordinal, item.score, item.contentHash, item.evidenceScope, item.retrievedAt],
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
    validateTraceInput(input);
    if (this.traces.some((trace) => trace.requestId === input.requestId)) {
      throw new Error("A retrieval event already exists for this request.");
    }
    this.traces.push(structuredClone(input));
  }
}
