import type { FastifyInstance } from "fastify";

interface ChatRequestBody {
  prompt: string;
}

interface ChatResponseBody {
  model: string;
  response: string;
}

interface ApiError {
  error: string;
}

interface ChatRouteOptions {
  aiOrchestratorUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const chatRequestSchema = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 20000,
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

const chatResponseSchema = {
  type: "object",
  properties: {
    model: { type: "string" },
    response: { type: "string" },
  },
  required: ["model", "response"],
  additionalProperties: false,
} as const;

const apiErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
  required: ["error"],
  additionalProperties: false,
} as const;

export function registerChatRoutes(
  app: FastifyInstance,
  options: ChatRouteOptions = {},
): void {
  const aiOrchestratorUrl =
    options.aiOrchestratorUrl ??
    process.env.AI_ORCHESTRATOR_URL ??
    "http://127.0.0.1:8000";

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 90_000;

  app.post<{
    Body: ChatRequestBody;
    Reply: ChatResponseBody | ApiError;
  }>(
    "/api/chat",
    {
      schema: {
        body: chatRequestSchema,
        response: {
          200: chatResponseSchema,
          400: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
          504: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      if (!request.body.prompt.trim()) {
        return reply.code(400).send({
          error: "Prompt must not be empty",
        });
      }

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return reply.code(503).send({
          error: "AI service unavailable",
        });
      }

      let chatUrl: URL;

      try {
        const baseUrl = new URL(aiOrchestratorUrl);

        if (!["http:", "https:"].includes(baseUrl.protocol)) {
          return reply.code(503).send({
            error: "AI service unavailable",
          });
        }

        chatUrl = new URL("/chat", baseUrl);
      } catch {
        return reply.code(503).send({
          error: "AI service unavailable",
        });
      }

      try {
        const upstream = await fetchImpl(chatUrl, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            prompt: request.body.prompt,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!upstream.ok) {
          return reply.code(503).send({
            error: "AI service unavailable",
          });
        }

        let payload: unknown;

        try {
          payload = await upstream.json();
        } catch {
          return reply.code(502).send({
            error: "Invalid AI model response",
          });
        }

        if (typeof payload !== "object" || payload === null) {
          return reply.code(502).send({
            error: "Invalid AI model response",
          });
        }

        const result = payload as {
          model?: unknown;
          response?: unknown;
        };

        if (
          typeof result.model !== "string" ||
          !result.model.trim() ||
          typeof result.response !== "string" ||
          !result.response.trim()
        ) {
          return reply.code(502).send({
            error: "Invalid AI model response",
          });
        }

        return reply.code(200).send({
          model: result.model,
          response: result.response.trim(),
        });
      } catch (error: unknown) {
        if (
          error instanceof Error &&
          ["TimeoutError", "AbortError"].includes(error.name)
        ) {
          return reply.code(504).send({
            error: "AI model timed out",
          });
        }

        return reply.code(503).send({
          error: "AI service unavailable",
        });
      }
    },
  );
}