import type { EvidenceManifestItem } from "./retrieval-trace.js";

/**
 * A bounded, source-derived view of selected evidence for generation.
 *
 * This is deliberately not an extraction of conclusions: JSONL records retain
 * their original fields and identity, while other content remains available in
 * the evidence payload itself.  It helps a model keep fields from distinct
 * observed events separate without manufacturing a final answer.
 */
export interface EvidenceCandidateInventory {
  version: "evidence-candidate-inventory-v1";
  records: Array<{
    recordId: string;
    evidenceAlias: string;
    evidenceId: string;
    projectId: string;
    incidentId: string | null;
    evidenceScope: EvidenceManifestItem["evidenceScope"];
    startOffset: number;
    endOffset: number;
    fields: Record<string, unknown>;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse complete JSONL records only.  A record split across chunks or malformed
 * text is left solely in the original evidence, never reconstructed here.
 */
export function buildEvidenceCandidateInventory(
  evidence: EvidenceManifestItem[],
): EvidenceCandidateInventory {
  const records: EvidenceCandidateInventory["records"] = [];

  for (const item of evidence) {
    let lineNumber = 0;
    for (const match of item.content.matchAll(/[^\r\n]+/gu)) {
      lineNumber += 1;
      const raw = match[0];
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      const startOffset = match.index;
      records.push({
        recordId: `${item.alias}:line:${lineNumber}:${startOffset}`,
        evidenceAlias: item.alias,
        evidenceId: item.evidenceId,
        projectId: item.projectId,
        incidentId: item.incidentId,
        evidenceScope: item.evidenceScope,
        startOffset,
        endOffset: startOffset + raw.length,
        fields: value,
      });
    }
  }

  return { version: "evidence-candidate-inventory-v1", records };
}
