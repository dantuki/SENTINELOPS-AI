import { getAiServiceAuthHeaders } from "./ai-service-auth.js";
import type {
  CodeIntelligenceSourceFile,
  QaCodeRelation,
  QaCodeSymbol,
  QaConstructCounts,
  QaMetricPrecision,
  QaPythonAstFileMetrics,
} from "./code-intelligence.js";

const MAX_FILES_PER_REQUEST = 64;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;

export interface PythonAstClientOptions {
  aiOrchestratorUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetricPrecision(value: unknown): value is QaMetricPrecision {
  return value === "exact_under_model" || value === "approximate" || value === "unknown" || value === "not_applicable";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function parseConstructCounts(value: unknown): QaConstructCounts | null {
  if (!isRecord(value)) return null;
  const keys = [
    "if", "for", "asyncFor", "while", "try", "except", "with",
    "asyncWith", "return", "raise", "lambda", "decorator",
  ] as const;
  if (!keys.every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return null;
  return {
    if: value.if as number,
    for: value.for as number,
    asyncFor: value.asyncFor as number,
    while: value.while as number,
    try: value.try as number,
    except: value.except as number,
    with: value.with as number,
    asyncWith: value.asyncWith as number,
    return: value.return as number,
    raise: value.raise as number,
    lambda: value.lambda as number,
    decorator: value.decorator as number,
  };
}

function parseSymbol(value: unknown): Omit<QaCodeSymbol, "exported"> | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" || typeof value.name !== "string" ||
    typeof value.qualifiedName !== "string" ||
    !["class", "function", "async_function"].includes(String(value.kind)) ||
    typeof value.startLine !== "number" || typeof value.endLine !== "number" ||
    !isNullableNumber(value.parameterCount) ||
    typeof value.decoratorCount !== "number" || !isNullableNumber(value.cyclomaticComplexity)
  ) return null;
  return {
    id: value.id,
    name: value.name,
    qualifiedName: value.qualifiedName,
    kind: value.kind as "class" | "function" | "async_function",
    startLine: value.startLine,
    endLine: value.endLine,
    parameterCount: value.parameterCount,
    decoratorCount: value.decoratorCount,
    cyclomaticComplexity: value.cyclomaticComplexity,
  };
}

function parseRelation(value: unknown): QaCodeRelation | null {
  if (!isRecord(value) ||
    !["calls", "declares", "exports", "imports", "from_imports"].includes(String(value.kind)) ||
    typeof value.from !== "string" || typeof value.to !== "string" ||
    typeof value.startLine !== "number" || typeof value.resolved !== "boolean" ||
    !["resolved", "partially_resolved", "unresolved"].includes(String(value.resolution)) ||
    value.resolved !== (value.resolution === "resolved")
  ) return null;
  let callSafety: QaCodeRelation["callSafety"];
  if ("callSafety" in value) {
    if (!isRecord(value.callSafety) || typeof value.callSafety.shellTrue !== "boolean" || typeof value.callSafety.commandIsConstant !== "boolean") return null;
    callSafety = {
      shellTrue: value.callSafety.shellTrue,
      commandIsConstant: value.callSafety.commandIsConstant,
    };
  }
  return {
    kind: value.kind as QaCodeRelation["kind"],
    from: value.from,
    to: value.to,
    startLine: value.startLine,
    resolved: value.resolved,
    resolution: value.resolution as QaCodeRelation["resolution"],
    ...(callSafety ? { callSafety } : {}),
  };
}

function parseFile(value: unknown): QaPythonAstFileMetrics | null {
  if (!isRecord(value) || !isRecord(value.metricPrecision) || !isRecord(value.constructCounts)) return null;
  const metricPrecision = value.metricPrecision;
  const constructCounts = parseConstructCounts(value.constructCounts);
  if (
    typeof value.path !== "string" || typeof value.contentSha256 !== "string" ||
    value.language !== "python" || !["parsed", "syntax_error"].includes(String(value.status)) ||
    typeof value.physicalLines !== "number" || !isNullableNumber(value.codeLines) ||
    !isNullableNumber(value.cyclomaticComplexity) || !isNullableNumber(value.maxNesting) ||
    typeof value.parseDiagnostics !== "number" || typeof value.truncated !== "boolean" ||
    !["physicalLines", "codeLines", "cyclomaticComplexity", "maxNesting"].every((key) => isMetricPrecision(metricPrecision[key])) ||
    !constructCounts || !Array.isArray(value.symbols) || !Array.isArray(value.relations)
  ) return null;
  const symbols = value.symbols.map(parseSymbol);
  const relations = value.relations.map(parseRelation);
  if (symbols.some((symbol) => symbol === null) || relations.some((relation) => relation === null)) return null;
  return {
    path: value.path,
    contentSha256: value.contentSha256,
    language: "python",
    status: value.status as "parsed" | "syntax_error",
    physicalLines: value.physicalLines,
    codeLines: value.codeLines,
    cyclomaticComplexity: value.cyclomaticComplexity,
    maxNesting: value.maxNesting,
    metricPrecision: {
      physicalLines: metricPrecision.physicalLines as QaMetricPrecision,
      codeLines: metricPrecision.codeLines as QaMetricPrecision,
      cyclomaticComplexity: metricPrecision.cyclomaticComplexity as QaMetricPrecision,
      maxNesting: metricPrecision.maxNesting as QaMetricPrecision,
    },
    parseDiagnostics: value.parseDiagnostics,
    constructCounts,
    symbols: symbols as Array<Omit<QaCodeSymbol, "exported">>,
    relations: relations as QaCodeRelation[],
    truncated: value.truncated,
  };
}

function batches(files: readonly CodeIntelligenceSourceFile[]): CodeIntelligenceSourceFile[][] {
  const result: CodeIntelligenceSourceFile[][] = [];
  let batch: CodeIntelligenceSourceFile[] = [];
  let bytes = 0;
  for (const file of files) {
    if (file.byteLength > MAX_FILE_BYTES) continue;
    if (batch.length === MAX_FILES_PER_REQUEST || bytes + file.byteLength > MAX_TOTAL_BYTES) {
      if (batch.length > 0) result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.byteLength;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

/**
 * Calls a separately authenticated structural parser. Failure is deliberately
 * non-fatal: the QA report marks Python files unavailable rather than claiming
 * they were parsed. This endpoint does not depend on an Ollama model.
 */
export async function requestPythonAstMetrics(
  files: readonly CodeIntelligenceSourceFile[],
  options: PythonAstClientOptions = {},
): Promise<QaPythonAstFileMetrics[]> {
  const pythonFiles = files.filter((file) => /\.py$/iu.test(file.path));
  if (pythonFiles.length === 0) return [];
  const baseUrl = options.aiOrchestratorUrl ?? process.env.AI_ORCHESTRATOR_URL ?? "http://127.0.0.1:8000";
  let endpoint: URL;
  try {
    const base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol)) return [];
    endpoint = new URL("/code-intelligence/python", base);
  } catch {
    return [];
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return [];
  const output: QaPythonAstFileMetrics[] = [];
  for (const batch of batches(pythonFiles)) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...getAiServiceAuthHeaders(),
        },
        body: JSON.stringify({ files: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      continue;
    }
    if (!isRecord(payload) || payload.version !== "python-ast-v1" || !Array.isArray(payload.files)) continue;
    const requested = new Map(batch.map((file) => [file.path, file.contentSha256]));
    for (const candidate of payload.files) {
      const parsed = parseFile(candidate);
      if (parsed && requested.get(parsed.path) === parsed.contentSha256) output.push(parsed);
    }
  }
  return output;
}
