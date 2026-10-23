import { NextResponse } from "next/server";

const PRODUCT_API_URL =
  process.env.PRODUCT_API_URL ?? "http://127.0.0.1:3001";

const SERVICE_NAME = "sentinelops-product-api";
const AI_ORCHESTRATOR_NAME = "sentinelops-ai-orchestrator";

type ProductApiHealth = {
  status: "ok";
  service: typeof SERVICE_NAME;
};

type AiDependencyHealth = {
  status: "ok";
  service: typeof SERVICE_NAME;
  dependency: {
    name: typeof AI_ORCHESTRATOR_NAME;
    status: "ok";
  };
};

type AiOrchestratorStatus = "ok" | "unavailable";

function isProductApiHealth(
  value: unknown,
): value is ProductApiHealth {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "service" in value &&
    value.status === "ok" &&
    value.service === SERVICE_NAME
  );
}

function isAiDependencyHealth(
  value: unknown,
): value is AiDependencyHealth {
  if (
    typeof value !== "object" ||
    value === null ||
    !("dependency" in value)
  ) {
    return false;
  }

  const dependency = value.dependency;

  if (
    typeof dependency !== "object" ||
    dependency === null
  ) {
    return false;
  }

  return (
    "status" in value &&
    "service" in value &&
    value.status === "ok" &&
    value.service === SERVICE_NAME &&
    "name" in dependency &&
    "status" in dependency &&
    dependency.name === AI_ORCHESTRATOR_NAME &&
    dependency.status === "ok"
  );
}

function unavailable(statusCode = 503) {
  return NextResponse.json(
    {
      status: "unavailable",
      service: SERVICE_NAME,
    },
    {
      status: statusCode,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function GET() {
  try {
    // First, check whether the product API itself is healthy.
    const healthUrl = new URL("/health", PRODUCT_API_URL);

    const healthResponse = await fetch(healthUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });

    if (!healthResponse.ok) {
      return unavailable(503);
    }

    let healthPayload: unknown;

    try {
      healthPayload = await healthResponse.json();
    } catch {
      return unavailable(502);
    }

    if (!isProductApiHealth(healthPayload)) {
      return unavailable(502);
    }

    // Next, check the AI dependency independently.
    // Its failure must not make the product API appear offline.
    let aiStatus: AiOrchestratorStatus = "unavailable";

    try {
      const dependencyUrl = new URL(
        "/health/dependencies/ai",
        PRODUCT_API_URL,
      );

      const dependencyResponse = await fetch(dependencyUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      });

      if (dependencyResponse.ok) {
        let dependencyPayload: unknown;

        try {
          dependencyPayload = await dependencyResponse.json();
        } catch {
          dependencyPayload = null;
        }

        if (isAiDependencyHealth(dependencyPayload)) {
          aiStatus = "ok";
        }
      }
    } catch {
      // Keep the product API healthy while reporting the
      // dependency as unavailable or unverifiable.
      aiStatus = "unavailable";
    }

    return NextResponse.json(
      {
        status: "ok",
        service: healthPayload.service,
        dependencies: {
          aiOrchestrator: {
            service: AI_ORCHESTRATOR_NAME,
            status: aiStatus,
          },
        },
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    // Do not expose internal URLs or exception details.
    return unavailable(503);
  }
}