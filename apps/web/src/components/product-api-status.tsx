
"use client";

import { useEffect, useState } from "react";

type ApiStatus = "checking" | "online" | "offline";

type StatusPayload = {
  status: string;
};

function isOnlinePayload(value: unknown): value is StatusPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ok"
  );
}

export function ProductApiStatus() {
  const [status, setStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let active = true;

    async function checkApiStatus() {
      try {
        const response = await fetch("/api/service-status", {
          cache: "no-store",
        });

        const payload: unknown = await response.json();

        if (active) {
          setStatus(
            response.ok && isOnlinePayload(payload) ? "online" : "offline",
          );
        }
      } catch {
        if (active) {
          setStatus("offline");
        }
      }
    }

    void checkApiStatus();

    const intervalId = window.setInterval(() => {
      void checkApiStatus();
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const labels: Record<ApiStatus, string> = {
    checking: "Comprobando API",
    online: "API disponible",
    offline: "API no disponible",
  };

  const dotClass =
    status === "online" ? "" : `status-dot--${status}`;

  return (
    <span
      className={`environment-tag environment-tag--${status}`}
      role="status"
      aria-live="polite"
    >
      <span
        className={`status-dot ${dotClass}`}
        aria-hidden="true"
      />
      {labels[status]}
    </span>
  );
}
