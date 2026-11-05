import {
  forwardJsonRequest,
  forwardProductApi,
} from "@/lib/product-api";

export async function GET(request: Request) {
  return forwardProductApi("/api/workspaces", {}, 8_000, request);
}

export async function POST(request: Request) {
  return forwardJsonRequest("/api/workspaces", request);
}
