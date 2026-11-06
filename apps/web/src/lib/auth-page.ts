import { headers } from "next/headers";
import { redirect } from "next/navigation";

export interface CurrentUser {
  id: string;
  email: string;
  instanceRole: "INSTANCE_ADMIN" | null;
  lastLoginAt: string | null;
}

export async function requireAuthenticatedPage(): Promise<CurrentUser> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  if (!cookie) {
    redirect("/login");
  }

  const apiUrl =
    process.env.PRODUCT_API_URL ?? "http://127.0.0.1:3001";
  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/session", apiUrl), {
      headers: { cookie },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    redirect("/login?unavailable=1");
  }

  if (!response.ok) {
    redirect("/login");
  }

  const payload: unknown = await response.json();
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    typeof payload.data !== "object" ||
    payload.data === null ||
    !("id" in payload.data) ||
    typeof payload.data.id !== "string" ||
    !("email" in payload.data) ||
    typeof payload.data.email !== "string" ||
    !("instanceRole" in payload.data) ||
    (payload.data.instanceRole !== null &&
      payload.data.instanceRole !== "INSTANCE_ADMIN") ||
    !("lastLoginAt" in payload.data) ||
    (payload.data.lastLoginAt !== null &&
      typeof payload.data.lastLoginAt !== "string")
  ) {
    redirect("/login");
  }

  return {
    id: payload.data.id,
    email: payload.data.email,
    instanceRole: payload.data.instanceRole,
    lastLoginAt: payload.data.lastLoginAt,
  };
}
