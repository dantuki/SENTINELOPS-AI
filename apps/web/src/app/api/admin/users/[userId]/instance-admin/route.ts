import {
  forwardJsonRequest,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

export async function PUT(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  const { userId } = await context.params;
  if (!isUuid(userId)) {
    return invalidRequest();
  }
  return forwardJsonRequest(
    `/api/admin/users/${encodeURIComponent(userId)}/instance-admin`,
    request,
  );
}
