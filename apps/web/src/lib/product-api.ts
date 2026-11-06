import { NextResponse } from "next/server";

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
      const error = publicError(response.status);
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
      const error = publicError(502);
      forwardSetCookies(response, error);
      return error;
    }

    return NextResponse.json(payload, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error: unknown) {
    return publicError(
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

function publicError(status: number): NextResponse {
  const mappedStatus =
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 409 ||
    status === 413 ||
    status === 415 ||
    status === 422 ||
    status === 429 ||
    status === 502 ||
    status === 504
      ? status
      : 503;

  const messages: Record<number, string> = {
    400: "Revisa los datos de la solicitud.",
    401: "Debes iniciar sesión para continuar.",
    403: "No tienes permiso para realizar esta operación.",
    404: "No se encontró el recurso solicitado.",
    409: "El documento ya se está procesando o necesita una acción de reintento.",
    413: "El archivo supera el límite de tamaño permitido.",
    415: "Este tipo de archivo no está permitido.",
    422: "El archivo no pasó la validación de contenido.",
    429: "Hay demasiados intentos. Espera antes de volver a intentar.",
    502: "El servicio devolvió una respuesta no válida.",
    503: "El servicio de investigación no está disponible.",
    504: "La investigación tardó demasiado. Puedes intentarlo de nuevo.",
  };

  return NextResponse.json(
    { error: messages[mappedStatus] },
    {
      status: mappedStatus,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
