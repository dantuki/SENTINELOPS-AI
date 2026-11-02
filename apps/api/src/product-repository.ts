import type { Pool } from "pg";

export type WorkspaceStatus = "active" | "archived";

export type ProjectStatus = "active" | "archived";

export type IncidentSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "informational"
  | "unknown";

export type IncidentStatus =
  | "new"
  | "triaged"
  | "investigating"
  | "resolved"
  | "closed";

export interface WorkspaceRecord {
  id: string;
  slug: string;
  name: string;
  status: WorkspaceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectRecord {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface IncidentRecord {
  id: string;
  projectId: string;
  externalReference: string | null;
  title: string;
  description: string | null;
  serviceName: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  context: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkspaceInput {
  slug: string;
  name: string;
}

export interface CreateProjectInput {
  slug: string;
  name: string;
  description?: string | null;
}

export interface CreateIncidentInput {
  externalReference?: string | null;
  title: string;
  description?: string | null;
  serviceName?: string | null;
  severity: IncidentSeverity;
  context?: Record<string, unknown>;
}

export interface ProductStore {
  listWorkspaces(): Promise<WorkspaceRecord[]>;

  createWorkspace(
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceRecord>;

  listProjects(
    workspaceId: string,
  ): Promise<ProjectRecord[] | null>;

  createProject(
    workspaceId: string,
    input: CreateProjectInput,
  ): Promise<ProjectRecord | null>;

  listIncidents(
    projectId: string,
  ): Promise<IncidentRecord[] | null>;

  createIncident(
    projectId: string,
    input: CreateIncidentInput,
  ): Promise<IncidentRecord | null>;
}

const WORKSPACE_COLUMNS = `
  id,
  slug,
  name,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const PROJECT_COLUMNS = `
  id,
  workspace_id AS "workspaceId",
  slug,
  name,
  description,
  status,
  settings,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const INCIDENT_COLUMNS = `
  id,
  project_id AS "projectId",
  external_reference AS "externalReference",
  title,
  description,
  service_name AS "serviceName",
  severity,
  status,
  context,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export class ProductRepository implements ProductStore {
  constructor(private readonly pool: Pool) {}

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const result = await this.pool.query<WorkspaceRecord>(`
      SELECT ${WORKSPACE_COLUMNS}
      FROM workspaces
      ORDER BY created_at DESC, id ASC
    `);

    return result.rows;
  }

  async createWorkspace(
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceRecord> {
    const result = await this.pool.query<WorkspaceRecord>(
      `
        INSERT INTO workspaces (slug, name)
        VALUES ($1, $2)
        RETURNING ${WORKSPACE_COLUMNS}
      `,
      [input.slug, input.name],
    );

    const workspace = result.rows[0];

    if (!workspace) {
      throw new Error("Workspace insert returned no row");
    }

    return workspace;
  }

  async listProjects(
    workspaceId: string,
  ): Promise<ProjectRecord[] | null> {
    const workspaceResult = await this.pool.query(
      "SELECT 1 FROM workspaces WHERE id = $1::uuid",
      [workspaceId],
    );

    if (workspaceResult.rows.length === 0) {
      return null;
    }

    const result = await this.pool.query<ProjectRecord>(
      `
        SELECT ${PROJECT_COLUMNS}
        FROM projects
        WHERE workspace_id = $1::uuid
        ORDER BY created_at DESC, id ASC
      `,
      [workspaceId],
    );

    return result.rows;
  }

  async createProject(
    workspaceId: string,
    input: CreateProjectInput,
  ): Promise<ProjectRecord | null> {
    const result = await this.pool.query<ProjectRecord>(
      `
        INSERT INTO projects (
          workspace_id,
          slug,
          name,
          description
        )
        SELECT $1::uuid, $2, $3, $4
        FROM workspaces
        WHERE id = $1::uuid
        RETURNING ${PROJECT_COLUMNS}
      `,
      [
        workspaceId,
        input.slug,
        input.name,
        input.description ?? null,
      ],
    );

    return result.rows[0] ?? null;
  }

  async listIncidents(
    projectId: string,
  ): Promise<IncidentRecord[] | null> {
    const projectResult = await this.pool.query(
      "SELECT 1 FROM projects WHERE id = $1::uuid",
      [projectId],
    );

    if (projectResult.rows.length === 0) {
      return null;
    }

    const result = await this.pool.query<IncidentRecord>(
      `
        SELECT ${INCIDENT_COLUMNS}
        FROM incidents
        WHERE project_id = $1::uuid
        ORDER BY created_at DESC, id ASC
      `,
      [projectId],
    );

    return result.rows;
  }

  async createIncident(
    projectId: string,
    input: CreateIncidentInput,
  ): Promise<IncidentRecord | null> {
    const result = await this.pool.query<IncidentRecord>(
      `
        INSERT INTO incidents (
          project_id,
          external_reference,
          title,
          description,
          service_name,
          severity,
          context
        )
        SELECT
          $1::uuid,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7::jsonb
        FROM projects
        WHERE id = $1::uuid
        RETURNING ${INCIDENT_COLUMNS}
      `,
      [
        projectId,
        input.externalReference ?? null,
        input.title,
        input.description ?? null,
        input.serviceName ?? null,
        input.severity,
        JSON.stringify(input.context ?? {}),
      ],
    );

    return result.rows[0] ?? null;
  }
}