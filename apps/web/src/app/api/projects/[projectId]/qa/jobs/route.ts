import { forwardProductApi, invalidRequest, isUuid } from "@/lib/product-api";
import { isGithubQaJobRequest } from "@/lib/qa-request";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  if (!isUuid(projectId)) return invalidRequest();
  let payload: unknown;
  try { payload = await request.json(); } catch { return invalidRequest(); }
  if (!isGithubQaJobRequest(payload)) return invalidRequest();
  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/qa/jobs`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    8_000,
    request,
  );
}
