
"""Tests for the SentinelOps AI orchestrator API."""

from fastapi.testclient import TestClient

from sentinelops_ai_orchestrator.app import app


client = TestClient(app)


def test_health_endpoint_returns_expected_payload() -> None:
    """The health endpoint must return the documented response."""
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "sentinelops-ai-orchestrator",
    }


def test_openapi_documentation_contains_health_endpoint() -> None:
    """The generated OpenAPI document must include the health route."""
    response = client.get("/openapi.json")

    assert response.status_code == 200

    openapi_document = response.json()
    assert "/health" in openapi_document["paths"]
    assert "get" in openapi_document["paths"]["/health"]
