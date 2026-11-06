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

export interface EnsureIncidentResult {
  incident: IncidentRecord;
  created: boolean;
}

export interface ProductStore {
  listWorkspaces(userId: string): Promise<WorkspaceRecord[]>;

  createWorkspace(
    input: CreateWorkspaceInput,
    ownerUserId: string,
  ): Promise<WorkspaceRecord>;

  listProjects(
    workspaceId: string,
    userId: string,
  ): Promise<ProjectRecord[] | null>;

  createProject(
    workspaceId: string,
    input: CreateProjectInput,
    creatorUserId: string,
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

  async listWorkspaces(userId: string): Promise<WorkspaceRecord[]> {
    const result = await this.pool.query<WorkspaceRecord>(`
      SELECT ${WORKSPACE_COLUMNS}
      FROM workspaces
      WHERE EXISTS (
        SELECT 1
        FROM workspace_memberships
        WHERE workspace_id = workspaces.id
          AND user_id = $1::uuid
      )
      OR EXISTS (
        SELECT 1
        FROM users
        WHERE id = $1::uuid
          AND is_active
          AND instance_role = 'INSTANCE_ADMIN'
      )
      ORDER BY created_at DESC, id ASC
    `, [userId]);

    return result.rows;
  }

  async createWorkspace(
    input: CreateWorkspaceInput,
    ownerUserId: string,
  ): Promise<WorkspaceRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<WorkspaceRecord>(
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
      await client.query(
        `
          INSERT INTO workspace_memberships (workspace_id, user_id, role)
          VALUES ($1::uuid, $2::uuid, 'WORKSPACE_OWNER')
        `,
        [workspace.id, ownerUserId],
      );
      await client.query(
        `
          INSERT INTO security_audit_events (
            actor_user_id, action, resource_type, resource_id, outcome
          )
          VALUES ($1::uuid, 'workspace.created', 'workspace', $2, 'success')
        `,
        [ownerUserId, workspace.id],
      );
      await client.query("COMMIT");
      return workspace;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listProjects(
    workspaceId: string,
    userId: string,
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
          AND (
            EXISTS (
              SELECT 1 FROM workspace_memberships
              WHERE workspace_id = projects.workspace_id
                AND user_id = $2::uuid
                AND role = 'WORKSPACE_OWNER'
            )
            OR EXISTS (
              SELECT 1 FROM project_memberships
              WHERE project_id = projects.id AND user_id = $2::uuid
            )
          )
        ORDER BY created_at DESC, id ASC
      `,
      [workspaceId, userId],
    );

    return result.rows;
  }

  async createProject(
    workspaceId: string,
    input: CreateProjectInput,
    creatorUserId: string,
  ): Promise<ProjectRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ProjectRecord>(
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
      const project = result.rows[0];
      if (!project) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `
          INSERT INTO project_memberships (
            project_id, workspace_id, user_id, role
          )
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'PROJECT_ADMIN')
        `,
        [project.id, workspaceId, creatorUserId],
      );
      await client.query(
        `
          INSERT INTO security_audit_events (
            actor_user_id, action, resource_type, resource_id, outcome
          )
          VALUES ($1::uuid, 'project.created', 'project', $2, 'success')
        `,
        [creatorUserId, project.id],
      );
      await client.query("COMMIT");
      return project;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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

  async ensureIncident(
    projectId: string,
    input: CreateIncidentInput & { externalReference: string },
  ): Promise<EnsureIncidentResult | null> {
    const inserted = await this.pool.query<IncidentRecord>(
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
        ON CONFLICT (project_id, external_reference)
          WHERE external_reference IS NOT NULL
        DO NOTHING
        RETURNING ${INCIDENT_COLUMNS}
      `,
      [
        projectId,
        input.externalReference,
        input.title,
        input.description ?? null,
        input.serviceName ?? null,
        input.severity,
        JSON.stringify(input.context ?? {}),
      ],
    );
    const created = inserted.rows[0];

    if (created) {
      return { incident: created, created: true };
    }

    const existing = await this.pool.query<IncidentRecord>(
      `
        SELECT ${INCIDENT_COLUMNS}
        FROM incidents
        WHERE project_id = $1::uuid
          AND external_reference = $2
      `,
      [projectId, input.externalReference],
    );
    const incident = existing.rows[0];

    return incident ? { incident, created: false } : null;
  }
}