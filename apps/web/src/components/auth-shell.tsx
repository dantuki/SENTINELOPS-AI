"use client";

import { useEffect, useState, type ReactNode } from "react";

import { loginPathFor } from "@/lib/auth-redirect";

export function AuthShell({
  email,
  children,
}: {
  email: string;
  children: ReactNode;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetch("/api/auth/refresh", {
        method: "POST",
        cache: "no-store",
      }).then((response) => {
        if (response.status === 401) {
          window.location.replace(loginPathFor(window.location.pathname));
          return;
        }
        setError(
          response.ok
            ? ""
            : "No se pudo renovar la sesión. Cierra sesión y vuelve a entrar.",
        );
      }).catch(() => {
        setError("No se pudo contactar el servicio para renovar la sesión.");
      });
    }, 6 * 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const reloadPersistedPage = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", reloadPersistedPage);
    return () => window.removeEventListener("pageshow", reloadPersistedPage);
  }, []);

  async function logout() {
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        setError("No se pudo cerrar la sesión. Inténtalo de nuevo.");
        setPending(false);
        return;
      }
      window.location.replace("/login");
    } catch {
      setError("No se pudo cerrar la sesión. Inténtalo de nuevo.");
      setPending(false);
    }
  }

  return (
    <>
      <header className="auth-header">
        <a href="/" aria-label="SentinelOps AI, inicio">
          SENTINELOPS AI
        </a>
        <nav className="auth-nav" aria-label="Navegación autenticada">
          <a href="/qa">QA Workspace</a>
          <a href="/knowledge-base">Fuentes técnicas</a>
          <a href="/investigation">Investigación avanzada</a>
        </nav>
        <div>
          <span>{email}</span>
          <button type="button" onClick={() => void logout()} disabled={pending}>
            {pending ? "Cerrando..." : "Cerrar sesión"}
          </button>
        </div>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      {children}
    </>
  );
}
