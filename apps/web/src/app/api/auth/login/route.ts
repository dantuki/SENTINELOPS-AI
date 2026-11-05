import { forwardProductApi } from "@/lib/product-api";

export async function POST(request: Request) {
  return forwardProductApi(
    "/api/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    },
    8_000,
    request,
  );
}
