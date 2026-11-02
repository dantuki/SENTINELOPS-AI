import { forwardProductApi } from "@/lib/product-api";

export async function GET() {
  return forwardProductApi("/api/workspaces");
}
