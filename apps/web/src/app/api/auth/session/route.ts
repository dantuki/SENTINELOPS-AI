import { forwardProductApi } from "@/lib/product-api";

export async function GET(request: Request) {
  return forwardProductApi(
    "/api/auth/session",
    {},
    8_000,
    request,
  );
}
