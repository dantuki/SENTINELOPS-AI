import { forwardProductApi } from "@/lib/product-api";

export async function POST(request: Request) {
  return forwardProductApi(
    "/api/auth/refresh",
    { method: "POST" },
    8_000,
    request,
  );
}
