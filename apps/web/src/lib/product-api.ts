import { NextResponse } from "next/server";
import { publicProductApiError } from "./product-api-error";

const PRODUCT_API_URL =
  process.env.PRODUCT_API_URL ?? "http://127.0.0.1:3001";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function invalidRequest(): NextResponse {
  return NextResponse.json(
    { error: "La solicitud no tiene un formato válido." },
    {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

export async function forwardProductApi(
  path: string,
  init: RequestInit = {},
  timeoutMs = 8_000,
  incomingRequest?: Request,
): Promise<NextResponse> {
  try {
    const url = new URL(path, PRODUCT_API_URL);
    const headers = new Headers(init.headers);
    if (incomingRequest) {
      const cookie = incomingRequest.headers.get("cookie");
      const origin = incomingRequest.headers.get("origin");
      if (cookie) {
        headers.set("cookie", cookie);
        const csrfCookie = cookie
          .split(";")
          .map((pair) => pair.trim())
          .find((pair) =>
            pair.startsWith("__Host-sentinel_csrf=") ||
            pair.startsWith("sentinel_csrf="),
          )
          ?.split("=")
          .slice(1)
          .join("=");
        if (csrfCookie) {
          headers.set("x-csrf-token", csrfCookie);
        }
      }
      if (origin) {
        headers.set("origin", origin);
      }
    }
    const response = await fetch(url, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const error = await publicError(response);
      forwardSetCookies(response, error);
      return error;
    }

    const responseHeaders = new Headers({
      "Cache-Control": "no-store",
    });
    forwardSetCookies(response, responseHeaders);

    if (response.status === 204) {
      return new NextResponse(null, {
        status: 204,
        headers: responseHeaders,
      });
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      const error = publicErrorForStatus(502);
      forwardSetCookies(response, error);
      return error;
    }

    return NextResponse.json(payload, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error: unknown) {
    return publicErrorForStatus(
      error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
        ? 504
        : 503,
    );
  }
}

export async function forwardJsonRequest(
  path: string,
  request: Request,
  timeoutMs = 8_000,
): Promise<NextResponse> {
  const method = request.method.toUpperCase();
  const init: RequestInit = { method };
  if (!["GET", "HEAD", "DELETE"].includes(method)) {
    init.headers = { "Content-Type": "application/json" };
    init.body = await request.text();
  }
  return forwardProductApi(path, init, timeoutMs, request);
}

function forwardSetCookies(
  response: Response,
  target: Headers | NextResponse,
): void {
  for (const cookie of response.headers.getSetCookie()) {
    if (target instanceof Headers) {
      target.append("Set-Cookie", cookie);
    } else {
      target.headers.append("Set-Cookie", cookie);
    }
  }
}

async function publicError(response: Response): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // The mapped public message remains the safe fallback.
  }

  return publicErrorForStatus(response.status, payload);
}

function publicErrorForStatus(status: number, payload?: unknown): NextResponse {
  const error = publicProductApiError(status, payload);
  return NextResponse.json(
    { error: error.error },
    {
      status: error.status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
