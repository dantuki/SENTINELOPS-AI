import { forwardProductApi, invalidRequest, isUuid } from "@/lib/product-api";

export async function GET(request: Request, context: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const { projectId, conversationId } = await context.params;
  return isUuid(projectId) && isUuid(conversationId)
    ? forwardProductApi(`/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(conversationId)}`, {}, 8_000, request)
    : invalidRequest();
}

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const { projectId, conversationId } = await context.params;
  if (!isUuid(projectId) || !isUuid(conversationId)) return invalidRequest();
  let body: unknown;
  try { body = await request.json(); } catch { return invalidRequest(); }
  if (!body || typeof body !== "object" || !("isPinned" in body) || typeof body.isPinned !== "boolean" || Object.keys(body).length !== 1) return invalidRequest();
  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(conversationId)}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    8_000,
    request,
  );
}
