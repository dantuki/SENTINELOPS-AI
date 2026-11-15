import { forwardProductApi, invalidRequest, isUuid } from "@/lib/product-api";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return isUuid(projectId)
    ? forwardProductApi(`/api/projects/${encodeURIComponent(projectId)}/qa/conversations`, {}, 8_000, request)
    : invalidRequest();
}

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  if (!isUuid(projectId)) return invalidRequest();
  let body: unknown;
  try { body = await request.json(); } catch { return invalidRequest(); }
  if (!body || typeof body !== "object" || !("title" in body) || typeof body.title !== "string" || !body.title.trim() || body.title.length > 160 || Object.keys(body).length !== 1) {
    return invalidRequest();
  }
  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/qa/conversations`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    8_000,
    request,
  );
}
