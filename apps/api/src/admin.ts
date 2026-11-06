import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Pool } from "pg";

import { AuthRepository } from "./auth-repository.js";

function createPool(): Pool {
  const database = process.env.POSTGRES_DB;
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD;
  const port = Number(process.env.POSTGRES_PORT ?? "5432");
  if (
    !database ||
    !user ||
    !password ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Database settings are incomplete or invalid.");
  }
  return new Pool({
    host: process.env.POSTGRES_HOST ?? "127.0.0.1",
    port,
    database,
    user,
    password,
    max: 1,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 5_000,
  });
}

async function readHidden(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("This administrative command requires an interactive terminal.");
  }
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("Operation cancelled."));
      } else if (key.name === "return" || key.name === "enter") {
        finish();
      } else if (key.name === "backspace") {
        value = value.slice(0, -1);
      } else if (character && !key.ctrl) {
        value += character;
      }
    };
    stdin.on("keypress", onKeypress);
  });
}

async function bootstrap(repository: AuthRepository): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  let email: string;
  try {
    email = (await terminal.question("Correo del administrador inicial: "))
      .trim()
      .toLowerCase();
  } finally {
    terminal.close();
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 320) {
    throw new Error("A valid email address is required.");
  }
  const password = await readHidden("Contraseña inicial (mínimo 12 caracteres): ");
  if (password.length < 12 || password.length > 1024) {
    throw new Error("Password length must be between 12 and 1024 characters.");
  }
  const confirmation = await readHidden("Repite la contraseña: ");
  if (password !== confirmation) {
    throw new Error("Passwords do not match.");
  }
  const user = await repository.createInitialAdmin(email, password, {});
  stdout.write(`Administrador inicial creado: ${user.email}\n`);
}

async function adoptWorkspace(
  repository: AuthRepository,
  workspaceId: string,
): Promise<void> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      workspaceId,
    )
  ) {
    throw new Error("A workspace UUID is required.");
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  let email: string;
  try {
    email = (await terminal.question("Correo del administrador: "))
      .trim()
      .toLowerCase();
  } finally {
    terminal.close();
  }
  const password = await readHidden("Contraseña del administrador: ");
  const admin = await repository.findUserForLogin(email);
  if (
    !admin ||
    !admin.isActive ||
    admin.instanceRole !== "INSTANCE_ADMIN" ||
    !(await AuthRepository.verifyPassword(password, admin.passwordHash))
  ) {
    throw new Error("Administrator authentication failed.");
  }

  const confirmation = await new Promise<string>((resolve, reject) => {
    const terminalPrompt = createInterface({ input: stdin, output: stdout });
    terminalPrompt
      .question(`Escribe ADOPT ${workspaceId} para confirmar: `)
      .then(resolve, reject)
      .finally(() => terminalPrompt.close());
  });
  if (confirmation !== `ADOPT ${workspaceId}`) {
    throw new Error("Workspace adoption was not confirmed.");
  }
  const adopted = await repository.adoptWorkspace(workspaceId, admin.id, {});
  if (!adopted) {
    throw new Error(
      "Workspace does not exist, already has an owner, or the account cannot adopt it.",
    );
  }
  stdout.write(`Workspace adopted: ${workspaceId}\n`);
}

async function recoverAdministratorPassword(
  repository: AuthRepository,
): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  let email: string;
  try {
    email = (await terminal.question("Correo del administrador activo: "))
      .trim()
      .toLowerCase();
  } finally {
    terminal.close();
  }
  const confirmation = await new Promise<string>((resolve, reject) => {
    const prompt = createInterface({ input: stdin, output: stdout });
    prompt
      .question(`Escribe RESET ${email} para confirmar: `)
      .then(resolve, reject)
      .finally(() => prompt.close());
  });
  if (confirmation !== `RESET ${email}`) {
    throw new Error("Administrator recovery was not confirmed.");
  }
  const password = await readHidden("Nueva contraseña (mínimo 12 caracteres): ");
  if (password.length < 12 || password.length > 1024) {
    throw new Error("Password length must be between 12 and 1024 characters.");
  }
  const repeated = await readHidden("Repite la contraseña: ");
  if (password !== repeated) {
    throw new Error("Passwords do not match.");
  }
  const recovered = await repository.recoverAdministratorPassword(
    email,
    password,
    {},
  );
  if (!recovered) {
    throw new Error("No active instance administrator has that email.");
  }
  stdout.write(`Administrator credentials recovered for ${email}.\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const pool = createPool();
  const repository = new AuthRepository(pool);
  try {
    if (command === "bootstrap-admin") {
      await bootstrap(repository);
      return;
    }
    if (command === "list-unowned-workspaces") {
      const workspaces = await repository.listWorkspacesWithoutOwner();
      if (workspaces.length === 0) {
        stdout.write("No workspaces require an owner.\n");
        return;
      }
      for (const workspace of workspaces) {
        stdout.write(`${workspace.id}\t${workspace.name}\n`);
      }
      return;
    }
    if (command === "adopt-workspace") {
      await adoptWorkspace(repository, process.argv[3] ?? "");
      return;
    }
    if (command === "recover-admin-access") {
      await recoverAdministratorPassword(repository);
      return;
    }
    throw new Error(
      "Usage: admin.ts bootstrap-admin | list-unowned-workspaces | adopt-workspace <workspace-uuid> | recover-admin-access",
    );
  } finally {
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(
    "Administrative command failed:",
    error instanceof Error ? error.message : "Unknown error.",
  );
  process.exitCode = 1;
});
