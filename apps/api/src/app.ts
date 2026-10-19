
import Fastify, { type FastifyInstance } from "fastify";

export interface HealthResponse {
  status: "ok";
  service: "sentinelops-product-api";
}

export function buildApp(options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? process.env.NODE_ENV !== "test",
  });

  app.get<{ Reply: HealthResponse }>(
    "/health",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string", const: "ok" },
              service: {
                type: "string",
                const: "sentinelops-product-api",
              },
            },
            required: ["status", "service"],
            additionalProperties: false,
          },
        },
      },
    },
    async () => ({
      status: "ok",
      service: "sentinelops-product-api",
    }),
  );

  return app;
}
