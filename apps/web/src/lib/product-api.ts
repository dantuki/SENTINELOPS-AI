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
): Promise<NextResponse> {
  try {
    const url = new URL(path, PRODUCT_API_URL);
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return publicError(response.status);
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      return publicError(502);
    }

    return NextResponse.json(payload, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
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

function publicError(status: number): NextResponse {
  const mappedStatus =
    status === 400 || status === 404 || status === 502 || status === 504
      ? status
      : 503;

  const messages: Record<number, string> = {
    400: "Revisa los datos de la solicitud.",
    404: "No se encontró el recurso solicitado.",
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
