
"""FastAPI application for the SentinelOps AI orchestrator."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Response schema for the service liveness endpoint."""

    status: Literal["ok"]
    service: str


app = FastAPI(
    title="SentinelOps AI Orchestrator",
    description=(
        "Internal API for incident investigation workflows "
        "in SentinelOps AI."
    ),
    version="0.1.0",
)


@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["Health"],
    summary="Check whether the service process is responding",
)
def health_check() -> HealthResponse:
    """Return the process liveness status.

    This endpoint does not verify PostgreSQL, MCP, or model-provider health.
    """
    return HealthResponse(
        status="ok",
        service="sentinelops-ai-orchestrator",
    )
