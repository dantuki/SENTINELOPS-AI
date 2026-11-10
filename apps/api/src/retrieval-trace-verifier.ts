import type { Pool } from "pg";

import type { EvidenceVerificationStatus } from "./inc001-evaluation.js";
import {
  classifyEvidenceScope,
  hashChunkContent,
  isUuid,
  type EvidenceManifestItem,
} from "./retrieval-trace.js";

export interface TraceVerificationReport {
  status: "verified" | "unverified" | "failed";
  verifiedCount: number;
  unverifiedCount: number;
  failedCount: number;
  verificationErrors: string[];
  verifiedEvidenceIds: string[];
  requestId: string;
  runId: string;
  evidence: EvidenceVerificationStatus[];
}

/**
 * Data read from PostgreSQL while verifying one retrieval item.  This is an
 * attestation of consistency with the rows queried at verification time, not
 * an external signature and not a historical database snapshot.
 */
export interface EvidenceAttestationV2 {
  evidenceId: string;
  chunkId: string;
  documentId: string;
  sourceId: string;
  projectId: string;
  runId: string;
  retrievalRequestId: string;
  requestedIncidentId: string | null;
  rank: number;
  ordinal: number;
  expectedContentHash: string;
  storedContentHash: string | null;
  recomputedContentHash: string | null;
  contentMatchesManifest: boolean;
  hashesMatch: boolean;
  documentMatchesSource: boolean;
  projectMatches: boolean;
  documentStatus: string | null;
  sourceStatus: string | null;
  evidenceScope: string | null;
  metadata: {
    documentTitle: string | null;
    mediaType: string | null;
    sourceDocumentKey: string | null;
    sourceType: string | null;
    chunkStartOffset: number | null;
    chunkEndOffset: number | null;
    chunkMetadata: Record<string, unknown> | null;
    documentMetadata: Record<string, unknown> | null;
    sourceMetadata: Record<string, unknown> | null;
  };
  errors: string[];
}

export interface RetrievalTraceExpectation {
  runId: string;
  requestId: string;
  projectId: string;
  incidentId: string | null;
  retrievedAt: string;
  manifest: EvidenceManifestItem[];
}

interface TraceRow {
  runId: string;
  requestId: string;
  projectId: string;
  incidentId: string | null;
  retrievedAt: Date | string;
  rank: number | null;
  chunkId: string | null;
  documentId: string | null;
  sourceId: string | null;
  projectItemId: string | null;
  ordinal: number | null;
  score: number | null;
  contentHash: string | null;
  evidenceScope: string | null;
  itemRetrievedAt: Date | string | null;
  content: string | null;
  metadata: Record<string, unknown> | null;
  documentSourceId: string | null;
  documentStatus: string | null;
  sourceStatus: string | null;
  documentTitle: string | null;
  mediaType: string | null;
  sourceDocumentKey: string | null;
  sourceType: string | null;
  chunkStartOffset: number | null;
  chunkEndOffset: number | null;
  documentMetadata: Record<string, unknown> | null;
  sourceMetadata: Record<string, unknown> | null;
}

function isoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function invalidManifestItem(item: EvidenceManifestItem, index: number): string[] {
  const errors: string[] = [];
  if (!isUuid(item.evidenceId) || item.evidenceId !== item.chunkId) {
    errors.push(`manifest_item_${index + 1}_canonical_chunk_identity_mismatch`);
  }
  if (item.alias !== `E${index + 1}` || item.rank !== index + 1) {
    errors.push(`manifest_item_${index + 1}_alias_or_rank_mismatch`);
  }
  if (
    !isUuid(item.runId) ||
    !isUuid(item.requestId) ||
    !isUuid(item.projectId) ||
    !isUuid(item.documentId) ||
    !isUuid(item.sourceId)
  ) {
    errors.push(`manifest_item_${index + 1}_invalid_uuid`);
  }
  if (
    !Number.isInteger(item.ordinal) ||
    item.ordinal < 0 ||
    !Number.isFinite(item.score) ||
    item.content.length === 0 ||
    item.contentHash !== hashChunkContent(item.content) ||
    isoTimestamp(item.retrievedAt) === null
  ) {
    errors.push(`manifest_item_${index + 1}_invalid_content_or_metrics`);
  }
  return errors;
}

/**
 * Verifies one complete retrieval event using only the supplied read-only
 * database pool. It does not create connections or consult environment state.
 */
export class RetrievalTraceVerifier {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async verifyTrace(
    expected: RetrievalTraceExpectation,
  ): Promise<TraceVerificationReport> {
    const verificationErrors: string[] = [];
    const manifest = expected.manifest;
    const evidence = manifest.map<EvidenceVerificationStatus>((item) => ({
      evidenceId: item.evidenceId,
      status: "failed",
    }));

    if (
      !isUuid(expected.runId) ||
      !isUuid(expected.requestId) ||
      !isUuid(expected.projectId) ||
      isoTimestamp(expected.retrievedAt) === null
    ) {
      verificationErrors.push("expected_trace_identity_invalid");
    }

    const evidenceIds = new Set<string>();
    for (let index = 0; index < manifest.length; index += 1) {
      const item = manifest[index]!;
      verificationErrors.push(...invalidManifestItem(item, index));
      if (evidenceIds.has(item.evidenceId)) {
        verificationErrors.push(`manifest_item_${index + 1}_duplicate_evidence_id`);
      }
      evidenceIds.add(item.evidenceId);
      if (
        item.runId !== expected.runId ||
        item.requestId !== expected.requestId ||
        item.projectId !== expected.projectId ||
        item.incidentId !== expected.incidentId ||
        isoTimestamp(item.retrievedAt) !== isoTimestamp(expected.retrievedAt)
      ) {
        verificationErrors.push(`manifest_item_${index + 1}_trace_header_mismatch`);
      }
    }

    const result = await this.pool.query<TraceRow>(
      `SELECT
         event.run_id AS "runId",
         event.request_id AS "requestId",
         event.project_id AS "projectId",
         event.incident_id AS "incidentId",
         event.retrieved_at AS "retrievedAt",
         item.rank,
         item.chunk_id AS "chunkId",
         item.document_id AS "documentId",
         item.source_id AS "sourceId",
         item.project_id AS "projectItemId",
         item.ordinal,
         item.score,
         item.content_sha256 AS "contentHash",
         item.evidence_scope AS "evidenceScope",
         item.retrieved_at AS "itemRetrievedAt",
         chunk.content,
         chunk.metadata,
         chunk.start_offset AS "chunkStartOffset",
         chunk.end_offset AS "chunkEndOffset",
         document.source_id AS "documentSourceId",
         document.status AS "documentStatus",
         document.title AS "documentTitle",
         document.media_type AS "mediaType",
         document.source_document_key AS "sourceDocumentKey",
         document.metadata AS "documentMetadata",
         source.status AS "sourceStatus",
         source.source_type AS "sourceType",
         source.metadata AS "sourceMetadata"
       FROM retrieval_events AS event
       LEFT JOIN retrieval_event_items AS item
         ON item.request_id = event.request_id
       LEFT JOIN document_chunks AS chunk
         ON chunk.id = item.chunk_id
        AND chunk.project_id = item.project_id
        AND chunk.document_id = item.document_id
       LEFT JOIN documents AS document
         ON document.id = item.document_id
        AND document.project_id = item.project_id
       LEFT JOIN project_sources AS source
         ON source.id = item.source_id
        AND source.project_id = item.project_id
       WHERE event.request_id = $1::uuid
       ORDER BY item.rank NULLS FIRST`,
      [expected.requestId],
    );

    if (result.rows.length === 0) {
      verificationErrors.push("retrieval_event_header_missing");
      return this.report(expected, evidence, verificationErrors, manifest.length);
    }

    const header = result.rows[0]!;
    if (
      header.runId !== expected.runId ||
      header.requestId !== expected.requestId ||
      header.projectId !== expected.projectId ||
      header.incidentId !== expected.incidentId ||
      isoTimestamp(header.retrievedAt) !== isoTimestamp(expected.retrievedAt)
    ) {
      verificationErrors.push("retrieval_event_header_mismatch");
    }

    const rows = result.rows.filter((row) => row.rank !== null);
    if (rows.length !== manifest.length) {
      verificationErrors.push(
        `retrieval_event_cardinality_mismatch_expected_${manifest.length}_actual_${rows.length}`,
      );
    }

    for (let index = 0; index < manifest.length; index += 1) {
      const item = manifest[index]!;
      const row = rows[index];
      const checks: string[] = [];
      if (!row) {
        checks.push("trace_item_missing");
      } else {
        if (
          row.rank !== item.rank ||
          row.chunkId !== item.chunkId ||
          row.documentId !== item.documentId ||
          row.sourceId !== item.sourceId ||
          row.projectItemId !== item.projectId ||
          row.documentSourceId !== item.sourceId ||
          row.ordinal !== item.ordinal
        ) {
          checks.push("lineage_or_order_mismatch");
        }
        if (row.score !== item.score) checks.push("score_mismatch");
        if (
          row.content === null ||
          row.content !== item.content ||
          hashChunkContent(row.content) !== item.contentHash ||
          row.contentHash !== item.contentHash
        ) {
          checks.push("content_or_hash_mismatch");
        }
        if (
          row.documentStatus !== "indexed" ||
          row.sourceStatus !== "active"
        ) {
          checks.push("inactive_or_missing_lineage");
        }
        const computedScope = classifyEvidenceScope(
          row.metadata ?? {},
          expected.incidentId ?? undefined,
        );
        if (
          row.evidenceScope !== item.evidenceScope ||
          computedScope !== item.evidenceScope
        ) {
          checks.push("scope_mismatch");
        }
        if (
          isoTimestamp(row.itemRetrievedAt) !==
          isoTimestamp(item.retrievedAt)
        ) {
          checks.push("retrieval_timestamp_mismatch");
        }
      }
      const manifestErrors = invalidManifestItem(item, index);
      const localErrors = [...manifestErrors, ...checks];
      // Individual evidence is assessed only against its own checks.  A
      // header/cardinality failure still fails the whole trace below and V2
      // consumers must reject it fail-closed.
      const status = localErrors.length === 0 ? "verified" : "failed";
      evidence[index] = {
        evidenceId: item.evidenceId,
        status,
        attestation: this.attest(item, expected, row, localErrors),
      };
      if (checks.length > 0) {
        verificationErrors.push(
          `manifest_item_${index + 1}_${checks.join("_")}`,
        );
      }
    }

    if (rows.length > manifest.length) {
      verificationErrors.push("retrieval_event_contains_unmanifested_items");
    }
    return this.report(expected, evidence, verificationErrors, rows.length);
  }

  private attest(
    item: EvidenceManifestItem,
    expected: RetrievalTraceExpectation,
    row: TraceRow | undefined,
    errors: string[],
  ): EvidenceAttestationV2 {
    const recomputedContentHash = row?.content === null || row?.content === undefined
      ? null
      : hashChunkContent(row.content);
    const storedContentHash = row?.contentHash ?? null;
    return {
      evidenceId: item.evidenceId,
      chunkId: row?.chunkId ?? item.chunkId,
      documentId: row?.documentId ?? item.documentId,
      sourceId: row?.sourceId ?? item.sourceId,
      projectId: row?.projectItemId ?? item.projectId,
      runId: row?.runId ?? expected.runId,
      retrievalRequestId: row?.requestId ?? expected.requestId,
      requestedIncidentId: row?.incidentId ?? expected.incidentId,
      rank: row?.rank ?? item.rank,
      ordinal: row?.ordinal ?? item.ordinal,
      expectedContentHash: item.contentHash,
      storedContentHash,
      recomputedContentHash,
      contentMatchesManifest: row?.content === item.content,
      hashesMatch:
        storedContentHash === item.contentHash &&
        recomputedContentHash === item.contentHash,
      documentMatchesSource: row?.documentSourceId === item.sourceId,
      projectMatches: row?.projectItemId === item.projectId,
      documentStatus: row?.documentStatus ?? null,
      sourceStatus: row?.sourceStatus ?? null,
      evidenceScope: row?.evidenceScope ?? null,
      metadata: {
        documentTitle: row?.documentTitle ?? null,
        mediaType: row?.mediaType ?? null,
        sourceDocumentKey: row?.sourceDocumentKey ?? null,
        sourceType: row?.sourceType ?? null,
        chunkStartOffset: row?.chunkStartOffset ?? null,
        chunkEndOffset: row?.chunkEndOffset ?? null,
        chunkMetadata: row?.metadata ?? null,
        documentMetadata: row?.documentMetadata ?? null,
        sourceMetadata: row?.sourceMetadata ?? null,
      },
      errors: [...errors],
    };
  }

  private report(
    expected: RetrievalTraceExpectation,
    evidence: EvidenceVerificationStatus[],
    verificationErrors: string[],
    storedItemCount: number,
  ): TraceVerificationReport {
    const verifiedCount = evidence.filter(
      ({ status }) => status === "verified",
    ).length;
    const failedCount =
      evidence.filter(({ status }) => status === "failed").length +
      Math.max(0, storedItemCount - evidence.length);
    const unverifiedCount = evidence.filter(
      ({ status }) => status === "unverified",
    ).length;
    if (verificationErrors.length > 0 && failedCount === 0) {
      verificationErrors.push("retrieval_trace_header_or_cardinality_failed");
    }
    const status =
      verificationErrors.length > 0 || failedCount > 0
        ? "failed"
        : unverifiedCount > 0
          ? "unverified"
          : "verified";
    return {
      status,
      verifiedCount,
      unverifiedCount,
      failedCount,
      verificationErrors: [...new Set(verificationErrors)].sort(),
      verifiedEvidenceIds: evidence
        .filter(({ status: itemStatus }) => itemStatus === "verified")
        .map(({ evidenceId }) => evidenceId),
      requestId: expected.requestId,
      runId: expected.runId,
      evidence,
    };
  }
}
