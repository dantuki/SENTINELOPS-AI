const QA_PERSISTENCE_UNAVAILABLE_MESSAGE =
  "La memoria persistente de QA no está preparada en este entorno.";

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

/** Maps API failures without exposing untrusted or internal error details. */
export function messageForQaApiFailure(status: number, payload?: unknown): string {
  const upstreamError = upstreamPublicError(payload);
  if (status === 503 && upstreamError === QA_PERSISTENCE_UNAVAILABLE_MESSAGE) {
    return "La memoria persistente de QA no está preparada. Un administrador debe revisar las migraciones locales de QA antes de importar o recuperar conversaciones.";
  }

  const known: Record<number, string> = {
    400: "Revisa la URL del repositorio.",
    401: "Tu sesión ya no es válida. Inicia sesión de nuevo.",
    403: "No tienes permiso para importar en este proyecto.",
    404: "No se encontró el proyecto o el repositorio público.",
    409: "Ese origen no está disponible para este proyecto.",
    422: "El repositorio no cumple los límites o las reglas de importación segura.",
    429: "GitHub limitó temporalmente las solicitudes. Espera antes de iniciar un nuevo análisis.",
    502: "GitHub devolvió una respuesta no válida para el análisis.",
    503: "El servicio de importación no está disponible temporalmente.",
    504: "La importación tardó demasiado. Puedes intentarlo de nuevo.",
  };
  return known[status] ?? "No se pudo completar el análisis.";
}
