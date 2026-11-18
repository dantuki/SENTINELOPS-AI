import { forwardProductApi, invalidRequest, isUuid } from "@/lib/product-api";

function isAssistantRequest(value: unknown): value is { analysisRunId: string; question: string } {
  return typeof value === "object" && value !== null &&
    "analysisRunId" in value && typeof value.analysisRunId === "string" && isUuid(value.analysisRunId) &&
    "question" in value && typeof value.question === "string" && value.question.trim().length > 0 && value.question.length <= 2000 &&
    Object.keys(value).length === 2;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; conversationId: string }> },
) {
  const { projectId, conversationId } = await context.params;
  if (!isUuid(projectId) || !isUuid(conversationId)) return invalidRequest();
  let payload: unknown;
  try { payload = await request.json(); } catch { return invalidRequest(); }
  if (!isAssistantRequest(payload)) return invalidRequest();
  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(conversationId)}/assistant`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    35_000,
    request,
  );
}
