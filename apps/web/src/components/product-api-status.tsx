"use client";

import { useEffect, useState } from "react";

type ApiStatus = "checking" | "online" | "offline";

type AiStatus =
  | "checking"
  | "online"
  | "offline"
  | "unknown";

type StatusPayload = {
  status: "ok";
  service: "sentinelops-product-api";
  dependencies?: unknown;
};

function isOnlinePayload(
  value: unknown,
): value is StatusPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "service" in value &&
    value.status === "ok" &&
    value.service === "sentinelops-product-api"
  );
}

function getAiStatus(value: unknown): AiStatus {
  if (
    typeof value !== "object" ||
    value === null ||
    !("dependencies" in value)
  ) {
    return "unknown";
  }

  const dependencies = value.dependencies;

  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    !("aiOrchestrator" in dependencies)
  ) {
    return "unknown";
  }

  const aiOrchestrator = dependencies.aiOrchestrator;

  if (
    typeof aiOrchestrator !== "object" ||
    aiOrchestrator === null ||
    !("status" in aiOrchestrator)
  ) {
    return "unknown";
  }

  if (aiOrchestrator.status === "ok") {
    return "online";
  }

  if (aiOrchestrator.status === "unavailable") {
    return "offline";
  }

  return "unknown";
}

export function ProductApiStatus() {
  const [apiStatus, setApiStatus] =
    useState<ApiStatus>("checking");

  const [aiStatus, setAiStatus] =
    useState<AiStatus>("checking");

  useEffect(() => {
    let active = true;

    async function checkServiceStatus() {
      try {
        const response = await fetch("/api/service-status", {
          cache: "no-store",
        });

        let payload: unknown;

        try {
          payload = await response.json();
        } catch {
          payload = null;
        }

        if (!active) {
          return;
        }

        if (!response.ok || !isOnlinePayload(payload)) {
          setApiStatus("offline");
          setAiStatus("unknown");
          return;
        }

        setApiStatus("online");
        setAiStatus(getAiStatus(payload));
      } catch {
        if (active) {
          setApiStatus("offline");
          setAiStatus("unknown");
        }
      }
    }

    void checkServiceStatus();

    const intervalId = window.setInterval(() => {
      void checkServiceStatus();
    }, 30_000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const apiLabels: Record<ApiStatus, string> = {
    checking: "Comprobando API",
    online: "API disponible",
    offline: "API no disponible",
  };

  const aiLabels: Record<AiStatus, string> = {
    checking: "Comprobando IA",
    online: "Orquestador IA disponible",
    offline: "Orquestador IA no disponible",
    unknown: "IA sin verificar",
  };

  const aiVisualStatus =
    aiStatus === "unknown" ? "checking" : aiStatus;

  const apiDotClass =
    apiStatus === "online"
      ? ""
      : `status-dot--${apiStatus}`;

  const aiDotClass =
    aiVisualStatus === "online"
      ? ""
      : `status-dot--${aiVisualStatus}`;

  return (
    <div
      className="service-status-group"
      role="group"
      aria-label="Estado de los servicios"
    >
      <span
        className={`environment-tag environment-tag--${apiStatus}`}
        role="status"
        aria-live="polite"
      >
        <span
          className={`status-dot ${apiDotClass}`}
          aria-hidden="true"
        />
        {apiLabels[apiStatus]}
      </span>

      <span
        className={`environment-tag environment-tag--${aiVisualStatus}`}
        role="status"
        aria-live="polite"
      >
        <span
          className={`status-dot ${aiDotClass}`}
          aria-hidden="true"
        />
        {aiLabels[aiStatus]}
      </span>
    </div>
  );
}