/**
 * SENTINELOPS AI - SINTETICO PARA DEMOSTRACION
 *
 * Este archivo representa un comportamiento hipotetico del sistema
 * de pedidos. No forma parte del codigo ejecutable de SentinelOps AI
 * ni de una aplicacion real en produccion.
 *
 * Objetivo: proporcionar evidencia para investigar la programacion
 * de multiples intentos concurrentes de una misma operacion.
 */

export type CreateOrderOperation = (
  requestId: string,
) => Promise<unknown>;

const MAX_PARALLEL_ATTEMPTS = 5;

/**
 * Programa cinco intentos de creacion de pedido simultaneamente.
 *
 * Observaciones:
 * - Los cinco intentos reciben el mismo requestId.
 * - Promise.all inicia las operaciones concurrentemente.
 * - Este fragmento no implementa espera entre intentos.
 * - Este fragmento no demuestra por si solo que se haya producido
 *   saturacion de conexiones en la base de datos.
 */
export async function dispatchOrderRetries(
  requestId: string,
  createOrder: CreateOrderOperation,
): Promise<unknown[]> {
  const attempts = Array.from(
    { length: MAX_PARALLEL_ATTEMPTS },
    () => createOrder(requestId),
  );

  return Promise.all(attempts);
}
