/**
 * Maps responses already received from the investigation API to messages
 * appropriate for the product UI. Network failures are handled separately so
 * a server-side 503 is never presented as a client connectivity failure.
 */
export function messageForInvestigationStatus(status: number): string {
  switch (status) {
    case 400:
      return "Revisa los datos de la solicitud e inténtalo de nuevo.";
    case 401:
      return "Tu sesión ya no es válida. Inicia sesión de nuevo para continuar.";
    case 403:
      return "No tienes permiso para investigar este proyecto.";
    case 404:
      return "El recurso seleccionado ya no está disponible.";
    case 422:
      return "La solicitud no pasó la validación del servicio.";
    case 502:
      return "El servicio devolvió una respuesta no válida.";
    case 503:
      return "El servicio de investigación no está disponible temporalmente. Verifica las dependencias locales e inténtalo de nuevo.";
    case 504:
      return "La investigación tardó demasiado. Puedes reintentarlo.";
    default:
      return "La solicitud no pudo completarse. Inténtalo de nuevo.";
  }
}
