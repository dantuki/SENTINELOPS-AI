import {
  forwardProductApi,
  invalidRequest,
  isUuid,
} from "@/lib/product-api";

export async function POST(
  _request: Request,
  context: {
    params: Promise<{ projectId: string; documentId: string }>;
  },
) {
  const { projectId, documentId } = await context.params;

  if (!isUuid(projectId) || !isUuid(documentId)) {
    return invalidRequest();
  }

  return forwardProductApi(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/retry`,
    { method: "POST" },
    150_000,
  );
}
