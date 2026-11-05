import {
  forwardJsonRequest,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

export async function POST(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const { userId } = await context.params;
  if (!isUuid(userId)) {
    return invalidRequest();
  }
  return forwardJsonRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/deactivate`,
    request,
  );
}
