import {
  forwardJsonRequest,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

type RouteContext = {
  params: Promise<{ projectId: string; userId: string }>;
};

async function forwardMembershipChange(
  request: Request,
  context: RouteContext,
) {
  const { projectId, userId } = await context.params;
  if (!isUuid(projectId) || !isUuid(userId)) {
    return invalidRequest();
  }
  return forwardJsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    request,
  );
}

export async function PUT(request: Request, context: RouteContext) {
  return forwardMembershipChange(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return forwardMembershipChange(request, context);
}
