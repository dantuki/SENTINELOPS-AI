/**
 * The QA workspace keeps durable conversations and jobs in these tables.  The
 * check is deliberately read-only: a running API must not attempt migrations
 * on behalf of an operator.
 */
export const QA_PERSISTENCE_TABLES = [
  "qa_conversations",
  "qa_conversation_messages",
  "qa_analysis_runs",
  "qa_analysis_findings",
  "qa_analysis_jobs",
  "qa_analysis_job_events",
] as const;

export const QA_PERSISTENCE_UNAVAILABLE_MESSAGE =
  "La memoria persistente de QA no está preparada en este entorno.";

export interface QaPersistenceSchemaQueryable {
  query(
    text: string,
    values: unknown[],
  ): Promise<{ rows: Array<{ tables: number }> }>;
}

/** Returns false for an incomplete schema and never performs a write. */
export async function isQaPersistenceSchemaReady(
  client: QaPersistenceSchemaQueryable,
): Promise<boolean> {
  const result = await client.query(
    `
      SELECT count(*)::integer AS tables
      FROM unnest($1::text[]) AS expected(name)
      WHERE to_regclass('public.' || expected.name) IS NOT NULL
    `,
    [[...QA_PERSISTENCE_TABLES]],
  );

  return result.rows[0]?.tables === QA_PERSISTENCE_TABLES.length;
}
