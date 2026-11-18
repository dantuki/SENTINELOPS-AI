const PUBLIC_STATUSES = new Set([
  400, 401, 403, 404, 409, 413, 415, 422, 429, 502, 504,
]);

const PUBLIC_MESSAGES: Record<number, string> = {
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

function upstreamPublicError(payload: unknown): string | undefined {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("error" in payload) ||
    typeof payload.error !== "string"
  ) {
    return undefined;
  }

  const message = payload.error.trim();
  return message.length > 0 && message.length <= 300 ? message : undefined;
}

/** Maps status codes and exposes only the API's documented `error` field. */
export function publicProductApiError(
  status: number,
  payload?: unknown,
): { status: number; error: string } {
  const mappedStatus = PUBLIC_STATUSES.has(status) ? status : 503;
  const upstreamError = mappedStatus === status
    ? upstreamPublicError(payload)
    : undefined;
  return {
    status: mappedStatus,
    error: upstreamError ?? PUBLIC_MESSAGES[mappedStatus]!,
  };
}
