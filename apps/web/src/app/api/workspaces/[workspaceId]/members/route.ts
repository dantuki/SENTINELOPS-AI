import {
  forwardProductApi,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await context.params;
  if (!isUuid(workspaceId)) {
    return invalidRequest();
  }
  return forwardProductApi(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members`,
    {},
    8_000,
    request,
  );
}
