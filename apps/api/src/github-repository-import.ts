import { createHash } from "node:crypto";

import type {
  QaInventoryCategory,
  QaRepositoryInventory,
  QaSourceFile,
} from "./qa-analysis.js";

export const DEFAULT_GITHUB_IMPORT_LIMITS = {
  maxTreeEntries: 2_000,
  maxFiles: 30,
  maxFileBytes: 64 * 1024,
  maxTotalBytes: 768 * 1024,
  maxJsonBytes: 2 * 1024 * 1024,
  timeoutMs: 12_000,
} as const;

export type GithubImportErrorCode =
  | "invalid_repository_url"
  | "repository_not_found"
  | "repository_not_public"
  | "github_unavailable"
  | "github_timeout"
  | "github_invalid_response"
  | "repository_limit_exceeded";

export class GithubImportError extends Error {
  constructor(public readonly code: GithubImportErrorCode) {
    super(code);
    this.name = "GithubImportError";
  }
}

export interface GithubRepositoryReference {
  owner: string;
  repository: string;
  canonicalUrl: string;
}

export interface GithubImportedRepository extends GithubRepositoryReference {
  defaultBranch: string;
  revision: string;
  files: QaSourceFile[];
  inventory: QaRepositoryInventory;
  skipped: {
    unsupported: number;
    tooLarge: number;
    invalidPath: number;
    limitReached: number;
  };
}

export type GithubImportProgressStage =
  | "fetching_repository_metadata"
  | "listing_repository_files"
  | "selecting_analysis_files"
  | "reading_manifest"
  | "reading_source"
  | "reading_tests"
  | "reading_documentation";

export interface GithubImportProgress {
  stage: GithubImportProgressStage;
  message: string;
  filePath?: string;
  processedFiles?: number;
  selectedFiles?: number;
}

interface GithubRepositoryMetadata {
  private: boolean;
  default_branch: string;
}

interface GithubTreeEntry {
  path: string;
  type: string;
  size?: number;
}

interface GithubTreeResponse {
  sha: string;
  truncated?: boolean;
  tree: GithubTreeEntry[];
}

interface GithubContentResponse {
  encoding: string;
  content: string;
}

type GithubFetch = typeof fetch;

const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/u;
const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".cts", ".html", ".js", ".json", ".jsx", ".md",
  ".mjs", ".mts", ".py", ".ts", ".tsx", ".yaml", ".yml",
]);
const EXCLUDED_DIRECTORY = new Set([
  ".git", ".next", "build", "coverage", "dist", "node_modules", "vendor",
]);
const CATEGORY_BUDGETS: Record<QaInventoryCategory, number> = {
  manifest: 4,
  test_configuration: 4,
  test: 8,
  source: 10,
  documentation: 4,
  other: 0,
};
const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg",
  "pytest.ini", "tox.ini", "pom.xml", "build.gradle", "cargo.toml", "go.mod",
]);

function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasExpectedKeys<T extends string>(
  value: unknown,
  keys: readonly T[],
): value is Record<T, unknown> {
  return isRecord(value) && keys.every((key) => key in value);
}

function isSafePath(value: string): boolean {
  if (!value || value.length > 512 || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isSupportedTextPath(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  if (segments.some((segment) => EXCLUDED_DIRECTORY.has(segment))) return false;
  const fileName = segments.at(-1) ?? "";
  if (fileName === "package.json" || fileName === "tsconfig.json") return true;
  const extension = fileName.includes(".") ? `.${fileName.split(".").at(-1)}` : "";
  return TEXT_EXTENSIONS.has(extension);
}

function isTestPath(path: string): boolean {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";
  return (
    segments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__") ||
    /(?:^|[._-])(?:test|spec)(?:[._-]|$)/u.test(fileName) ||
    /^test_.+\.(?:[cm]?[jt]sx?|py)$/u.test(fileName) ||
    /_test\.py$/u.test(fileName)
  );
}

function categoryForPath(path: string): QaInventoryCategory {
  const normalized = path.toLowerCase();
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";
  if (MANIFEST_NAMES.has(fileName)) return "manifest";
  if (isTestPath(path)) return "test";
  if (
    normalized.startsWith(".github/workflows/") ||
    /(?:^|\/)(?:jest|vitest|mocha|ava|playwright|cypress|eslint|prettier|tsconfig)(?:\.|$)/u.test(normalized) ||
    fileName.startsWith(".eslintrc")
  ) return "test_configuration";
  if (fileName === "readme.md" || normalized.startsWith("docs/")) return "documentation";
  if (segments.some((segment) => ["src", "lib", "app", "server"].includes(segment))) return "source";
  return "other";
}

function categoryPriority(path: string): number {
  const normalized = path.toLowerCase();
  if (normalized === "package.json" || normalized === "pyproject.toml") return 0;
  if (normalized === "readme.md") return 0;
  if (normalized.startsWith(".github/workflows/")) return 0;
  return normalized.split("/").length;
}

function compareCandidates(left: GithubTreeEntry, right: GithubTreeEntry): number {
  const priority = categoryPriority(left.path) - categoryPriority(right.path);
  return priority === 0 ? comparePaths(left.path, right.path) : priority;
}

async function readResponseTextAtMost(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const advertisedLength = response.headers.get("content-length");
  if (advertisedLength && Number(advertisedLength) > maximumBytes) {
    throw new GithubImportError("repository_limit_exceeded");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) {
      throw new GithubImportError("repository_limit_exceeded");
    }
    return text;
  }

  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new GithubImportError("repository_limit_exceeded");
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

async function githubJson(
  fetchImpl: GithubFetch,
  url: URL,
  maximumBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ status: number; payload: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "SentinelOps-QA-Importer",
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error: unknown) {
    if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
      throw new GithubImportError("github_timeout");
    }
    throw new GithubImportError("github_unavailable");
  }

  if (response.status === 404) {
    throw new GithubImportError("repository_not_found");
  }
  if (!response.ok) {
    throw new GithubImportError("github_unavailable");
  }
  try {
    return { status: response.status, payload: JSON.parse(await readResponseTextAtMost(response, maximumBytes)) };
  } catch (error: unknown) {
    if (error instanceof GithubImportError) throw error;
    throw new GithubImportError("github_invalid_response");
  }
}

function decodeContent(value: GithubContentResponse, maximumBytes: number): string {
  if (value.encoding !== "base64" || typeof value.content !== "string") {
    throw new GithubImportError("github_invalid_response");
  }
  const compact = value.content.replace(/\s/gu, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)) {
    throw new GithubImportError("github_invalid_response");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.byteLength > maximumBytes) {
    throw new GithubImportError("repository_limit_exceeded");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GithubImportError("github_invalid_response");
  }
}

export function parseGithubRepositoryUrl(input: string): GithubRepositoryReference {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new GithubImportError("invalid_repository_url");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new GithubImportError("invalid_repository_url");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) throw new GithubImportError("invalid_repository_url");
  const [owner, repositoryWithSuffix] = segments;
  const repository = repositoryWithSuffix?.endsWith(".git")
    ? repositoryWithSuffix.slice(0, -4)
    : repositoryWithSuffix;
  if (!owner || !repository || !GITHUB_NAME.test(owner) || !GITHUB_NAME.test(repository)) {
    throw new GithubImportError("invalid_repository_url");
  }
  return { owner, repository, canonicalUrl: `https://github.com/${owner}/${repository}` };
}

/** Downloads a bounded text-only inventory through GitHub's public REST API. */
export async function importPublicGithubRepository(
  repositoryUrl: string,
  options: {
    fetchImpl?: GithubFetch;
    limits?: Partial<typeof DEFAULT_GITHUB_IMPORT_LIMITS>;
    signal?: AbortSignal;
    onProgress?: (progress: GithubImportProgress) => void | Promise<void>;
  } = {},
): Promise<GithubImportedRepository> {
  const reference = parseGithubRepositoryUrl(repositoryUrl);
  const limits = { ...DEFAULT_GITHUB_IMPORT_LIMITS, ...options.limits };
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = new URL("https://api.github.com/");
  const repositoryPath = `repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repository)}`;
  const reportProgress = async (progress: GithubImportProgress): Promise<void> => {
    await options.onProgress?.(progress);
  };

  await reportProgress({
    stage: "fetching_repository_metadata",
    message: "Consultando los metadatos públicos del repositorio.",
  });
  const metadataResponse = await githubJson(
    fetchImpl,
    new URL(repositoryPath, apiBase),
    limits.maxJsonBytes,
    limits.timeoutMs,
    options.signal,
  );
  if (!hasExpectedKeys(metadataResponse.payload, ["private", "default_branch"])) {
    throw new GithubImportError("github_invalid_response");
  }
  const metadata = metadataResponse.payload as GithubRepositoryMetadata;
  if (metadata.private !== false) throw new GithubImportError("repository_not_public");
  if (typeof metadata.default_branch !== "string" || !metadata.default_branch.trim()) {
    throw new GithubImportError("github_invalid_response");
  }

  await reportProgress({
    stage: "listing_repository_files",
    message: "Obteniendo el inventario de archivos del repositorio.",
  });
  const treeResponse = await githubJson(
    fetchImpl,
    new URL(`${repositoryPath}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`, apiBase),
    limits.maxJsonBytes,
    limits.timeoutMs,
    options.signal,
  );
  if (!hasExpectedKeys(treeResponse.payload, ["sha", "tree"])) {
    throw new GithubImportError("github_invalid_response");
  }
  const tree = treeResponse.payload as GithubTreeResponse;
  if (
    typeof tree.sha !== "string" ||
    !Array.isArray(tree.tree) ||
    tree.truncated === true ||
    tree.tree.length > limits.maxTreeEntries
  ) {
    throw new GithubImportError("repository_limit_exceeded");
  }

  const skipped = { unsupported: 0, tooLarge: 0, invalidPath: 0, limitReached: 0 };
  const candidates = new Map<QaInventoryCategory, GithubTreeEntry[]>();
  const discoveredByCategory: Record<QaInventoryCategory, number> = {
    manifest: 0, test_configuration: 0, source: 0, test: 0, documentation: 0, other: 0,
  };
  for (const entry of tree.tree) {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.type !== "string") {
      skipped.invalidPath += 1;
      continue;
    }
    if (!isSafePath(entry.path)) {
      skipped.invalidPath += 1;
      continue;
    }
    if (entry.type !== "blob") {
      skipped.unsupported += 1;
      continue;
    }
    const category = categoryForPath(entry.path);
    discoveredByCategory[category] += 1;
    if (!isSupportedTextPath(entry.path)) {
      skipped.unsupported += 1;
      continue;
    }
    if (typeof entry.size !== "number" || entry.size < 0 || entry.size > limits.maxFileBytes) {
      skipped.tooLarge += 1;
      continue;
    }
    const group = candidates.get(category) ?? [];
    group.push(entry as GithubTreeEntry);
    candidates.set(category, group);
  }

  await reportProgress({
    stage: "selecting_analysis_files",
    message: "Seleccionando archivos dentro de los límites de inspección.",
  });

  const files: QaSourceFile[] = [];
  const selectedByCategory: Record<QaInventoryCategory, number> = {
    manifest: 0, test_configuration: 0, source: 0, test: 0, documentation: 0, other: 0,
  };
  let totalBytes = 0;
  for (const category of Object.keys(CATEGORY_BUDGETS) as QaInventoryCategory[]) {
    const entries = (candidates.get(category) ?? []).sort(compareCandidates);
    for (const entry of entries) {
      if (
        selectedByCategory[category] >= CATEGORY_BUDGETS[category] ||
        files.length >= limits.maxFiles ||
        totalBytes + (entry.size ?? 0) > limits.maxTotalBytes
      ) {
        skipped.limitReached += 1;
        continue;
      }
      const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
      const contentUrl = new URL(`${repositoryPath}/contents/${encodedPath}`, apiBase);
      contentUrl.searchParams.set("ref", tree.sha);
      const stageByCategory: Record<QaInventoryCategory, GithubImportProgressStage> = {
        manifest: "reading_manifest",
        test_configuration: "reading_tests",
        test: "reading_tests",
        source: "reading_source",
        documentation: "reading_documentation",
        other: "reading_source",
      };
      await reportProgress({
        stage: stageByCategory[category],
        message: `Leyendo ${entry.path}.`,
        filePath: entry.path,
        processedFiles: files.length,
      });
      const contentResponse = await githubJson(
        fetchImpl,
        contentUrl,
        Math.min(limits.maxJsonBytes, limits.maxFileBytes * 3),
        limits.timeoutMs,
        options.signal,
      );
      if (!hasExpectedKeys(contentResponse.payload, ["encoding", "content"])) {
        throw new GithubImportError("github_invalid_response");
      }
      const content = decodeContent(contentResponse.payload as GithubContentResponse, limits.maxFileBytes);
      const byteLength = Buffer.byteLength(content, "utf8");
      if (totalBytes + byteLength > limits.maxTotalBytes) {
        skipped.limitReached += 1;
        continue;
      }
      totalBytes += byteLength;
      selectedByCategory[category] += 1;
      files.push({ path: entry.path, content, byteLength, contentSha256: contentHash(content) });
    }
  }

  const inventory: QaRepositoryInventory = {
    selectionStrategy: "category_priority_v1",
    discoveredFiles: Object.values(discoveredByCategory).reduce((total, value) => total + value, 0),
    selectedFiles: files.length,
    categories: (Object.keys(CATEGORY_BUDGETS) as QaInventoryCategory[]).map((category) => ({
      category,
      discovered: discoveredByCategory[category],
      selected: selectedByCategory[category],
    })),
    testFiles: {
      discovered: discoveredByCategory.test,
      selected: selectedByCategory.test,
    },
  };

  return {
    ...reference,
    defaultBranch: metadata.default_branch,
    revision: tree.sha,
    files,
    inventory,
    skipped,
  };
}
