export const DEFAULT_AUTHENTICATED_DESTINATION = "/qa";

const PROTECTED_DESTINATIONS = new Set([
  "/qa",
  "/investigation",
  "/knowledge-base",
]);

/** Accepts only known internal product pages; it never echoes an arbitrary URL. */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return null;
  }
  if (value !== value.trim() || value.includes("\\") || value.includes("\u0000")) {
    return null;
  }
  return PROTECTED_DESTINATIONS.has(value) ? value : null;
}

export function authenticatedDestination(value: unknown): string {
  return safeReturnTo(value) ?? DEFAULT_AUTHENTICATED_DESTINATION;
}

export function loginPathFor(value: unknown): string {
  const destination = authenticatedDestination(value);
  return destination === DEFAULT_AUTHENTICATED_DESTINATION
    ? "/login"
    : `/login?returnTo=${encodeURIComponent(destination)}`;
}
