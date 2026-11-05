export function getAiServiceAuthHeaders(): Record<string, string> {
  const key = process.env.AI_ORCHESTRATOR_API_KEY;
  return key ? { authorization: `Bearer ${key}` } : {};
}

export function assertAiServiceAuthConfiguration(): void {
  const key = process.env.AI_ORCHESTRATOR_API_KEY;
  if (process.env.NODE_ENV === "production" && (!key || key.length < 32)) {
    throw new Error(
      "AI_ORCHESTRATOR_API_KEY must contain at least 32 characters in production.",
    );
  }
  if (key && key.length < 32) {
    throw new Error("AI_ORCHESTRATOR_API_KEY must contain at least 32 characters.");
  }
}
