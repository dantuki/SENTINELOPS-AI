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

  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !["name", "content"].includes(key)) ||
    typeof payload.name !== "string" ||
    typeof payload.content !== "string" ||
    payload.name.trim().length === 0 ||
    payload.content.length === 0 ||
    payload.content.length > 180_000 ||
    new TextEncoder().encode(payload.content).byteLength > 200_000
  ) {
    return invalidRequest();
  }

  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/ingestions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    150_000,
  );
}
