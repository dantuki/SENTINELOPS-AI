import { getAiServiceAuthHeaders } from "./ai-service-auth.js";

export const EMBEDDING_DIMENSIONS = 1024;

export interface EmbeddingClientOptions {
  aiOrchestratorUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type EmbeddingServiceResult =
  | {
      ok: true;
      model: string;
      vectors: number[][];
    }
  | {
      ok: false;
      kind: "unavailable" | "invalid" | "timeout";
    };

interface ParsedEmbeddingResponse {
  model: string;
  vectors: number[][];
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseEmbeddingResponse(
  value: unknown,
  expectedCount: number,
): ParsedEmbeddingResponse | null {
  if (
    !isRecord(value) ||
    typeof value.model !== "string" ||
    value.model.trim().length === 0 ||
    value.dimensions !== EMBEDDING_DIMENSIONS ||
    !Array.isArray(value.data) ||
    value.data.length !== expectedCount
  ) {
    return null;
  }

  const vectors: number[][] = [];

  for (let index = 0; index < expectedCount; index += 1) {
    const item: unknown = value.data[index];

    if (
      !isRecord(item) ||
      item.index !== index ||
      !Array.isArray(item.embedding) ||
      item.embedding.length !== EMBEDDING_DIMENSIONS
    ) {
      return null;
    }

    const vector: number[] = [];
    for (const coordinate of item.embedding) {
      if (
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate)
      ) {
        return null;
      }

      vector.push(coordinate);
    }

    vectors.push(vector);
  }

  return {
    model: value.model,
    vectors,
  };
}

export async function requestEmbeddings(
  texts: string[],
  options: EmbeddingClientOptions = {},
): Promise<EmbeddingServiceResult> {
  const baseUrl =
    options.aiOrchestratorUrl ??
    process.env.AI_ORCHESTRATOR_URL ??
    "http://127.0.0.1:8000";

  let endpoint: URL;

  try {
    const base = new URL(baseUrl);

    if (!["http:", "https:"].includes(base.protocol)) {
      return { ok: false, kind: "unavailable" };
    }

    endpoint = new URL("/embeddings", base);
  } catch {
    return { ok: false, kind: "unavailable" };
  }

  const timeoutMs = options.timeoutMs ?? 35_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, kind: "unavailable" };
  }

  let response: Response;

  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...getAiServiceAuthHeaders(),
      },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    return {
      ok: false,
      kind:
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
          ? "timeout"
          : "unavailable",
    };
  }

  if (response.status === 504) {
    return { ok: false, kind: "timeout" };
  }

  if (response.status === 502 || response.status === 422) {
    return { ok: false, kind: "invalid" };
  }

  if (!response.ok) {
    return { ok: false, kind: "unavailable" };
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return { ok: false, kind: "invalid" };
  }

  const parsed = parseEmbeddingResponse(payload, texts.length);

  if (parsed === null) {
    return { ok: false, kind: "invalid" };
  }

  return {
    ok: true,
    model: parsed.model,
    vectors: parsed.vectors,
  };
}
