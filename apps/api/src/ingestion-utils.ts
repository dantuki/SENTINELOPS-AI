export const MAX_INGESTION_FILE_BYTES = 200_000;
export const MAX_INGESTION_FILE_CHARS = 180_000;

const TEXT_FILE_TYPES: Record<
  string,
  { mediaType: string; strategy: "lines" | "markdown" | "code" | "text" }
> = {
  ".bash": { mediaType: "text/x-shellscript", strategy: "code" },
  ".c": { mediaType: "text/x-c", strategy: "code" },
  ".cc": { mediaType: "text/x-c++", strategy: "code" },
  ".cpp": { mediaType: "text/x-c++", strategy: "code" },
  ".cs": { mediaType: "text/x-csharp", strategy: "code" },
  ".css": { mediaType: "text/css", strategy: "code" },
  ".csv": { mediaType: "text/csv", strategy: "lines" },
  ".go": { mediaType: "text/x-go", strategy: "code" },
  ".graphql": { mediaType: "application/graphql", strategy: "code" },
  ".h": { mediaType: "text/x-c", strategy: "code" },
  ".hpp": { mediaType: "text/x-c++", strategy: "code" },
  ".html": { mediaType: "text/html", strategy: "code" },
  ".ini": { mediaType: "text/plain", strategy: "text" },
  ".java": { mediaType: "text/x-java-source", strategy: "code" },
  ".js": { mediaType: "text/javascript", strategy: "code" },
  ".json": { mediaType: "application/json", strategy: "lines" },
  ".jsonl": { mediaType: "application/x-ndjson", strategy: "lines" },
  ".jsx": { mediaType: "text/javascript", strategy: "code" },
  ".kt": { mediaType: "text/x-kotlin", strategy: "code" },
  ".log": { mediaType: "text/plain", strategy: "lines" },
  ".md": { mediaType: "text/markdown", strategy: "markdown" },
  ".php": { mediaType: "text/x-php", strategy: "code" },
  ".proto": { mediaType: "text/plain", strategy: "code" },
  ".ps1": { mediaType: "text/plain", strategy: "code" },
  ".py": { mediaType: "text/x-python", strategy: "code" },
  ".rb": { mediaType: "text/x-ruby", strategy: "code" },
  ".rs": { mediaType: "text/x-rust", strategy: "code" },
  ".rst": { mediaType: "text/x-rst", strategy: "markdown" },
  ".scss": { mediaType: "text/x-scss", strategy: "code" },
  ".sh": { mediaType: "text/x-shellscript", strategy: "code" },
  ".sql": { mediaType: "application/sql", strategy: "code" },
  ".toml": { mediaType: "application/toml", strategy: "lines" },
  ".ts": { mediaType: "text/typescript", strategy: "code" },
  ".tsx": { mediaType: "text/typescript", strategy: "code" },
  ".txt": { mediaType: "text/plain", strategy: "text" },
  ".tsv": { mediaType: "text/tab-separated-values", strategy: "lines" },
  ".xml": { mediaType: "application/xml", strategy: "lines" },
  ".yaml": { mediaType: "application/yaml", strategy: "lines" },
  ".yml": { mediaType: "application/yaml", strategy: "lines" },
};

const ALLOWED_DOTFILES: Record<
  string,
  { mediaType: string; strategy: "lines" | "markdown" | "code" | "text" }
> = {
  ".dockerignore": { mediaType: "text/plain", strategy: "lines" },
  ".editorconfig": { mediaType: "text/plain", strategy: "lines" },
  ".gitignore": { mediaType: "text/plain", strategy: "lines" },
};

const SECRET_FILE_PATTERN =
  /(?:^|[._-])(?:env|secret|secrets|credentials|private|id_rsa|id_ed25519)(?:[._-]|$)|\.(?:pem|key|p12|pfx|ppk)$/iu;

const CODE_DECLARATION_PATTERN =
  /^\s*(?:(?:export|pub|public|private|protected|async|static|abstract|default|final)\s+)*(?:function|class|interface|type|enum|def|func|fn|struct|trait|module|namespace|const|let|var)\b/u;

const MAX_CHUNK_CHARS = 12_000;
const CHUNK_OVERLAP_CHARS = 400;

export interface ValidatedIngestionFile {
  name: string;
  extension: string;
  mediaType: string;
  strategy: "lines" | "markdown" | "code" | "text";
}

export interface TextChunk {
  ordinal: number;
  content: string;
  startOffset: number;
  endOffset: number;
}

export type IngestionInputStatusCode = 400 | 413 | 415;

export class IngestionInputError extends Error {
  constructor(
    message: string,
    readonly statusCode: IngestionInputStatusCode,
  ) {
    super(message);
    this.name = "IngestionInputError";
  }
}

export function validateIngestionFile(
  name: string,
  content: string,
): ValidatedIngestionFile {
  if (
    name.length === 0 ||
    name.length > 255 ||
    name.trim().length === 0 ||
    /[/\\\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new IngestionInputError("Invalid file name", 400);
  }

  if (SECRET_FILE_PATTERN.test(name)) {
    throw new IngestionInputError(
      "Credential and private-key files are not accepted",
      415,
    );
  }

  const dotfile = ALLOWED_DOTFILES[name.toLowerCase()];
  const extension = name.toLowerCase().match(/\.[a-z0-9]+$/u)?.[0] ?? "";
  const type = dotfile ?? TEXT_FILE_TYPES[extension];

  if (!type) {
    throw new IngestionInputError(
      "Unsupported file type. Upload a technical text, log, data, or source-code file.",
      415,
    );
  }

  if (
    content.length === 0 ||
    content.trim().length === 0 ||
    content.length > MAX_INGESTION_FILE_CHARS ||
    Buffer.byteLength(content, "utf8") > MAX_INGESTION_FILE_BYTES ||
    content.includes("\u0000")
  ) {
    throw new IngestionInputError(
      "File is empty, binary, or exceeds the 200 KB ingestion limit",
      413,
    );
  }

  if (extension === ".json") {
    try {
      JSON.parse(content);
    } catch {
      throw new IngestionInputError("Invalid JSON file", 400);
    }
  }

  if (extension === ".jsonl") {
    try {
      for (const line of content.split(/\r?\n/u)) {
        if (line.trim().length > 0) {
          JSON.parse(line);
        }
      }
    } catch {
      throw new IngestionInputError("Invalid JSONL file", 400);
    }
  }

  return {
    name,
    extension,
    mediaType: type.mediaType,
    strategy: type.strategy,
  };
}

export function chunkTechnicalText(
  text: string,
  strategy: ValidatedIngestionFile["strategy"],
): TextChunk[] {
  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.slice(start);
    const target = Math.min(start + MAX_CHUNK_CHARS, text.length);
    let end = target;

    if (target < text.length) {
      const newline = text.lastIndexOf("\n", target);
      if (newline > start + MAX_CHUNK_CHARS * 0.55) {
        end = newline + 1;
      }

      if (strategy === "markdown") {
        const paragraph = text.lastIndexOf("\n\n", target);
        if (paragraph > start + MAX_CHUNK_CHARS * 0.4) {
          end = paragraph + 2;
        }
      } else if (strategy === "code") {
        const declarations = [
          ...remaining.slice(0, target - start).matchAll(
            new RegExp(CODE_DECLARATION_PATTERN.source, "gmu"),
          ),
        ];
        const boundary = declarations
          .map((match) => start + (match.index ?? 0))
          .filter(
            (position) => position > start + MAX_CHUNK_CHARS * 0.55,
          )
          .at(-1);
        if (boundary !== undefined) {
          end = boundary;
        }
      }
    }

    if (end <= start) {
      end = Math.min(start + MAX_CHUNK_CHARS, text.length);
    }

    const raw = text.slice(start, end);
    const leadingWhitespace = raw.length - raw.trimStart().length;
    const content = raw.trim();
    const chunkStart = start + leadingWhitespace;
    const chunkEnd = chunkStart + content.length;

    if (content.length > 0) {
      chunks.push({
        ordinal: chunks.length,
        content,
        startOffset: chunkStart,
        endOffset: chunkEnd,
      });
    }

    if (end >= text.length) {
      break;
    }

    const nextStart = end - CHUNK_OVERLAP_CHARS;
    start = Math.max(start + 1, nextStart);
  }

  return chunks;
}
