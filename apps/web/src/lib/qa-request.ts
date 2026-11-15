export interface GithubQaRequest {
  repositoryUrl: string;
  conversationId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function isGithubQaRequest(value: unknown): value is GithubQaRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "repositoryUrl" in value &&
    typeof value.repositoryUrl === "string" &&
    value.repositoryUrl.trim().length > 0 &&
    value.repositoryUrl.length <= 2048 &&
    Object.keys(value).every((key) => key === "repositoryUrl" || key === "conversationId") &&
    (!("conversationId" in value) || (
      typeof value.conversationId === "string" &&
      UUID_PATTERN.test(value.conversationId)
    ))
  );
}
