
import type { Pool } from "pg";

export type ProjectSourceType =
  | "file_upload"
  | "git_repository"
  | "web_url"
  | "manual"
  | "log_bundle";

export type ProjectSourceStatus =
  | "pending"
  | "active"
  | "disabled"
  | "failed";

export interface ProjectSourceRecord {
  id: string;
  projectId: string;
  sourceType: ProjectSourceType;
  name: string;
  locator: string;
  status: ProjectSourceStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateProjectSourceInput {
  sourceType: ProjectSourceType;
  name: string;
  locator: string;
  metadata?: Record<string, unknown>;
}

export class ProjectSourceRepository {
  constructor(private readonly pool: Pool) {}

  async listForProject(
    projectId: string,
  ): Promise<ProjectSourceRecord[] | null> {
    const projectResult = await this.pool.query(
      "SELECT 1 FROM projects WHERE id = $1::uuid",
      [projectId],
    );

    if (projectResult.rows.length === 0) {
      return null;
    }

    const result = await this.pool.query<ProjectSourceRecord>(
      `
        SELECT
          id,
          project_id AS "projectId",
          source_type AS "sourceType",
          name,
          locator,
          status,
          metadata,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM project_sources
        WHERE project_id = $1::uuid
        ORDER BY created_at DESC, id ASC
      `,
      [projectId],
    );

    return result.rows;
  }

  async createForProject(
    projectId: string,
    input: CreateProjectSourceInput,
  ): Promise<ProjectSourceRecord | null> {
    const result = await this.pool.query<ProjectSourceRecord>(
      `
        INSERT INTO project_sources (
          project_id,
          source_type,
          name,
          locator,
          metadata
        )
        SELECT
          $1::uuid,
          $2,
          $3,
          $4,
          $5::jsonb
        FROM projects
        WHERE id = $1::uuid
        RETURNING
          id,
          project_id AS "projectId",
          source_type AS "sourceType",
          name,
          locator,
          status,
          metadata,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [
        projectId,
        input.sourceType,
        input.name,
        input.locator,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    return result.rows[0] ?? null;
  }
}
