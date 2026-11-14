import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { loginPathFor } from "@/lib/auth-redirect";

export interface CurrentUser {
  id: string;
  email: string;
  instanceRole: "INSTANCE_ADMIN" | null;
  lastLoginAt: string | null;
}

function isCurrentUserResponse(value: unknown): value is { data: CurrentUser } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null &&
    "id" in value.data &&
    typeof value.data.id === "string" &&
    "email" in value.data &&
    typeof value.data.email === "string" &&
    "instanceRole" in value.data &&
    (value.data.instanceRole === null || value.data.instanceRole === "INSTANCE_ADMIN") &&
    "lastLoginAt" in value.data &&
    (value.data.lastLoginAt === null || typeof value.data.lastLoginAt === "string")
  );
}

export async function getAuthenticatedUser(): Promise<CurrentUser | null> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  if (!cookie) {
    return null;
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
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload: unknown = await response.json();
  if (!isCurrentUserResponse(payload)) return null;

  return {
    id: payload.data.id,
    email: payload.data.email,
    instanceRole: payload.data.instanceRole,
    lastLoginAt: payload.data.lastLoginAt,
  };
}

export async function requireAuthenticatedPage(
  returnTo: string,
): Promise<CurrentUser> {
  const user = await getAuthenticatedUser();
  if (!user) redirect(loginPathFor(returnTo));
  return user;
}
