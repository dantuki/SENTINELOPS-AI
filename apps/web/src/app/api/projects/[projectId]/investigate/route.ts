import {
  forwardProductApi,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isInvestigationRequest(
  value: unknown,
): value is {
  question: string;
  limit?: number;
  incidentId?: string;
} {
  if (
    !isRecord(value) ||
    !Object.keys(value).every((key) =>
      ["question", "limit", "incidentId"].includes(key),
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
    value.incidentId === undefined ||
    (typeof value.incidentId === "string" &&
      value.incidentId.trim().length > 0 &&
      value.incidentId.length <= 100)
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;

  if (!isUuid(projectId)) {
    return invalidRequest();
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return invalidRequest();
  }

  if (!isInvestigationRequest(payload)) {
    return invalidRequest();
  }

  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/investigate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    150_000,
  );
}
