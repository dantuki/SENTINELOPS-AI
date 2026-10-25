import { Pool } from "pg";
import { buildApp } from "./app.js";
import { registerChatRoutes } from "./chat-routes.js";
import { DocumentChunkRepository } from "./chunk-repository.js";
import { registerChunkRoutes } from "./chunk-routes.js";
import { registerDocumentRoutes } from "./document-routes.js";
import { DocumentRepository } from "./document-repository.js";
import { registerEmbeddingRoutes } from "./embedding-routes.js";
import { registerProductRoutes } from "./product-routes.js";
import { ProductRepository } from "./product-repository.js";
import { registerSourceRoutes } from "./source-routes.js";
import { ProjectSourceRepository } from "./source-repository.js";

function createPostgresPool(): Pool | undefined {
  const database = process.env.POSTGRES_DB;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const rawPort = process.env.POSTGRES_PORT ?? "5432";
  const port = Number(rawPort);

  if (
    !database ||
    !user ||
    !password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    return undefined;
  }

  return new Pool({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port,
    database,
    user,
    password,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 2000,
    query_timeout: 2500,
  });
}

async function main(): Promise<void> {
  const host = process.env.API_HOST ?? "127.0.0.1";
  const rawPort = process.env.API_PORT ?? "3001";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT debe ser un puerto válido entre 1 y 65535.");
  }

  const postgresPool = createPostgresPool();

  const app = buildApp({
    ...(postgresPool
      ? {
          postgresHealthCheck: async () => {
            await postgresPool.query("SELECT 1");
          },
        }
      : {}),
  });

  const productRepository = postgresPool
    ? new ProductRepository(postgresPool)
    : undefined;

  const sourceRepository = postgresPool
    ? new ProjectSourceRepository(postgresPool)
    : undefined;

  const documentRepository = postgresPool
    ? new DocumentRepository(postgresPool)
    : undefined;

  const chunkRepository = postgresPool
    ? new DocumentChunkRepository(postgresPool)
    : undefined;

  registerProductRoutes(app, productRepository);
  registerSourceRoutes(app, sourceRepository);
  registerDocumentRoutes(app, documentRepository);
  registerChunkRoutes(app, chunkRepository);
  registerEmbeddingRoutes(app, chunkRepository);
  registerChatRoutes(app);

  postgresPool?.on("error", () => {
    app.log.error("Unexpected PostgreSQL pool error");
  });

  app.addHook("onClose", async () => {
    if (postgresPool) {
      await postgresPool.end();
    }
  });

  try {
    const address = await app.listen({ host, port });
    app.log.info({ address }, "SentinelOps product API started");
  } catch (error: unknown) {
    app.log.error({ err: error }, "Failed to start product API");
    await app.close();
    process.exitCode = 1;
  }
}

void main();