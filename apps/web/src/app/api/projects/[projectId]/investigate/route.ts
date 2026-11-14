import {
  forwardProductApi,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";
import { isInvestigationRequest } from "@/lib/investigation-request";

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;

  if (!isUuid(projectId)) {
    return invalidRequest();
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return invalidRequest();
  }

  if (!isInvestigationRequest(payload)) {
    return invalidRequest();
  }

  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/investigate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    150_000,
    request,
  );
}
