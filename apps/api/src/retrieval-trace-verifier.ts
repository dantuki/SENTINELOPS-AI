import type { Pool } from "pg";
import { hashChunkContent, type EvidenceManifestItem } from "./retrieval-trace.js";

export interface EvidenceVerification {
  evidenceId: string;
  status: "verified" | "unverified" | "failed";
  checks: string[];
}

/**
 * Verifies only against the caller-provided isolated-run pool. It never creates
 * a connection, writes SQL, or reads environment variables, so the runner is
 * responsible for supplying its temporary database connection exclusively.
 */
export class RetrievalTraceVerifier {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async verify(item: EvidenceManifestItem): Promise<EvidenceVerification> {
    const result = await this.pool.query<{
      requestId: string; runId: string; projectId: string; incidentId: string | null;
      chunkId: string; documentId: string; sourceId: string; ordinal: number;
      content: string; contentHash: string; evidenceScope: string;
      documentStatus: string; sourceStatus: string;
    }>(
      `SELECT event.request_id AS "requestId", event.run_id AS "runId", event.project_id AS "projectId", event.incident_id AS "incidentId",
        item.chunk_id AS "chunkId", item.document_id AS "documentId", item.source_id AS "sourceId", item.ordinal,
        chunk.content, item.content_sha256 AS "contentHash", item.evidence_scope AS "evidenceScope",
        document.status AS "documentStatus", source.status AS "sourceStatus"
       FROM retrieval_events event
       JOIN retrieval_event_items item ON item.request_id = event.request_id
       JOIN document_chunks chunk ON chunk.id = item.chunk_id AND chunk.project_id = item.project_id AND chunk.document_id = item.document_id
       JOIN documents document ON document.id = item.document_id AND document.project_id = item.project_id
       JOIN project_sources source ON source.id = item.source_id AND source.project_id = item.project_id AND document.source_id = source.id
       WHERE event.request_id = $1::uuid AND event.run_id = $2::uuid AND event.project_id = $3::uuid
         AND item.chunk_id = $4::uuid AND item.rank = $5`,
      [item.requestId, item.runId, item.projectId, item.chunkId, item.rank],
    );
    const row = result.rows[0];
    if (!row) return { evidenceId: item.evidenceId, status: "failed", checks: ["trace_item_not_found_same_run"] };
    const checks: string[] = [];
    if (row.incidentId !== item.incidentId) checks.push("incident_mismatch");
    if (row.documentId !== item.documentId || row.sourceId !== item.sourceId || row.ordinal !== item.ordinal) checks.push("lineage_mismatch");
    if (row.documentStatus !== "indexed" || row.sourceStatus !== "active") checks.push("inactive_lineage");
    if (row.content !== item.content || hashChunkContent(row.content) !== item.contentHash || row.contentHash !== item.contentHash) checks.push("content_hash_mismatch");
    if (row.evidenceScope !== item.evidenceScope) checks.push("scope_mismatch");
    return { evidenceId: item.evidenceId, status: checks.length === 0 ? "verified" : "failed", checks };
  }
}
