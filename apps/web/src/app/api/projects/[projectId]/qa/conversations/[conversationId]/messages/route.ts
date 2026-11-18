import { forwardProductApi, invalidRequest, isUuid } from "@/lib/product-api";

export async function POST(request: Request, context: { params: Promise<{ projectId: string; conversationId: string }> }) {
  const { projectId, conversationId } = await context.params;
  if (!isUuid(projectId) || !isUuid(conversationId)) return invalidRequest();
  let body: unknown;
  try { body = await request.json(); } catch { return invalidRequest(); }
  if (!body || typeof body !== "object" || !("role" in body) || !("body" in body) || body.role !== "user" || typeof body.body !== "string" || !body.body.trim() || body.body.length > 8_000 || Object.keys(body).length !== 2) return invalidRequest();
  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/qa/conversations/${encodeURIComponent(conversationId)}/messages`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    8_000,
    request,
  );
}
