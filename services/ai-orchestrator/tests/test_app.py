"""Tests for the SentinelOps AI orchestrator API."""

from collections.abc import AsyncIterator

import pytest
from fastapi.testclient import TestClient

from sentinelops_ai_orchestrator.app import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    EmbeddingProviderRequestError,
    LocalModelResponseError,
    LocalModelTimeout,
    LocalModelUnavailable,
    app,
    get_embedding_generator,
    get_local_chat_generator,
)


client = TestClient(app)


@pytest.fixture(autouse=True)
def clear_dependency_overrides() -> AsyncIterator[None]:
    """Ensure one test's dependency overrides do not affect another."""
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def test_health_endpoint_returns_expected_payload() -> None:
    """The health endpoint must return the documented response."""
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "sentinelops-ai-orchestrator",
    }


def test_openapi_documentation_contains_health_endpoint() -> None:
    """The OpenAPI document must include the health route."""
    response = client.get("/openapi.json")

    assert response.status_code == 200

    openapi_document = response.json()
    assert "/health" in openapi_document["paths"]
    assert "get" in openapi_document["paths"]["/health"]


def test_openapi_documentation_contains_embeddings_endpoint() -> None:
    """The OpenAPI document must include the embeddings route."""
    response = client.get("/openapi.json")

    assert response.status_code == 200

    openapi_document = response.json()
    assert "/embeddings" in openapi_document["paths"]
    assert "post" in openapi_document["paths"]["/embeddings"]


def test_embeddings_returns_vectors_for_each_text() -> None:
    """Embedding generation can be tested without contacting OpenAI."""

    async def fake_generator(
        texts: list[str],
    ) -> tuple[str, list[list[float]]]:
        vectors = [
            [float(index + 1)] * EMBEDDING_DIMENSIONS
            for index, _ in enumerate(texts)
        ]
        return EMBEDDING_MODEL, vectors

    app.dependency_overrides[get_embedding_generator] = (
        lambda: fake_generator
    )

    response = client.post(
        "/embeddings",
        json={
            "texts": [
                "La API presenta latencia elevada.",
                "El servicio de autenticación no responde.",
            ]
        },
    )

    assert response.status_code == 200

    payload = response.json()
    assert payload["model"] == EMBEDDING_MODEL
    assert payload["dimensions"] == EMBEDDING_DIMENSIONS
    assert len(payload["data"]) == 2
    assert payload["data"][0]["index"] == 0
    assert payload["data"][1]["index"] == 1
    assert len(payload["data"][0]["embedding"]) == EMBEDDING_DIMENSIONS
    assert len(payload["data"][1]["embedding"]) == EMBEDDING_DIMENSIONS


def test_embeddings_rejects_empty_text_list() -> None:
    """At least one text is required."""
    response = client.post("/embeddings", json={"texts": []})

    assert response.status_code == 422


def test_embeddings_rejects_blank_text() -> None:
    """Blank input should be rejected before invoking the provider."""
    response = client.post("/embeddings", json={"texts": ["   "]})

    assert response.status_code == 422


def test_embeddings_returns_503_without_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Missing provider configuration must produce a safe error."""
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    response = client.post(
        "/embeddings",
        json={"texts": ["Test de configuración"]},
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Embedding provider is not configured."
    }


def test_embeddings_returns_502_when_provider_fails() -> None:
    """Provider failures must not expose internal error details."""

    async def failing_generator(
        texts: list[str],
    ) -> tuple[str, list[list[float]]]:
        raise EmbeddingProviderRequestError("internal test detail")

    app.dependency_overrides[get_embedding_generator] = (
        lambda: failing_generator
    )

    response = client.post(
        "/embeddings",
        json={"texts": ["Texto de prueba"]},
    )

    assert response.status_code == 502
    assert response.json() == {
        "detail": "Embedding provider request failed."
    }


def test_openapi_documentation_contains_chat_endpoint() -> None:
    """The OpenAPI document must include the local chat route."""
    response = client.get("/openapi.json")

    assert response.status_code == 200

    openapi_document = response.json()
    assert "/chat" in openapi_document["paths"]
    assert "post" in openapi_document["paths"]["/chat"]


def test_chat_returns_response_from_local_model() -> None:
    """Chat generation can be tested without running Ollama."""

    async def fake_generator(prompt: str) -> tuple[str, str]:
        assert prompt == "Investiga un error HTTP 503."
        return "qwen3.5:4b", "Revisaría primero los logs."

    app.dependency_overrides[get_local_chat_generator] = (
        lambda: fake_generator
    )

    response = client.post(
        "/chat",
        json={"prompt": "Investiga un error HTTP 503."},
    )

    assert response.status_code == 200
    assert response.json() == {
        "model": "qwen3.5:4b",
        "response": "Revisaría primero los logs.",
    }


def test_chat_rejects_blank_prompt() -> None:
    """Blank prompts must be rejected before invoking Ollama."""
    response = client.post("/chat", json={"prompt": "   "})

    assert response.status_code == 422


def test_chat_returns_503_when_local_model_is_unavailable() -> None:
    """Connection failures must not expose internal details."""

    async def unavailable_generator(prompt: str) -> tuple[str, str]:
        raise LocalModelUnavailable

    app.dependency_overrides[get_local_chat_generator] = (
        lambda: unavailable_generator
    )

    response = client.post(
        "/chat",
        json={"prompt": "Investiga un error HTTP 503."},
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Local model service is unavailable."
    }


def test_chat_returns_504_when_local_model_times_out() -> None:
    """Model timeouts must be returned as gateway timeouts."""

    async def timeout_generator(prompt: str) -> tuple[str, str]:
        raise LocalModelTimeout

    app.dependency_overrides[get_local_chat_generator] = (
        lambda: timeout_generator
    )

    response = client.post(
        "/chat",
        json={"prompt": "Investiga un error HTTP 503."},
    )

    assert response.status_code == 504
    assert response.json() == {
        "detail": "Local model request timed out."
    }


def test_chat_returns_502_for_invalid_model_response() -> None:
    """Invalid model responses must not leak provider details."""

    async def invalid_generator(prompt: str) -> tuple[str, str]:
        raise LocalModelResponseError

    app.dependency_overrides[get_local_chat_generator] = (
        lambda: invalid_generator
    )

    response = client.post(
        "/chat",
        json={"prompt": "Investiga un error HTTP 503."},
    )

    assert response.status_code == 502
    assert response.json() == {
        "detail": "Local model returned an invalid response."
    }