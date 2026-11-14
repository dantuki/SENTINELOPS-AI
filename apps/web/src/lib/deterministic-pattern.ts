export interface DeterministicPatternIdentity {
  ruleId: string;
  matchedFactIds: readonly string[];
}

/**
 * Uses the attested fact identities behind a deterministic pattern instead of
 * its reusable rule name. A rule can legitimately match more than one event.
 */
export function deterministicPatternKey(
  pattern: DeterministicPatternIdentity,
): string {
  const factIds = [...new Set(pattern.matchedFactIds)].sort();

  return `${pattern.ruleId}:${factIds.join("|")}`;
}
