import {
  forwardJsonRequest,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

type RouteContext = {
  params: Promise<{ workspaceId: string; userId: string }>;
};

async function forwardMembershipChange(
  request: Request,
  context: RouteContext,
) {
  const { workspaceId, userId } = await context.params;
  if (!isUuid(workspaceId) || !isUuid(userId)) {
    return invalidRequest();
  }
  return forwardJsonRequest(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`,
    request,
  );
}

export async function PUT(request: Request, context: RouteContext) {
  return forwardMembershipChange(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return forwardMembershipChange(request, context);
}
