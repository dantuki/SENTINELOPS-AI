/**
 * Controlled local-model capability benchmark.
 *
 * This uses the ALT-002 fixture below, not INC-001 inputs or ground truth.
 * It is intentionally executable outside the evaluator so a model comparison
 * cannot change, or derive a result from, the incident acceptance criteria.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Json = Record<string, unknown>;

type OllamaResponse = Json & {
  model?: string;
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
};

const models = ["qwen3.5:4b", "qwen3:8b"] as const;
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const numCtx = Number.parseInt(process.env.MODEL_BENCH_NUM_CTX ?? "4096", 10);
const numPredict = Number.parseInt(process.env.MODEL_BENCH_NUM_PREDICT ?? "1536", 10);
const requestTimeoutMs = Number.parseInt(process.env.MODEL_BENCH_TIMEOUT_MS ?? "300000", 10);

if (!Number.isInteger(numCtx) || numCtx < 1024 || !Number.isInteger(numPredict) || numPredict < 64) {
  throw new Error("MODEL_BENCH_NUM_CTX and MODEL_BENCH_NUM_PREDICT must be sensible integers.");
}

const evidence = [
  {
    ref: "ALT-002/E1",
    event_id: "evt-pool-17",
    observed_at: "2026-10-10T14:00:00Z",
    source: "metrics/postgres-pool",
    observed: "auth-api had 12 active connections, 0 idle connections, and p95 checkout latency of 180 ms.",
  },
  {
    ref: "ALT-002/E2",
    event_id: "evt-http-18",
    observed_at: "2026-10-10T14:00:05Z",
    source: "logs/auth-api",
    observed: "POST /sessions returned HTTP 503 for request auth-9.",
  },
  {
    ref: "ALT-002/E3",
    event_id: "evt-queue-19",
    observed_at: "2026-10-10T14:00:10Z",
    source: "metrics/retry-queue",
    observed: "retry queue depth was 42; retries started in the previous minute were 0.",
  },
] as const;

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "facts", "hypotheses"],
  properties: {
    summary: { type: "string" },
    facts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event_id", "claim", "references"],
        properties: {
          event_id: { type: "string", enum: evidence.map((item) => item.event_id) },
          claim: { type: "string" },
          references: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: evidence.map((item) => item.ref) },
          },
        },
      },
    },
    hypotheses: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "status", "references"],
        properties: {
          statement: { type: "string" },
          status: { type: "string", enum: ["unverified", "insufficient_evidence"] },
          references: {
            type: "array",
            items: { type: "string", enum: evidence.map((item) => item.ref) },
          },
        },
      },
    },
  },
} as const;

const prompt = `You are assessing controlled synthetic incident ALT-002. Return ONLY a JSON object that validates against the supplied schema.\n\nRules:\n- Facts are observed facts, one fact per event. Preserve every number, zero, unit, endpoint, HTTP status, request id, and event identity exactly.\n- Cite only the reference belonging to that event. Do not cite a source that does not support the claim.\n- Include exactly one possible connection between the pool state and the HTTP 503 only as a hypothesis, marked unverified or insufficient_evidence. It must not be written as a confirmed cause.\n- Do not state or imply a confirmed cause/root cause. Do not invent logs, metrics, events, remediation, or outcomes.\n- A zero is an observed value, not missing data.\n\nEvidence:\n${JSON.stringify(evidence, null, 2)}`;

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(object).filter((item): item is Json => item !== null) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function containsAll(text: string, fragments: string[]): boolean {
  const lower = text.toLowerCase();
  return fragments.every((fragment) => lower.includes(fragment.toLowerCase()));
}

function evaluate(content: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      jsonValid: false,
      valuesAndUnitsPreserved: false,
      zeroPreserved: false,
      eventIdentityPreserved: false,
      citationsCorrect: false,
      claimSupport: false,
      causalClaimsUnproven: false,
      hypothesesSeparated: false,
      omissions: ["response is not valid JSON"],
    };
  }

  const answer = object(parsed);
  if (!answer) return { jsonValid: false, omissions: ["response is not an object"] };
  const facts = records(answer.facts);
  const hypotheses = records(answer.hypotheses);
  const schemaConforms = typeof answer.summary === "string"
    && facts.length === 3
    && facts.every((fact) => typeof fact.event_id === "string"
      && typeof fact.claim === "string"
      && strings(fact.references).length > 0)
    && hypotheses.length === 1
    && hypotheses.every((hypothesis) => typeof hypothesis.statement === "string"
      && ["unverified", "insufficient_evidence"].includes(string(hypothesis.status) ?? "")
      && Array.isArray(hypothesis.references));
  const claims = facts.map((fact) => string(fact.claim) ?? "");
  const allFactText = claims.join(" ");
  const byEvent = new Map(facts.map((fact) => [string(fact.event_id), fact]));
  const expected = ["evt-pool-17", "evt-http-18", "evt-queue-19"];
  const expectedRefs = new Map([["evt-pool-17", "ALT-002/E1"], ["evt-http-18", "ALT-002/E2"], ["evt-queue-19", "ALT-002/E3"]]);
  const identity = facts.length === 3 && expected.every((id) => byEvent.has(id));
  const citationsCorrect = identity && expected.every((id) => {
    const fact = byEvent.get(id);
    return fact !== undefined && strings(fact.references).length > 0 && strings(fact.references).every((ref) => ref === expectedRefs.get(id));
  });
  const valuesAndUnitsPreserved = containsAll(allFactText, ["12", "0", "180", "503", "/sessions", "auth-9", "42"])
    && /(?:\bms\b|milisegundos|milliseconds)/i.test(allFactText);
  const zeroPreserved = /(?:^|\D)0(?:\D|$)/.test(allFactText);
  const causalPattern = /\b(root cause|causa ra[ií]z|caused|caus[óo]|provoc[óo]|demuestra que .* caus)/i;
  const observedText = `${string(answer.summary) ?? ""} ${allFactText}`;
  const hypothesesSeparated = hypotheses.length === 1
    && hypotheses.every((hypothesis) => ["unverified", "insufficient_evidence"].includes(string(hypothesis.status) ?? ""));
  const causalClaimsUnproven = !causalPattern.test(observedText) && hypothesesSeparated;
  const omissions: string[] = [];
  if (!identity) omissions.push("one or more required events are missing or merged");
  if (!valuesAndUnitsPreserved) omissions.push("one or more controlled values, units, or identifiers are omitted");
  if (!zeroPreserved) omissions.push("observed zero is omitted");
  if (!citationsCorrect) omissions.push("one or more event references are invalid");
  if (!hypothesesSeparated) omissions.push("hypothesis status is invalid");
  if (!causalClaimsUnproven) omissions.push("causal language appears outside an explicitly unconfirmed hypothesis");
  return {
    jsonValid: schemaConforms,
    jsonSchemaConforms: schemaConforms,
    valuesAndUnitsPreserved,
    zeroPreserved,
    eventIdentityPreserved: identity,
    citationsCorrect,
    claimSupport: identity && valuesAndUnitsPreserved && citationsCorrect,
    causalClaimsUnproven,
    hypothesesSeparated,
    omissions,
  };
}

async function activeModels(): Promise<unknown> {
  try {
    const response = await fetch(`${baseUrl}/api/ps`);
    return response.ok ? await response.json() : { status: response.status };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function run(model: string): Promise<Json> {
  const started = performance.now();
  const before = await activeModels();
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs),
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: schema,
        options: { num_ctx: numCtx, num_predict: numPredict, temperature: 0.1 },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const payload = await response.json() as OllamaResponse;
    const raw = payload.message?.content ?? "";
    return {
      model,
      request: { numCtx, numPredict, temperature: 0.1, think: false, schema: "ALT-002 controlled schema" },
      httpStatus: response.status,
      latencyMs: Math.round(performance.now() - started),
      before,
      after: await activeModels(),
      ollama: {
        returnedModel: payload.model ?? null,
        done: payload.done ?? null,
        doneReason: payload.done_reason ?? null,
        totalDurationMs: payload.total_duration ? Math.round(payload.total_duration / 1_000_000) : null,
        loadDurationMs: payload.load_duration ? Math.round(payload.load_duration / 1_000_000) : null,
        promptEvalDurationMs: payload.prompt_eval_duration ? Math.round(payload.prompt_eval_duration / 1_000_000) : null,
        evalDurationMs: payload.eval_duration ? Math.round(payload.eval_duration / 1_000_000) : null,
        promptEvalCount: payload.prompt_eval_count ?? null,
        evalCount: payload.eval_count ?? null,
      },
      evaluation: evaluate(raw),
      response: raw,
    };
  } catch (error) {
    return {
      model,
      request: { numCtx, numPredict, temperature: 0.1, think: false },
      latencyMs: Math.round(performance.now() - started),
      before,
      after: await activeModels(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const recomputeIndex = process.argv.indexOf("--recompute");
  if (recomputeIndex !== -1) {
    const sourcePath = process.argv[recomputeIndex + 1];
    if (!sourcePath) throw new Error("--recompute requires a benchmark.json path.");
    const source = object(JSON.parse(await readFile(sourcePath, "utf8")));
    const sourceResults = source ? records(source.results) : [];
    const recomputed = {
      benchmark: "ALT-002 deterministic metric recomputation",
      generatedAt: new Date().toISOString(),
      sourceReport: sourcePath,
      method: "Re-evaluates saved raw model responses without sending an Ollama request.",
      results: sourceResults.map((result) => ({
        model: string(result.model),
        evaluation: evaluate(string(result.response) ?? ""),
      })),
    };
    const outputPath = join(dirname(sourcePath), "benchmark.recomputed.json");
    await writeFile(outputPath, `${JSON.stringify(recomputed, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ outputPath, results: recomputed.results }, null, 2));
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = {
    benchmark: "ALT-002 controlled model-capability benchmark",
    generatedAt: new Date().toISOString(),
    scope: "Independent of INC-001; no INC-001 source or ground truth is read.",
    endpoint: baseUrl,
    configuration: { numCtx, numPredict, temperature: 0.1, think: false, requestTimeoutMs },
    evidence,
    results: await Promise.all(models.map(run)),
  };
  const reportDirectory = join(process.cwd(), "reports", "model-capability", timestamp);
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = join(reportDirectory, "benchmark.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ reportPath, results: report.results.map((result) => ({ model: result.model, latencyMs: result.latencyMs, evaluation: result.evaluation, error: result.error ?? null })) }, null, 2));
}

await main();
