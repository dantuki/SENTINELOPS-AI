export function isGithubQaRequest(value: unknown): value is { repositoryUrl: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "repositoryUrl" in value &&
    typeof value.repositoryUrl === "string" &&
    value.repositoryUrl.trim().length > 0 &&
    value.repositoryUrl.length <= 2048 &&
    Object.keys(value).length === 1
  );
}
