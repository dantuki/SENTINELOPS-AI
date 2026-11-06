import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { scrypt } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type WorkspaceRole = "WORKSPACE_OWNER" | "WORKSPACE_MEMBER";
export type ProjectRole = "PROJECT_ADMIN" | "INVESTIGATOR" | "VIEWER";

export interface AuthUser {
  id: string;
  email: string;
  instanceRole: "INSTANCE_ADMIN" | null;
  lastLoginAt: Date | null;
}

export interface StoredUser extends AuthUser {
  passwordHash: string;
  isActive: boolean;
}

export interface AuthSession extends AuthUser {
  csrfTokenHash: string;
}

export interface WorkspaceMembershipRecord {
  userId: string;
  email: string;
  role: WorkspaceRole;
  createdAt: Date;
}

export interface ProjectMembershipRecord {
  userId: string;
  email: string;
  role: ProjectRole;
  createdAt: Date;
}

export interface AuditContext {
  requestId?: string;
  remoteAddress?: string;
}

export interface AuthorizationScope {
  workspaceId?: string;
  projectId?: string;
}

export interface AuditEvent extends AuditContext {
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: "success" | "denied" | "failure";
}

export class BootstrapAlreadyCompletedError extends Error {
  constructor() {
    super("An instance administrator already exists.");
    this.name = "BootstrapAlreadyCompletedError";
  }
}

export class UserNotFoundError extends Error {
  constructor() {
    super("User not found.");
    this.name = "UserNotFoundError";
  }
}

const PASSWORD_HASH_BYTES = 64;
const SCRYPT_OPTIONS = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};
const DUMMY_SALT = "sentinelops-login-timing-salt";
const BOOTSTRAP_LOCK_ID = "731029482765014";

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function derivePassword(
  password: string,
  salt: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_HASH_BYTES,
      SCRYPT_OPTIONS,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function mapAuthUser(row: {
  id: string;
  email: string;
  instanceRole: "INSTANCE_ADMIN" | null;
  lastLoginAt: Date | null;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    instanceRole: row.instanceRole,
    lastLoginAt: row.lastLoginAt,
  };
}

export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  static async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("base64url");
    const derivedKey = await derivePassword(password, salt);
    return `scrypt$32768$8$1$${salt}$${derivedKey.toString("base64url")}`;
  }

  static async verifyPassword(
    password: string,
    encodedHash: string | null,
  ): Promise<boolean> {
    if (!encodedHash) {
      await derivePassword(password, DUMMY_SALT);
      return false;
    }

    const parts = encodedHash.split("$");
    if (
      parts.length !== 6 ||
      parts[0] !== "scrypt" ||
      parts[1] !== "32768" ||
      parts[2] !== "8" ||
      parts[3] !== "1" ||
      !parts[4] ||
      !parts[5]
    ) {
      await derivePassword(password, DUMMY_SALT);
      return false;
    }

    const expected = Buffer.from(parts[5], "base64url");
    const actual = await derivePassword(password, parts[4]);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  async findUserForLogin(email: string): Promise<StoredUser | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      passwordHash: string;
      isActive: boolean;
      instanceRole: "INSTANCE_ADMIN" | null;
      lastLoginAt: Date | null;
    }>(
      `
        SELECT
          id,
          email,
          password_hash AS "passwordHash",
          is_active AS "isActive",
          instance_role AS "instanceRole",
          last_login_at AS "lastLoginAt"
        FROM users
        WHERE email = $1
      `,
      [email],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      ...mapAuthUser(row),
      passwordHash: row.passwordHash,
      isActive: row.isActive,
    };
  }

  async consumeLoginAttempt(
    email: string,
    remoteAddress: string,
    maxAttempts: number,
    maxIpAttempts: number,
    windowSeconds: number,
  ): Promise<boolean> {
    await this.pool.query(
      `
        DELETE FROM auth_login_rate_limits
        WHERE updated_at < now() - make_interval(secs => $1::double precision * 4)
      `,
      [windowSeconds],
    );
    const consumeBucket = async (
      bucketHash: string,
      limit: number,
    ): Promise<boolean> => {
      const result = await this.pool.query<{ attempts: number }>(
        `
          INSERT INTO auth_login_rate_limits (
            bucket_hash, window_started_at, attempts
          )
          VALUES ($1, now(), 1)
          ON CONFLICT (bucket_hash) DO UPDATE
          SET
            attempts = CASE
              WHEN auth_login_rate_limits.window_started_at
                <= now() - make_interval(secs => $2::double precision)
              THEN 1
              ELSE auth_login_rate_limits.attempts + 1
            END,
            window_started_at = CASE
              WHEN auth_login_rate_limits.window_started_at
                <= now() - make_interval(secs => $2::double precision)
              THEN now()
              ELSE auth_login_rate_limits.window_started_at
            END,
            updated_at = now()
          RETURNING attempts
        `,
        [bucketHash, windowSeconds],
      );
      return (result.rows[0]?.attempts ?? limit + 1) <= limit;
    };
    const [emailAllowed, addressAllowed] = await Promise.all([
      consumeBucket(hashValue(`email:${email}`), maxAttempts),
      consumeBucket(hashValue(`ip:${remoteAddress}`), maxIpAttempts),
    ]);
    return emailAllowed && addressAllowed;
  }

  async clearLoginAttempts(email: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM auth_login_rate_limits WHERE bucket_hash = $1",
      [hashValue(`email:${email}`)],
    );
  }

  async recordAudit(event: AuditEvent): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO security_audit_events (
          actor_user_id,
          action,
          resource_type,
          resource_id,
          outcome,
          request_id,
          remote_address_hash
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
      `,
      [
        event.actorUserId,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.outcome,
        event.requestId ?? null,
        event.remoteAddress ? hashValue(event.remoteAddress) : null,
      ],
    );
  }

  async createInitialAdmin(
    email: string,
    password: string,
    context: AuditContext,
  ): Promise<AuthUser> {
    const passwordHash = await AuthRepository.hashPassword(password);
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        BOOTSTRAP_LOCK_ID,
      ]);
      const existing = await client.query(
        "SELECT 1 FROM users WHERE instance_role = 'INSTANCE_ADMIN' LIMIT 1",
      );
      if (existing.rowCount) {
        throw new BootstrapAlreadyCompletedError();
      }
      const inserted = await client.query<{
        id: string;
        email: string;
        instanceRole: "INSTANCE_ADMIN";
        lastLoginAt: Date | null;
      }>(
        `
          INSERT INTO users (email, password_hash, instance_role)
          VALUES ($1, $2, 'INSTANCE_ADMIN')
          RETURNING
            id,
            email,
            instance_role AS "instanceRole",
            last_login_at AS "lastLoginAt"
        `,
        [email, passwordHash],
      );
      const user = inserted.rows[0];
      if (!user) {
        throw new Error("Initial administrator insert returned no row.");
      }
      await this.insertAudit(client, {
        actorUserId: user.id,
        action: "bootstrap.initial_admin_created",
        resourceType: "user",
        resourceId: user.id,
        outcome: "success",
        ...context,
      });
      return mapAuthUser(user);
    });
  }

  async createUser(
    email: string,
    password: string,
    actorUserId: string,
    context: AuditContext,
  ): Promise<AuthUser> {
    const passwordHash = await AuthRepository.hashPassword(password);
    return transaction(this.pool, async (client) => {
      const inserted = await client.query<{
        id: string;
        email: string;
        instanceRole: null;
        lastLoginAt: null;
      }>(
        `
          INSERT INTO users (email, password_hash)
          VALUES ($1, $2)
          RETURNING
            id,
            email,
            instance_role AS "instanceRole",
            last_login_at AS "lastLoginAt"
        `,
        [email, passwordHash],
      );
      const user = inserted.rows[0];
      if (!user) {
        throw new Error("User insert returned no row.");
      }
      await this.insertAudit(client, {
        actorUserId,
        action: "user.created",
        resourceType: "user",
        resourceId: user.id,
        outcome: "success",
        ...context,
      });
      return mapAuthUser(user);
    });
  }

  async createSession(
    userId: string,
    tokenHash: string,
    csrfTokenHash: string,
    expiresAt: Date,
    context: AuditContext,
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const created = await client.query(
        `
          INSERT INTO sessions (token_hash, user_id, csrf_token_hash, expires_at)
          SELECT $1, id, $3, $4
          FROM users
          WHERE id = $2::uuid AND is_active
        `,
        [tokenHash, userId, csrfTokenHash, expiresAt],
      );
      if (!created.rowCount) {
        throw new UserNotFoundError();
      }
      await client.query(
        "UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1::uuid",
        [userId],
      );
      await this.insertAudit(client, {
        actorUserId: userId,
        action: "auth.login",
        resourceType: "session",
        outcome: "success",
        ...context,
      });
    });
  }

  async findSession(tokenHash: string): Promise<AuthSession | null> {
    const result = await this.pool.query<{
      id: string;
      email: string;
      instanceRole: "INSTANCE_ADMIN" | null;
      lastLoginAt: Date | null;
      csrfTokenHash: string;
    }>(
      `
        SELECT
          users.id,
          users.email,
          users.instance_role AS "instanceRole",
          users.last_login_at AS "lastLoginAt",
          sessions.csrf_token_hash AS "csrfTokenHash"
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > now()
          AND users.is_active
      `,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    await this.pool.query(
      `
        UPDATE sessions
        SET last_seen_at = now()
        WHERE token_hash = $1
          AND last_seen_at < now() - interval '5 minutes'
      `,
      [tokenHash],
    );
    return { ...mapAuthUser(row), csrfTokenHash: row.csrfTokenHash };
  }

  async revokeSession(
    tokenHash: string,
    userId: string,
    context: AuditContext,
  ): Promise<void> {
    await transaction(this.pool, async (client) => {
      const revoked = await client.query(
        `
          UPDATE sessions
          SET revoked_at = now()
          WHERE token_hash = $1 AND user_id = $2::uuid AND revoked_at IS NULL
        `,
        [tokenHash, userId],
      );
      if (revoked.rowCount) {
        await this.insertAudit(client, {
          actorUserId: userId,
          action: "auth.logout",
          resourceType: "session",
          outcome: "success",
          ...context,
        });
      }
    });
  }

  async rotateSession(
    tokenHash: string,
    userId: string,
    newTokenHash: string,
    csrfTokenHash: string,
    expiresAt: Date,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const previous = await client.query<{ authTime: Date }>(
        `
          UPDATE sessions
          SET revoked_at = now()
          WHERE token_hash = $1
            AND user_id = $2::uuid
            AND revoked_at IS NULL
            AND expires_at > now()
            AND auth_time > now() - interval '7 days'
          RETURNING auth_time AS "authTime"
        `,
        [tokenHash, userId],
      );
      const session = previous.rows[0];
      if (!session) {
        return false;
      }
      await client.query(
        `
          INSERT INTO sessions (
            token_hash, user_id, csrf_token_hash, auth_time, expires_at
          )
          VALUES ($1, $2::uuid, $3, $4, $5)
        `,
        [newTokenHash, userId, csrfTokenHash, session.authTime, expiresAt],
      );
      await this.insertAudit(client, {
        actorUserId: userId,
        action: "auth.session_rotated",
        resourceType: "session",
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async authorize(
    userId: string,
    permission: string,
    scope: AuthorizationScope,
  ): Promise<boolean> {
    if (permission === "workspace.list") {
      const result = await this.pool.query(
        `
          SELECT 1
          FROM users
          WHERE id = $1::uuid
            AND is_active
            AND (
              instance_role = 'INSTANCE_ADMIN'
              OR EXISTS (
                SELECT 1 FROM workspace_memberships
                WHERE user_id = users.id
              )
            )
        `,
        [userId],
      );
      return Boolean(result.rowCount);
    }

    if (permission === "instance.admin") {
      const result = await this.pool.query(
        `
          SELECT 1 FROM users
          WHERE id = $1::uuid
            AND is_active
            AND instance_role = 'INSTANCE_ADMIN'
        `,
        [userId],
      );
      return Boolean(result.rowCount);
    }

    if (permission === "workspace.projects.read") {
      if (!scope.workspaceId) {
        return false;
      }
      const result = await this.pool.query(
        `
          SELECT 1
          FROM projects
          WHERE workspace_id = $2::uuid
            AND (
              EXISTS (
                SELECT 1
                FROM workspace_memberships
                WHERE workspace_id = projects.workspace_id
                  AND user_id = $1::uuid
                  AND role = 'WORKSPACE_OWNER'
              )
              OR EXISTS (
                SELECT 1
                FROM project_memberships
                WHERE project_id = projects.id AND user_id = $1::uuid
              )
            )
          LIMIT 1
        `,
        [userId, scope.workspaceId],
      );
      if (result.rowCount) {
        return true;
      }
      const owner = await this.pool.query(
        `
          SELECT 1 FROM workspace_memberships
          WHERE workspace_id = $2::uuid
            AND user_id = $1::uuid
        `,
        [userId, scope.workspaceId],
      );
      return Boolean(owner.rowCount);
    }

    if (permission.startsWith("workspace.") && scope.workspaceId) {
      const result = await this.pool.query(
        `
          SELECT 1
          FROM workspace_memberships
          WHERE workspace_id = $2::uuid
            AND user_id = $1::uuid
            AND role = 'WORKSPACE_OWNER'
        `,
        [userId, scope.workspaceId],
      );
      return Boolean(result.rowCount);
    }

    if (permission === "chat.use") {
      const result = await this.pool.query(
        `
          SELECT 1
          FROM users
          WHERE id = $1::uuid AND is_active
            AND (
              instance_role = 'INSTANCE_ADMIN'
              OR EXISTS (
                SELECT 1
                FROM project_memberships
                WHERE user_id = users.id
                  AND role IN ('PROJECT_ADMIN', 'INVESTIGATOR')
              )
              OR EXISTS (
                SELECT 1
                FROM workspace_memberships
                WHERE user_id = users.id AND role = 'WORKSPACE_OWNER'
              )
            )
        `,
        [userId],
      );
      return Boolean(result.rowCount);
    }

    if (!scope.projectId) {
      return false;
    }

    const allowedRoles =
      permission === "project.read"
        ? ["PROJECT_ADMIN", "INVESTIGATOR", "VIEWER"]
        : permission === "project.investigate"
          ? ["PROJECT_ADMIN", "INVESTIGATOR"]
          : permission === "project.manage"
            ? ["PROJECT_ADMIN"]
            : permission === "project.members.manage"
              ? ["PROJECT_ADMIN"]
              : [];
    if (allowedRoles.length === 0) {
      return false;
    }

    const result = await this.pool.query(
      `
        SELECT 1
        FROM projects
        WHERE id = $2::uuid
          AND (
            EXISTS (
              SELECT 1
              FROM workspace_memberships
              WHERE workspace_id = projects.workspace_id
                AND user_id = $1::uuid
                AND role = 'WORKSPACE_OWNER'
            )
            OR EXISTS (
              SELECT 1
              FROM project_memberships
              WHERE project_id = projects.id
                AND user_id = $1::uuid
                AND role = ANY($3::text[])
            )
          )
      `,
      [userId, scope.projectId, allowedRoles],
    );
    return Boolean(result.rowCount);
  }

  async createWorkspaceMembership(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        BOOTSTRAP_LOCK_ID,
      ]);
      await client.query(
        "SELECT id FROM workspaces WHERE id = $1::uuid FOR UPDATE",
        [workspaceId],
      );
      if (role === "WORKSPACE_MEMBER") {
        const ownerCount = await client.query<{ count: number }>(
          `
            SELECT count(*)::integer AS count
            FROM workspace_memberships
            JOIN users ON users.id = workspace_memberships.user_id
            WHERE workspace_memberships.workspace_id = $1::uuid
              AND workspace_memberships.role = 'WORKSPACE_OWNER'
              AND users.is_active
          `,
          [workspaceId],
        );
        const targetIsOwner = await client.query(
          `
            SELECT 1
            FROM workspace_memberships
            JOIN users ON users.id = workspace_memberships.user_id
            WHERE workspace_memberships.workspace_id = $1::uuid
              AND workspace_memberships.user_id = $2::uuid
              AND workspace_memberships.role = 'WORKSPACE_OWNER'
              AND users.is_active
          `,
          [workspaceId, userId],
        );
        if (targetIsOwner.rowCount && (ownerCount.rows[0]?.count ?? 0) <= 1) {
          return false;
        }
      }
      const result = await client.query(
        `
          INSERT INTO workspace_memberships (workspace_id, user_id, role)
          SELECT $1::uuid, users.id, $3
          FROM users
          WHERE users.id = $2::uuid AND users.is_active
          ON CONFLICT (workspace_id, user_id)
          DO UPDATE SET role = EXCLUDED.role
          RETURNING user_id
        `,
        [workspaceId, userId, role],
      );
      if (!result.rowCount) {
        return false;
      }
      await this.revokeSessions(client, userId, actorUserId, context);
      await this.insertAudit(client, {
        actorUserId,
        action: "membership.workspace.granted",
        resourceType: "workspace_membership",
        resourceId: `${workspaceId}:${userId}`,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async removeWorkspaceMembership(
    workspaceId: string,
    userId: string,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        BOOTSTRAP_LOCK_ID,
      ]);
      await client.query(
        "SELECT id FROM workspaces WHERE id = $1::uuid FOR UPDATE",
        [workspaceId],
      );
      const membership = await client.query<{
        role: WorkspaceRole;
        isActive: boolean;
      }>(
        `
          SELECT
            workspace_memberships.role,
            users.is_active AS "isActive"
          FROM workspace_memberships
          JOIN users ON users.id = workspace_memberships.user_id
          WHERE workspace_memberships.workspace_id = $1::uuid
            AND workspace_memberships.user_id = $2::uuid
        `,
        [workspaceId, userId],
      );
      if (!membership.rowCount) {
        return false;
      }
      if (
        membership.rows[0]?.role === "WORKSPACE_OWNER" &&
        membership.rows[0].isActive
      ) {
        const ownerCount = await client.query<{ count: number }>(
          `
            SELECT count(*)::integer AS count
            FROM workspace_memberships
            JOIN users ON users.id = workspace_memberships.user_id
            WHERE workspace_memberships.workspace_id = $1::uuid
              AND workspace_memberships.role = 'WORKSPACE_OWNER'
              AND users.is_active
          `,
          [workspaceId],
        );
        if ((ownerCount.rows[0]?.count ?? 0) <= 1) {
          return false;
        }
      }
      const result = await client.query(
        `
          DELETE FROM workspace_memberships
          WHERE workspace_id = $1::uuid AND user_id = $2::uuid
        `,
        [workspaceId, userId],
      );
      if (!result.rowCount) {
        return false;
      }
      await this.revokeSessions(client, userId, actorUserId, context);
      await this.insertAudit(client, {
        actorUserId,
        action: "membership.workspace.revoked",
        resourceType: "workspace_membership",
        resourceId: `${workspaceId}:${userId}`,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async createProjectMembership(
    projectId: string,
    userId: string,
    role: ProjectRole,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const actor = await client.query<{ role: string | null }>(
        `
          SELECT COALESCE(
            (
              SELECT 'WORKSPACE_OWNER'
              FROM workspace_memberships
              WHERE workspace_id = projects.workspace_id
                AND user_id = $2::uuid
                AND role = 'WORKSPACE_OWNER'
            ),
            (
              SELECT role
              FROM project_memberships
              WHERE project_id = projects.id AND user_id = $2::uuid
            )
          ) AS role
          FROM projects
          WHERE projects.id = $1::uuid
        `,
        [projectId, actorUserId],
      );
      if (
        !actor.rows[0] ||
        (role === "PROJECT_ADMIN" &&
          actor.rows[0].role !== "WORKSPACE_OWNER")
      ) {
        return false;
      }
      const result = await client.query(
        `
          INSERT INTO project_memberships (
            project_id, workspace_id, user_id, role
          )
          SELECT projects.id, projects.workspace_id, users.id, $3
          FROM projects
          JOIN workspace_memberships
            ON workspace_memberships.workspace_id = projects.workspace_id
          JOIN users ON users.id = workspace_memberships.user_id
          WHERE projects.id = $1::uuid
            AND users.id = $2::uuid
            AND users.is_active
          ON CONFLICT (project_id, user_id)
          DO UPDATE SET role = EXCLUDED.role
          RETURNING user_id
        `,
        [projectId, userId, role],
      );
      if (!result.rowCount) {
        return false;
      }
      await this.revokeSessions(client, userId, actorUserId, context);
      await this.insertAudit(client, {
        actorUserId,
        action: "membership.project.granted",
        resourceType: "project_membership",
        resourceId: `${projectId}:${userId}`,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async removeProjectMembership(
    projectId: string,
    userId: string,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `
          DELETE FROM project_memberships
          WHERE project_id = $1::uuid AND user_id = $2::uuid
        `,
        [projectId, userId],
      );
      if (!result.rowCount) {
        return false;
      }
      await this.revokeSessions(client, userId, actorUserId, context);
      await this.insertAudit(client, {
        actorUserId,
        action: "membership.project.revoked",
        resourceType: "project_membership",
        resourceId: `${projectId}:${userId}`,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async setInstanceAdmin(
    userId: string,
    isAdmin: boolean,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        BOOTSTRAP_LOCK_ID,
      ]);
      if (!isAdmin) {
        const admins = await client.query<{ count: number }>(
          `
            SELECT count(*)::integer AS count
            FROM users
            WHERE instance_role = 'INSTANCE_ADMIN'
              AND is_active
          `,
        );
        if ((admins.rows[0]?.count ?? 0) <= 1) {
          return false;
        }
      }
      const result = await client.query(
        `
          UPDATE users
          SET instance_role = $2, updated_at = now()
          WHERE id = $1::uuid AND is_active
        `,
        [userId, isAdmin ? "INSTANCE_ADMIN" : null],
      );
      if (!result.rowCount) {
        return false;
      }
      await this.revokeSessions(client, userId, actorUserId, context);
      await this.insertAudit(client, {
        actorUserId,
        action: isAdmin
          ? "user.instance_admin.granted"
          : "user.instance_admin.revoked",
        resourceType: "user",
        resourceId: userId,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async deactivateUser(
    userId: string,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        BOOTSTRAP_LOCK_ID,
      ]);
      const admins = await client.query<{ count: number }>(
        `
          SELECT count(*)::integer AS count
          FROM users
          WHERE instance_role = 'INSTANCE_ADMIN' AND is_active
        `,
      );
      const target = await client.query<{ isAdmin: boolean }>(
        `
          SELECT (instance_role = 'INSTANCE_ADMIN') AS "isAdmin"
          FROM users
          WHERE id = $1::uuid AND is_active
          FOR UPDATE
        `,
        [userId],
      );
      if (!target.rowCount) {
        return false;
      }
      if (
        target.rows[0]?.isAdmin &&
        (admins.rows[0]?.count ?? 0) <= 1
      ) {
        return false;
      }
      const lastOwner = await client.query(
        `
          SELECT 1
          FROM workspace_memberships AS target_membership
          WHERE target_membership.user_id = $1::uuid
            AND target_membership.role = 'WORKSPACE_OWNER'
            AND (
              SELECT count(*)
              FROM workspace_memberships AS other_membership
              JOIN users AS other_user
                ON other_user.id = other_membership.user_id
              WHERE other_membership.workspace_id =
                    target_membership.workspace_id
                AND other_membership.role = 'WORKSPACE_OWNER'
                AND other_user.is_active
            ) <= 1
          LIMIT 1
        `,
        [userId],
      );
      if (lastOwner.rowCount) {
        return false;
      }
      await client.query(
        `
          UPDATE users
          SET is_active = FALSE, updated_at = now()
          WHERE id = $1::uuid
        `,
        [userId],
      );
      await this.revokeSessions(client, userId, actorUserId, context);
      await this.insertAudit(client, {
        actorUserId,
        action: "user.deactivated",
        resourceType: "user",
        resourceId: userId,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async activateUser(
    userId: string,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `
          UPDATE users
          SET is_active = TRUE, updated_at = now()
          WHERE id = $1::uuid AND is_active = FALSE
        `,
        [userId],
      );
      if (!result.rowCount) {
        return false;
      }
      await this.insertAudit(client, {
        actorUserId,
        action: "user.activated",
        resourceType: "user",
        resourceId: userId,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async resetUserPassword(
    userId: string,
    password: string,
    actorUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    const passwordHash = await AuthRepository.hashPassword(password);
    return transaction(this.pool, async (client) => {
      const result = await client.query(
        `
          UPDATE users
          SET password_hash = $2, updated_at = now()
          WHERE id = $1::uuid AND is_active
        `,
        [userId, passwordHash],
      );
      if (!result.rowCount) {
        return false;
      }
      await this.revokeSessions(client, userId, actorUserId, context);
      await this.insertAudit(client, {
        actorUserId,
        action: "user.password_reset",
        resourceType: "user",
        resourceId: userId,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async recoverAdministratorPassword(
    email: string,
    password: string,
    context: AuditContext,
  ): Promise<boolean> {
    const passwordHash = await AuthRepository.hashPassword(password);
    return transaction(this.pool, async (client) => {
      const target = await client.query<{ id: string }>(
        `
          UPDATE users
          SET password_hash = $2, updated_at = now()
          WHERE email = $1
            AND is_active
            AND instance_role = 'INSTANCE_ADMIN'
          RETURNING id
        `,
        [email, passwordHash],
      );
      const user = target.rows[0];
      if (!user) {
        return false;
      }
      await this.revokeSessions(client, user.id, null, context);
      await this.insertAudit(client, {
        actorUserId: null,
        action: "auth.administrator_password_recovered",
        resourceType: "user",
        resourceId: user.id,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  async listWorkspacesWithoutOwner(): Promise<
    Array<{ id: string; name: string }>
  > {
    const result = await this.pool.query<{ id: string; name: string }>(
      `
        SELECT workspaces.id, workspaces.name
        FROM workspaces
        WHERE NOT EXISTS (
          SELECT 1
          FROM workspace_memberships
          JOIN users ON users.id = workspace_memberships.user_id
          WHERE workspace_memberships.workspace_id = workspaces.id
            AND workspace_memberships.role = 'WORKSPACE_OWNER'
            AND users.is_active
        )
        ORDER BY workspaces.created_at, workspaces.id
      `,
    );
    return result.rows;
  }

  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<WorkspaceMembershipRecord[]> {
    const result = await this.pool.query<WorkspaceMembershipRecord>(
      `
        SELECT
          users.id AS "userId",
          users.email,
          workspace_memberships.role,
          workspace_memberships.created_at AS "createdAt"
        FROM workspace_memberships
        JOIN users ON users.id = workspace_memberships.user_id
        WHERE workspace_memberships.workspace_id = $1::uuid
        ORDER BY workspace_memberships.created_at, users.email
      `,
      [workspaceId],
    );
    return result.rows;
  }

  async listProjectMembers(
    projectId: string,
  ): Promise<ProjectMembershipRecord[]> {
    const result = await this.pool.query<ProjectMembershipRecord>(
      `
        SELECT
          users.id AS "userId",
          users.email,
          project_memberships.role,
          project_memberships.created_at AS "createdAt"
        FROM project_memberships
        JOIN users ON users.id = project_memberships.user_id
        WHERE project_memberships.project_id = $1::uuid
        ORDER BY project_memberships.created_at, users.email
      `,
      [projectId],
    );
    return result.rows;
  }

  async adoptWorkspace(
    workspaceId: string,
    adminUserId: string,
    context: AuditContext,
  ): Promise<boolean> {
    return transaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
        BOOTSTRAP_LOCK_ID,
      ]);
      const adopted = await client.query(
        `
          INSERT INTO workspace_memberships (
            workspace_id, user_id, role
          )
          SELECT workspaces.id, admins.id, 'WORKSPACE_OWNER'
          FROM workspaces
          JOIN users AS admins
            ON admins.id = $2::uuid
            AND admins.is_active
            AND admins.instance_role = 'INSTANCE_ADMIN'
          WHERE workspaces.id = $1::uuid
            AND NOT EXISTS (
              SELECT 1
              FROM workspace_memberships AS owners
              JOIN users AS owner_users
                ON owner_users.id = owners.user_id
              WHERE owners.workspace_id = workspaces.id
                AND owners.role = 'WORKSPACE_OWNER'
                AND owner_users.is_active
            )
          ON CONFLICT (workspace_id, user_id)
          DO UPDATE SET role = 'WORKSPACE_OWNER'
          RETURNING workspace_id
        `,
        [workspaceId, adminUserId],
      );
      if (!adopted.rowCount) {
        return false;
      }
      await this.revokeSessions(client, adminUserId, adminUserId, context);
      await this.insertAudit(client, {
        actorUserId: adminUserId,
        action: "workspace.adopted",
        resourceType: "workspace",
        resourceId: workspaceId,
        outcome: "success",
        ...context,
      });
      return true;
    });
  }

  private async insertAudit(
    client: PoolClient,
    event: AuditEvent,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO security_audit_events (
          actor_user_id, action, resource_type, resource_id, outcome,
          request_id, remote_address_hash
        )
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
      `,
      [
        event.actorUserId,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.outcome,
        event.requestId ?? null,
        event.remoteAddress ? hashValue(event.remoteAddress) : null,
      ],
    );
  }

  private async revokeSessions(
    client: PoolClient,
    userId: string,
    actorUserId: string | null,
    context: AuditContext,
  ): Promise<void> {
    const result = await client.query(
      `
        UPDATE sessions
        SET revoked_at = now()
        WHERE user_id = $1::uuid AND revoked_at IS NULL
      `,
      [userId],
    );
    if (result.rowCount) {
      await this.insertAudit(client, {
        actorUserId,
        action: "auth.sessions_revoked",
        resourceType: "user",
        resourceId: userId,
        outcome: "success",
        ...context,
      });
    }
  }
}

export function digestToken(token: string): string {
  return hashValue(token);
}
