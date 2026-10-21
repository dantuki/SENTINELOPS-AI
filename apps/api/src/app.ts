
import Fastify, { type FastifyInstance } from "fastify";

export interface HealthResponse {
  status: "ok";
  service: "sentinelops-product-api";
}

interface AiDependencyResponse {
  status: "ok";
  service: "sentinelops-product-api";
  dependency: {
    name: "sentinelops-ai-orchestrator";
    status: "ok";
  };
}

interface AiDependencyErrorResponse {
  status: "error";
  service: "sentinelops-product-api";
  dependency: {
    name: "sentinelops-ai-orchestrator";
    status: "unavailable";
  };
  message: "AI orchestrator unavailable";
}

interface BuildAppOptions {
  logger?: boolean;
  aiOrchestratorUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const aiDependencySchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "ok" },
    service: { type: "string", const: "sentinelops-product-api" },
    dependency: {
      type: "object",
      properties: {
        name: {
          type: "string",
          const: "sentinelops-ai-orchestrator",
        },
        status: { type: "string", const: "ok" },
      },
      required: ["name", "status"],
      additionalProperties: false,
    },
  },
  required: ["status", "service", "dependency"],
  additionalProperties: false,
} as const;

const aiDependencyErrorSchema = {
  type: "object",
  properties: {
    status: { type: "string", const: "error" },
    service: { type: "string", const: "sentinelops-product-api" },
    dependency: {
      type: "object",
      properties: {
        name: {
          type: "string",
          const: "sentinelops-ai-orchestrator",
        },
        status: { type: "string", const: "unavailable" },
      },
      required: ["name", "status"],
      additionalProperties: false,
    },
    message: {
      type: "string",
      const: "AI orchestrator unavailable",
    },
  },
  required: ["status", "service", "dependency", "message"],
  additionalProperties: false,
} as const;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? process.env.NODE_ENV !== "test",
  });

  const aiOrchestratorUrl =
    options.aiOrchestratorUrl ??
    process.env.AI_ORCHESTRATOR_URL ??
    "http://127.0.0.1:8000";

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;

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

  app.get<{
    Reply: AiDependencyResponse | AiDependencyErrorResponse;
  }>(
    "/health/dependencies/ai",
    {
      schema: {
        response: {
          200: aiDependencySchema,
          503: aiDependencyErrorSchema,
        },
      },
    },
    async (_request, reply) => {
      const unavailable: AiDependencyErrorResponse = {
        status: "error",
        service: "sentinelops-product-api",
        dependency: {
          name: "sentinelops-ai-orchestrator",
          status: "unavailable",
        },
        message: "AI orchestrator unavailable",
      };

      let healthUrl: URL;

      try {
        const baseUrl = new URL(aiOrchestratorUrl);

        if (!["http:", "https:"].includes(baseUrl.protocol)) {
          return reply.code(503).send(unavailable);
        }

        healthUrl = new URL("/health", baseUrl);
      } catch {
        return reply.code(503).send(unavailable);
      }

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return reply.code(503).send(unavailable);
      }

      try {
        const response = await fetchImpl(healthUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          return reply.code(503).send(unavailable);
        }

        const payload: unknown = await response.json();

        if (
          typeof payload !== "object" ||
          payload === null ||
          !("status" in payload) ||
          !("service" in payload) ||
          payload.status !== "ok" ||
          payload.service !== "sentinelops-ai-orchestrator"
        ) {
          return reply.code(503).send(unavailable);
        }

        const result: AiDependencyResponse = {
          status: "ok",
          service: "sentinelops-product-api",
          dependency: {
            name: "sentinelops-ai-orchestrator",
            status: "ok",
          },
        };

        return reply.code(200).send(result);
      } catch {
        return reply.code(503).send(unavailable);
      }
    },
  );

  return app;
}
