export type InvestigationMode = "deterministic" | "hybrid" | "ai";

export interface InvestigationRequest {
  question: string;
  limit?: number;
  incidentId?: string;
  mode?: InvestigationMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function isInvestigationRequest(
  value: unknown,
): value is InvestigationRequest {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ["question", "limit", "incidentId", "mode"].includes(key),
    ) ||
    typeof value.question !== "string" ||
    value.question.trim().length === 0 ||
    value.question.length > 20_000
  ) {
    return false;
  }

  if (
    value.limit !== undefined &&
    (typeof value.limit !== "number" ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 20)
  ) {
    return false;
  }

  return (
    (value.incidentId === undefined ||
      (typeof value.incidentId === "string" &&
        value.incidentId.trim().length > 0 &&
        value.incidentId.length <= 100)) &&
    (value.mode === undefined ||
      value.mode === "deterministic" ||
      value.mode === "hybrid" ||
      value.mode === "ai")
  );
}
