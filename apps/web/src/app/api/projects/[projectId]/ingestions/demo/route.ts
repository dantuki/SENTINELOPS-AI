import {
  forwardProductApi,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

export async function POST(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;

  if (!isUuid(projectId)) {
    return invalidRequest();
  }

  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/ingestions/demo`,
    { method: "POST" },
    150_000,
  );
}
