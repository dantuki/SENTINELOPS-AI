"use client";

import { useState, type FormEvent } from "react";

interface LoginResponse {
  data: {
    id: string;
    email: string;
    instanceRole: "INSTANCE_ADMIN" | null;
  };
}

function isLoginResponse(value: unknown): value is LoginResponse {
  if (
    typeof value !== "object" ||
    value === null ||
    !("data" in value) ||
    typeof value.data !== "object" ||
    value.data === null
  ) {
    return false;
  }
  return (
    "id" in value.data &&
    typeof value.data.id === "string" &&
    "email" in value.data &&
    typeof value.data.email === "string" &&
    "instanceRole" in value.data &&
    (value.data.instanceRole === null ||
      value.data.instanceRole === "INSTANCE_ADMIN")
  );
}

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        cache: "no-store",
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? "Demasiados intentos. Espera antes de volver a intentarlo."
            : "No se pudo iniciar sesión. Revisa tus credenciales.",
        );
        setPending(false);
        return;
      }
      const payload: unknown = await response.json();
      if (!isLoginResponse(payload)) {
        setError("El servicio devolvió una respuesta no válida.");
        setPending(false);
        return;
      }
      window.location.assign("/investigation");
    } catch {
      setError("El servicio de autenticación no está disponible.");
      setPending(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <a href="/" className="login-brand">SENTINELOPS AI</a>
        <h1>Iniciar sesión</h1>
        <p>Accede a los workspaces y proyectos autorizados.</p>
        <label htmlFor="login-email">Correo electrónico</label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          required
          maxLength={320}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor="login-password">Contraseña</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          minLength={12}
          maxLength={1024}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={pending}>
          {pending ? "Validando..." : "Entrar"}
        </button>
        <p>
          Para la primera cuenta, sigue el procedimiento de bootstrap local
          documentado para esta instalación.
        </p>
      </form>
    </main>
  );
}
