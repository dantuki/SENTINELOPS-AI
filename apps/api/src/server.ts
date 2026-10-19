
import { buildApp } from "./app.js";

async function main(): Promise<void> {
  const host = process.env.API_HOST ?? "127.0.0.1";
  const rawPort = process.env.API_PORT ?? "3001";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("API_PORT debe ser un puerto válido entre 1 y 65535.");
  }

  const app = buildApp();

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
