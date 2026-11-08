import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";

import { DocumentChunkRepository } from "../src/chunk-repository.js";

const syntheticMarker = "SENTINELOPS_PHASE31_SYNTHETIC_ISOLATION_V1";
const firstIncident = "INC-ISOLATION-A";
const secondIncident = "INC-ISOLATION-B";

interface IdRow {
  id: string;
  name?: string;
}

async function createOrReadWorkspace(
  pool: Pool,
): Promise<string> {
  const slug = "phase31-isolation-synthetic";
  const name = `${syntheticMarker} workspace`;
  const inserted = await pool.query<IdRow>(
    `
      INSERT INTO workspaces (slug, name)
      VALUES ($1, $2)
      ON CONFLICT (slug) DO NOTHING
      RETURNING id, name
    `,
    [slug, name],
  );
  const row =
    inserted.rows[0] ??
    (
      await pool.query<IdRow>(
        "SELECT id, name FROM workspaces WHERE slug = $1",
        [slug],
      )
    ).rows[0];

  assert.ok(row);
  assert.equal(row.name, name);
  return row.id;
}

async function createOrReadProject(
  pool: Pool,
  workspaceId: string,
  slug: string,
): Promise<string> {
  const name = `${syntheticMarker} ${slug}`;
  const inserted = await pool.query<IdRow>(
    `
      INSERT INTO projects (workspace_id, slug, name)
      VALUES ($1::uuid, $2, $3)
      ON CONFLICT (workspace_id, slug) DO NOTHING
      RETURNING id, name
    `,
    [workspaceId, slug, name],
  );
  const row =
    inserted.rows[0] ??
    (
      await pool.query<IdRow>(
        `
          SELECT id, name
          FROM projects
          WHERE workspace_id = $1::uuid
            AND slug = $2
        `,
        [workspaceId, slug],
      )
    ).rows[0];

  assert.ok(row);
  assert.equal(row.name, name);
  return row.id;
}

async function seedProject(
  pool: Pool,
  projectId: string,
  projectLabel: string,
  chunks: Array<{ content: string; incidentId?: string }>,
): Promise<void> {
  const locator = `synthetic://${projectLabel}/phase31-isolation-v1`;
  const source = await pool.query<IdRow>(
    `
      INSERT INTO project_sources (
        project_id,
        source_type,
        name,
        locator,
        status,
        metadata
      )
      VALUES ($1::uuid, 'manual', $2, $3, 'active', $4::jsonb)
      ON CONFLICT (project_id, source_type, locator) DO NOTHING
      RETURNING id, name
    `,
    [
      projectId,
      `${syntheticMarker} ${projectLabel} source`,
      locator,
      JSON.stringify({ synthetic: true, marker: syntheticMarker }),
    ],
  );
  const sourceRow =
    source.rows[0] ??
    (
      await pool.query<IdRow>(
        `
          SELECT id, name
          FROM project_sources
          WHERE project_id = $1::uuid
            AND source_type = 'manual'
            AND locator = $2
        `,
        [projectId, locator],
      )
    ).rows[0];

  assert.ok(sourceRow);
  assert.equal(sourceRow.name, `${syntheticMarker} ${projectLabel} source`);

  const documentKey = "phase31-isolation-v1";
  const title = `${syntheticMarker} ${projectLabel} document`;
  const document = await pool.query<IdRow>(
    `
      INSERT INTO documents (
        project_id,
        source_id,
        source_document_key,
        title,
        extracted_text,
        status,
        metadata
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'indexed', $6::jsonb)
      ON CONFLICT (project_id, source_id, source_document_key) DO NOTHING
      RETURNING id, title AS name
    `,
    [
      projectId,
      sourceRow.id,
      documentKey,
      title,
      chunks.map((chunk) => chunk.content).join("\n"),
      JSON.stringify({ synthetic: true, marker: syntheticMarker }),
    ],
  );
  const documentRow =
    document.rows[0] ??
    (
      await pool.query<IdRow>(
        `
          SELECT id, title AS name
          FROM documents
          WHERE project_id = $1::uuid
            AND source_id = $2::uuid
            AND source_document_key = $3
        `,
        [projectId, sourceRow.id, documentKey],
      )
    ).rows[0];

  assert.ok(documentRow);
  assert.equal(documentRow.name, title);

  const vector = `[1,${Array<number>(1023).fill(0).join(",")}]`;
  for (const [ordinal, chunk] of chunks.entries()) {
    const metadata = {
      synthetic: true,
      marker: syntheticMarker,
      ...(chunk.incidentId ? { incidentId: chunk.incidentId } : {}),
    };
    await pool.query(
      `
        INSERT INTO document_chunks (
          project_id,
          document_id,
          ordinal,
          content,
          metadata,
          embedding,
          embedding_model,
          embedding_updated_at
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          $5::jsonb,
          $6::vector,
          'synthetic-fixed-vector-v1',
          now()
        )
        ON CONFLICT (document_id, ordinal) DO NOTHING
      `,
      [
        projectId,
        documentRow.id,
        ordinal,
        chunk.content,
        JSON.stringify(metadata),
        vector,
      ],
    );
    const persisted = await pool.query<{
      content: string;
      incidentId: string | null;
      hasEmbedding: boolean;
      embeddingModel: string | null;
    }>(
      `
        SELECT
          content,
          metadata ->> 'incidentId' AS "incidentId",
          embedding IS NOT NULL AS "hasEmbedding",
          embedding_model AS "embeddingModel"
        FROM document_chunks
        WHERE document_id = $1::uuid
          AND ordinal = $2
      `,
      [documentRow.id, ordinal],
    );

    assert.deepEqual(persisted.rows[0], {
      content: chunk.content,
      incidentId: chunk.incidentId ?? null,
      hasEmbedding: true,
      embeddingModel: "synthetic-fixed-vector-v1",
    });
  }
}

test("semantic search isolates projects and incident filters in PostgreSQL", async () => {
  const database = process.env.POSTGRES_DB;
  if (
    !database ||
    !/^sentinelops_phase31_isolation_\d+$/u.test(database)
  ) {
    throw new Error(
      "POSTGRES_DB must name a dedicated sentinelops_phase31_isolation_<timestamp> database.",
    );
  }

  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port: Number(process.env.POSTGRES_PORT ?? "5432"),
    database,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 2000,
    statement_timeout: 2000,
    query_timeout: 2500,
  });

  try {
    const currentDatabase = await pool.query<{ name: string }>(
      "SELECT current_database() AS name",
    );
    assert.equal(currentDatabase.rows[0]?.name, database);

    const preexistingProjects = await pool.query<{ count: number }>(
      `
        SELECT count(*)::integer AS count
        FROM projects
        WHERE slug NOT LIKE 'phase31-isolation-%'
      `,
    );
    assert.equal(
      preexistingProjects.rows[0]?.count,
      0,
      "Refusing to run against a database containing non-test projects.",
    );

    const workspaceId = await createOrReadWorkspace(pool);
    const projectA = await createOrReadProject(
      pool,
      workspaceId,
      "phase31-isolation-project-a",
    );
    const projectB = await createOrReadProject(
      pool,
      workspaceId,
      "phase31-isolation-project-b",
    );

    await seedProject(pool, projectA, "project-a", [
      {
        content: `${syntheticMarker} project A incident A evidence`,
        incidentId: firstIncident,
      },
      {
        content: `${syntheticMarker} project A incident B evidence`,
        incidentId: secondIncident,
      },
      {
        content: `${syntheticMarker} project A general evidence`,
      },
    ]);
    await seedProject(pool, projectB, "project-b", [
      {
        content: `${syntheticMarker} project B incident A evidence`,
        incidentId: firstIncident,
      },
    ]);

    const createEvidenceTrail = async (
      projectId: string,
      reference: string,
    ): Promise<void> => {
      const incident = await pool.query<IdRow>(
        `
          INSERT INTO incidents (project_id, external_reference, title)
          VALUES ($1::uuid, $2, $3)
          RETURNING id, title AS name
        `,
        [projectId, reference, `${syntheticMarker} ${reference}`],
      );
      const incidentId = incident.rows[0]?.id;
      assert.ok(incidentId);
      const investigation = await pool.query<IdRow>(
        `
          INSERT INTO investigations (project_id, incident_id)
          VALUES ($1::uuid, $2::uuid)
          RETURNING id
        `,
        [projectId, incidentId],
      );
      const investigationId = investigation.rows[0]?.id;
      assert.ok(investigationId);
      const chunk = await pool.query<{
        id: string;
        documentId: string;
      }>(
        `
          SELECT id, document_id AS "documentId"
          FROM document_chunks
          WHERE project_id = $1::uuid
          ORDER BY ordinal
          LIMIT 1
        `,
        [projectId],
      );
      assert.ok(chunk.rows[0]);
      await pool.query(
        `
          INSERT INTO evidence_records (
            project_id, investigation_id, evidence_type, document_id,
            chunk_id, title, excerpt
          )
          VALUES ($1::uuid, $2::uuid, 'document_chunk', $3::uuid,
                  $4::uuid, $5, $6)
        `,
        [
          projectId,
          investigationId,
          chunk.rows[0].documentId,
          chunk.rows[0].id,
          `${syntheticMarker} ${reference} evidence`,
          `${syntheticMarker} ${reference} excerpt`,
        ],
      );
      return;
    };

    await createEvidenceTrail(projectA, `${firstIncident}-PROJECT-A`);
    await createEvidenceTrail(projectB, `${firstIncident}-PROJECT-B`);

    const projectBReferences = await pool.query<{
      incidentId: string;
      investigationId: string;
      documentId: string;
    }>(
      `
        SELECT
          incidents.id AS "incidentId",
          investigations.id AS "investigationId",
          documents.id AS "documentId"
        FROM incidents
        JOIN investigations
          ON investigations.project_id = incidents.project_id
         AND investigations.incident_id = incidents.id
        JOIN documents ON documents.project_id = incidents.project_id
        WHERE incidents.project_id = $1::uuid
          AND incidents.external_reference = $2
        LIMIT 1
      `,
      [projectB, `${firstIncident}-PROJECT-B`],
    );
    assert.ok(projectBReferences.rows[0]);
    const projectBReference = projectBReferences.rows[0];

    await assert.rejects(
      pool.query(
        `
          INSERT INTO investigations (project_id, incident_id)
          VALUES ($1::uuid, $2::uuid)
        `,
        [projectA, projectBReference.incidentId],
      ),
      {
        code: "23503",
        constraint: "fk_investigations_incident_project",
      },
    );
    await assert.rejects(
      pool.query(
        `
          INSERT INTO document_chunks (
            project_id, document_id, ordinal, content
          )
          VALUES ($1::uuid, $2::uuid, 100, $3)
        `,
        [
          projectA,
          projectBReference.documentId,
          `${syntheticMarker} cross-project chunk must fail`,
        ],
      ),
      {
        code: "23503",
        constraint: "fk_document_chunks_document_project",
      },
    );
    await assert.rejects(
      pool.query(
        `
          INSERT INTO evidence_records (
            project_id, investigation_id, evidence_type, title, excerpt
          )
          VALUES ($1::uuid, $2::uuid, 'manual_note', $3, $4)
        `,
        [
          projectA,
          projectBReference.investigationId,
          `${syntheticMarker} cross-project evidence must fail`,
          syntheticMarker,
        ],
      ),
      {
        code: "23503",
        constraint: "fk_evidence_investigation_project",
      },
    );

    for (const projectId of [projectA, projectB]) {
      const incidentRows = await pool.query<{ projectId: string }>(
        "SELECT project_id AS \"projectId\" FROM incidents WHERE project_id = $1::uuid",
        [projectId],
      );
      const investigationRows = await pool.query<{ projectId: string }>(
        "SELECT project_id AS \"projectId\" FROM investigations WHERE project_id = $1::uuid",
        [projectId],
      );
      const evidenceRows = await pool.query<{ projectId: string }>(
        "SELECT project_id AS \"projectId\" FROM evidence_records WHERE project_id = $1::uuid",
        [projectId],
      );
      assert.ok(incidentRows.rows.length > 0);
      assert.ok(investigationRows.rows.length > 0);
      assert.ok(evidenceRows.rows.length > 0);
      assert.ok(incidentRows.rows.every((row) => row.projectId === projectId));
      assert.ok(investigationRows.rows.every((row) => row.projectId === projectId));
      assert.ok(evidenceRows.rows.every((row) => row.projectId === projectId));
    }

    const crossProjectEvidence = await pool.query<IdRow>(
      `
        SELECT evidence_records.id
        FROM evidence_records
        JOIN investigations
          ON investigations.id = evidence_records.investigation_id
         AND investigations.project_id = evidence_records.project_id
        WHERE evidence_records.project_id = $1::uuid
          AND investigations.project_id <> evidence_records.project_id
      `,
      [projectA],
    );
    assert.equal(crossProjectEvidence.rows.length, 0);

    const projectAIncidentBResults = await new DocumentChunkRepository(
      pool,
    ).searchSimilarChunks(
      projectA,
      [1, ...Array<number>(1023).fill(0)],
      20,
      secondIncident,
    );
    assert.deepEqual(
      new Set(projectAIncidentBResults?.map((result) => result.content)),
      new Set([
        `${syntheticMarker} project A incident B evidence`,
        `${syntheticMarker} project A general evidence`,
      ]),
    );

    const repository = new DocumentChunkRepository(pool);
    const queryEmbedding = [1, ...Array<number>(1023).fill(0)];
    const projectAResults = await repository.searchSimilarChunks(
      projectA,
      queryEmbedding,
      20,
    );
    assert.ok(projectAResults);
    assert.equal(projectAResults.length, 3);
    assert.ok(
      projectAResults.every((result) => result.projectId === projectA),
    );
    assert.ok(
      projectAResults.every(
        (result) => !result.content.includes("project B"),
      ),
    );

    const incidentAResults = await repository.searchSimilarChunks(
      projectA,
      queryEmbedding,
      20,
      firstIncident,
    );
    assert.ok(incidentAResults);
    assert.deepEqual(
      new Set(incidentAResults.map((result) => result.content)),
      new Set([
        `${syntheticMarker} project A incident A evidence`,
        `${syntheticMarker} project A general evidence`,
      ]),
    );

    const projectBIncidentResults =
      await repository.searchSimilarChunks(
        projectB,
        queryEmbedding,
        20,
        firstIncident,
      );
    assert.ok(projectBIncidentResults);
    assert.deepEqual(
      projectBIncidentResults.map((result) => result.content),
      [`${syntheticMarker} project B incident A evidence`],
    );
  } finally {
    await pool.end();
  }
});
