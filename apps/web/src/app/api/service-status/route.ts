
import { NextResponse } from "next/server";

const PRODUCT_API_URL =
  process.env.PRODUCT_API_URL ?? "http://127.0.0.1:3001";

const SERVICE_NAME = "sentinelops-product-api";

type ProductApiHealth = {
  status: "ok";
  service: typeof SERVICE_NAME;
};

function isProductApiHealth(value: unknown): value is ProductApiHealth {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    "status" in value &&
    "service" in value &&
    value.status === "ok" &&
    value.service === SERVICE_NAME
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
    const upstreamUrl = new URL("/health", PRODUCT_API_URL);

    const upstream = await fetch(upstreamUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });

    if (!upstream.ok) {
      return unavailable(503);
    }

    let payload: unknown;

    try {
      payload = await upstream.json();
    } catch {
      return unavailable(502);
    }

    if (!isProductApiHealth(payload)) {
      return unavailable(502);
    }

    return NextResponse.json(
      {
        status: "ok",
        service: payload.service,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch {
    // Do not expose internal URLs or exception details to the browser.
    return unavailable(503);
  }
}
