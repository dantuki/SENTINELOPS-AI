import { createHash } from "node:crypto";

import type { EvidenceManifestItem } from "./retrieval-trace.js";
import type { TraceVerificationReport } from "./retrieval-trace-verifier.js";

export type VerifiedFactValue = string | number | boolean | null;

export interface VerifiedFactSourceLocator {
  line: number;
  startOffset: number;
  endOffset: number;
  recordContentHash: string;
}

export interface VerifiedFactContext {
  event: string | null;
  timestamp: string | null;
  service: string | null;
  incidentRequestId: string | null;
}

export interface VerifiedFactRecord {
  recordId: string;
  eventId: string;
  evidenceId: string;
  evidenceAlias: string;
  projectId: string;
  incidentId: string;
  documentId: string;
  sourceId: string;
  fields: Record<string, VerifiedFactValue>;
  context: VerifiedFactContext;
  sourceLocator: VerifiedFactSourceLocator;
  extractionMethod: "jsonl_record";
  verificationStatus: "verified";
}

export interface VerifiedFact {
  factId: string;
  evidenceId: string;
  eventId: string;
  projectId: string;
  incidentId: string;
  documentId: string;
  sourceId: string;
  property: string;
  value: VerifiedFactValue;
  valueType: "string" | "number" | "boolean" | "null";
  unit: string | null;
  context: VerifiedFactContext;
  sourceLocator: VerifiedFactSourceLocator;
  extractionMethod: "jsonl_record";
  verificationStatus: "verified";
}

export interface VerifiedContextualArtifact {
  evidenceId: string;
  evidenceAlias: string;
  projectId: string;
  incidentId: string | null;
  documentId: string;
  sourceId: string;
  contentHash: string;
  classification: "static_code" | "unstructured_text";
  verificationStatus: "verified";
  limitation: string;
}

export interface VerifiedFactIssue {
  evidenceId: string;
  line: number | null;
  reason:
    | "trace_not_verified"
    | "evidence_not_verified"
    | "scope_not_incident_specific"
    | "incident_mismatch_or_missing"
    | "invalid_or_incomplete_json"
    | "record_not_object"
    | "unsupported_field_shape"
    | "sensitive_field_excluded";
}

export interface VerifiedFactInventory {
  version: "verified-fact-inventory-v1";
  attestationStatus: "verified" | "failed" | "unverified";
  records: VerifiedFactRecord[];
  facts: VerifiedFact[];
  contextualArtifacts: VerifiedContextualArtifact[];
  issues: VerifiedFactIssue[];
}

/** The only verified runtime context that may be sent to a model. */
export interface VerifiedFactPromptInventory {
  version: VerifiedFactInventory["version"];
  attestationStatus: VerifiedFactInventory["attestationStatus"];
  records: VerifiedFactPromptRecord[];
  contextualArtifacts: Array<
    Pick<VerifiedContextualArtifact, "evidenceAlias" | "classification" | "limitation">
  >;
}

/**
 * A compact, attested property that a model may repeat in an observed fact.
 * `propertyId` is request-local and is never derived from a dataset label or
 * an expected evaluation observation.
 */
export interface VerifiedFactPromptProperty {
  propertyId: string;
  property: string;
  value: VerifiedFactValue;
  valueType: VerifiedFact["valueType"];
  unit: string | null;
}

/**
 * The model-facing representation of one JSONL runtime record.  It keeps the
 * original identity and provenance for server-side validation while exposing
 * only an opaque event alias to the model.
 */
export interface VerifiedFactPromptRecord {
  eventAlias: string;
  eventId: string;
  evidenceAlias: string;
  fields: Record<string, VerifiedFactValue>;
  properties: VerifiedFactPromptProperty[];
  context: VerifiedFactContext;
  sourceLocator: VerifiedFactSourceLocator;
}

export interface VerifiedFactExtractionInput {
  manifest: EvidenceManifestItem[];
  trace: TraceVerificationReport;
  runId: string;
  requestId: string;
  projectId: string;
  incidentId: string;
}

/**
 * Produces a bounded projection for model composition. It deliberately omits
 * raw document content and the full duplicate fact list; event identity,
 * record hash/offset and exact scalar fields remain available for citation.
 */
export function projectVerifiedFactsForPrompt(
  inventory: VerifiedFactInventory,
): VerifiedFactPromptInventory {
  return {
    version: inventory.version,
    attestationStatus: inventory.attestationStatus,
    records: inventory.records.map((record, recordIndex) => ({
      eventAlias: `R${recordIndex + 1}`,
      evidenceAlias: record.evidenceAlias,
      eventId: record.eventId,
      fields: record.fields,
      // Identity and envelope fields are represented separately as context.
      // All remaining scalar properties must be generated explicitly when a
      // runtime analysis is requested, including zeroes and units.
      properties: Object.entries(record.fields)
        .filter(([property]) => !["dataset", "incident_id", "event", "timestamp", "level", "service"].includes(property))
        .map(([property, value], propertyIndex) => ({
          propertyId: `P${recordIndex + 1}_${propertyIndex + 1}`,
          property,
          value,
          valueType: valueType(value),
          unit: unitForProperty(property),
        })),
      context: record.context,
      sourceLocator: record.sourceLocator,
    })),
    contextualArtifacts: inventory.contextualArtifacts.map(
      ({ evidenceAlias, classification, limitation }) => ({
        evidenceAlias,
        classification,
        limitation,
      }),
    ),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFactValue(value: unknown): value is VerifiedFactValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  );
}

function valueType(value: VerifiedFactValue): VerifiedFact["valueType"] {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function isSensitiveProperty(property: string): boolean {
  return /(?:password|secret|token|authorization|api[_-]?key|credential)/iu.test(
    property,
  );
}

function unitForProperty(property: string): string | null {
  if (/(?:^|_)ms$/iu.test(property) || /duration_ms$/iu.test(property)) {
    return "milliseconds";
  }
  if (/(?:^|_)bytes$/iu.test(property)) return "bytes";
  if (/(?:^|_)percent(?:age)?$/iu.test(property)) return "percent";
  return null;
}

function contextFromFields(
  fields: Record<string, VerifiedFactValue>,
): VerifiedFactContext {
  return {
    event: typeof fields.event === "string" ? fields.event : null,
    timestamp: typeof fields.timestamp === "string" ? fields.timestamp : null,
    service: typeof fields.service === "string" ? fields.service : null,
    incidentRequestId:
      typeof fields.request_id === "string" ? fields.request_id : null,
  };
}

function recordHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isTypeScriptArtifact(item: EvidenceManifestItem, sourceKey: string | null): boolean {
  return sourceKey?.endsWith(".ts") === true || /\.(?:ts|tsx)$/iu.test(item.content.trimStart().slice(0, 80));
}

/**
 * Extracts only scalar values present in individually attested JSONL records.
 * It intentionally does not merge lines, infer absent values, or interpret
 * static source code as a runtime event.
 */
export function extractVerifiedFacts(
  input: VerifiedFactExtractionInput,
): VerifiedFactInventory {
  const records: VerifiedFactRecord[] = [];
  const facts: VerifiedFact[] = [];
  const contextualArtifacts: VerifiedContextualArtifact[] = [];
  const issues: VerifiedFactIssue[] = [];
  const traceUsable =
    input.trace.status === "verified" &&
    input.trace.verificationErrors.length === 0 &&
    input.trace.runId === input.runId &&
    input.trace.requestId === input.requestId;
  if (!traceUsable) {
    for (const item of input.manifest) {
      issues.push({ evidenceId: item.evidenceId, line: null, reason: "trace_not_verified" });
    }
    return {
      version: "verified-fact-inventory-v1",
      attestationStatus: input.trace.status === "verified" ? "failed" : input.trace.status,
      records,
      facts,
      contextualArtifacts,
      issues,
    };
  }

  const verificationById = new Map(
    input.trace.evidence.map((entry) => [entry.evidenceId, entry]),
  );
  for (const item of input.manifest) {
    const verification = verificationById.get(item.evidenceId);
    const attestation = verification?.attestation;
    const usable =
      verification?.status === "verified" &&
      attestation?.hashesMatch === true &&
      attestation.contentMatchesManifest === true &&
      attestation.projectMatches === true &&
      attestation.documentMatchesSource === true &&
      attestation.documentStatus === "indexed" &&
      attestation.sourceStatus === "active" &&
      item.runId === input.runId &&
      item.requestId === input.requestId &&
      item.projectId === input.projectId;
    if (!usable) {
      issues.push({ evidenceId: item.evidenceId, line: null, reason: "evidence_not_verified" });
      continue;
    }
    if (item.evidenceScope !== "incident_specific") {
      issues.push({ evidenceId: item.evidenceId, line: null, reason: "scope_not_incident_specific" });
      continue;
    }
    if (item.incidentId !== input.incidentId) {
      issues.push({ evidenceId: item.evidenceId, line: null, reason: "incident_mismatch_or_missing" });
      continue;
    }

    let parsedRecordCount = 0;
    let sawJsonCandidate = false;
    let line = 0;
    for (const match of item.content.matchAll(/[^\r\n]+/gu)) {
      line += 1;
      const raw = match[0];
      if (!raw.trim()) continue;
      if (/^[{[]/u.test(raw.trim())) sawJsonCandidate = true;
      let rawValue: unknown;
      try {
        rawValue = JSON.parse(raw);
      } catch {
        if (/^[{[]/u.test(raw.trim())) {
          issues.push({ evidenceId: item.evidenceId, line, reason: "invalid_or_incomplete_json" });
        }
        continue;
      }
      if (!isRecord(rawValue)) {
        issues.push({ evidenceId: item.evidenceId, line, reason: "record_not_object" });
        continue;
      }
      if (rawValue.incident_id !== input.incidentId) {
        issues.push({ evidenceId: item.evidenceId, line, reason: "incident_mismatch_or_missing" });
        continue;
      }
      const fields: Record<string, VerifiedFactValue> = {};
      for (const [property, value] of Object.entries(rawValue)) {
        if (isSensitiveProperty(property)) {
          issues.push({ evidenceId: item.evidenceId, line, reason: "sensitive_field_excluded" });
          continue;
        }
        if (!isFactValue(value) || (typeof value === "number" && !Number.isFinite(value))) {
          issues.push({ evidenceId: item.evidenceId, line, reason: "unsupported_field_shape" });
          continue;
        }
        fields[property] = value;
      }
      const hash = recordHash(raw);
      const sourceLocator: VerifiedFactSourceLocator = {
        line,
        startOffset: match.index,
        endOffset: match.index + raw.length,
        recordContentHash: hash,
      };
      const eventId = `${item.chunkId}:${sourceLocator.startOffset}:${hash}`;
      const record: VerifiedFactRecord = {
        recordId: `record:${eventId}`,
        eventId,
        evidenceId: item.evidenceId,
        evidenceAlias: item.alias,
        projectId: item.projectId,
        incidentId: input.incidentId,
        documentId: item.documentId,
        sourceId: item.sourceId,
        fields,
        context: contextFromFields(fields),
        sourceLocator,
        extractionMethod: "jsonl_record",
        verificationStatus: "verified",
      };
      records.push(record);
      parsedRecordCount += 1;
      for (const [property, value] of Object.entries(fields)) {
        facts.push({
          factId: `fact:${eventId}:${property}`,
          evidenceId: item.evidenceId,
          eventId,
          projectId: item.projectId,
          incidentId: input.incidentId,
          documentId: item.documentId,
          sourceId: item.sourceId,
          property,
          value,
          valueType: valueType(value),
          unit: unitForProperty(property),
          context: record.context,
          sourceLocator,
          extractionMethod: "jsonl_record",
          verificationStatus: "verified",
        });
      }
    }
    if (parsedRecordCount === 0 && !sawJsonCandidate) {
      contextualArtifacts.push({
        evidenceId: item.evidenceId,
        evidenceAlias: item.alias,
        projectId: item.projectId,
        incidentId: item.incidentId,
        documentId: item.documentId,
        sourceId: item.sourceId,
        contentHash: item.contentHash,
        classification: isTypeScriptArtifact(
          item,
          attestation.metadata.sourceDocumentKey,
        )
          ? "static_code"
          : "unstructured_text",
        verificationStatus: "verified",
        limitation: "The artifact is provenance-verified, but it is not a verified runtime event.",
      });
    }
  }

  return {
    version: "verified-fact-inventory-v1",
    attestationStatus: "verified",
    records,
    facts,
    contextualArtifacts,
    issues,
  };
}
