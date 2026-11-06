import { forwardJsonRequest } from "@/lib/product-api";

export async function POST(request: Request) {
  return forwardJsonRequest("/api/admin/users", request);
}
