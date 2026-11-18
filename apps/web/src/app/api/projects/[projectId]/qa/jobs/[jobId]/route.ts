import { forwardProductApi, invalidRequest, isUuid } from "@/lib/product-api";

export async function GET(request: Request, context: { params: Promise<{ projectId: string; jobId: string }> }) {
  const { projectId, jobId } = await context.params;
  if (!isUuid(projectId) || !isUuid(jobId)) return invalidRequest();
  const url = new URL(request.url);
  const after = url.searchParams.get("afterSequence") ?? "0";
  if (!/^\d{1,7}$/u.test(after) || Number(after) > 1_000_000) return invalidRequest();
  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/qa/jobs/${encodeURIComponent(jobId)}?afterSequence=${encodeURIComponent(after)}`,
    {},
    8_000,
    request,
  );
}
