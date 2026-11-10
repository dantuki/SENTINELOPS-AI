"""Tests for the SentinelOps AI orchestrator API."""

import asyncio
from collections.abc import AsyncIterator
import json
from pathlib import Path
from typing import Literal

import httpx
import pytest
from fastapi.testclient import TestClient

import sentinelops_ai_orchestrator.app as orchestrator
from sentinelops_ai_orchestrator.app import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    INVESTIGATION_ANALYSIS_SCHEMA,
    EmbeddingProviderRequestError,
    EmbeddingProviderTimeout,
    EmbeddingProviderUnavailable,
    LocalModelResponseError,
    LocalModelTimeout,
    LocalModelUnavailable,
    app,
    get_embedding_generator,
    get_local_chat_generator,
    get_model_readiness_checker,
)


client = TestClient(app)

def test_investigation_schema_matches_the_shared_contract() -> None:
    schema_path = (
        Path(__file__).resolve().parents[3]
        / "packages"
        / "shared-contracts"
        / "schemas"
        / "investigation-analysis.schema.json"
    )
    shared_schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert INVESTIGATION_ANALYSIS_SCHEMA == shared_schema


class FakeOllamaResponse:
    """Mock response returned by the Ollama HTTP API."""

    def __init__(self, payload: object) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self.payload


class FakeOllamaAsyncClient:
    """Mock asynchronous HTTP client used by unit tests."""

    def __init__(
        self,
        response: FakeOllamaResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        self.response = response
        self.error = error
        self.request_url = ""
        self.request_json: dict[str, object] = {}
        self.timeout: float | None = None

    async def __aenter__(self) -> "FakeOllamaAsyncClient":
        return self

    async def __aexit__(
        self,
        exc_type: object,
        exc_value: object,
        traceback: object,
    ) -> None:
        return None

    async def post(
        self,
        url: str,
        *,
        json: dict[str, object],
    ) -> FakeOllamaResponse:
        self.request_url = url
        self.request_json = json

        if self.error is not None:
            raise self.error

        if self.response is None:
            raise AssertionError("A mock response was not configured.")

        return self.response


@pytest.fixture(autouse=True)
def clear_dependency_overrides(
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[None]:
    """Ensure one test's dependency overrides do not affect another."""
    monkeypatch.setenv("SENTINELOPS_ENV", "development")
    monkeypatch.delenv("AI_ORCHESTRATOR_API_KEY", raising=False)
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


def test_health_endpoint_returns_expected_payload() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "sentinelops-ai-orchestrator",
    }


def test_readiness_endpoint_requires_both_local_models() -> None:
    async def loaded_models() -> set[str]:
        return {EMBEDDING_MODEL, "qwen3.5:4b"}

    app.dependency_overrides[get_model_readiness_checker] = (
        lambda: loaded_models
    )

    response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "sentinelops-ai-orchestrator",
    }


def test_readiness_endpoint_returns_503_when_a_model_is_not_loaded() -> None:
    async def loaded_models() -> set[str]:
        return {EMBEDDING_MODEL}

    app.dependency_overrides[get_model_readiness_checker] = (
        lambda: loaded_models
    )

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Required local models are not loaded."
    }


def test_internal_service_routes_reject_missing_service_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_ORCHESTRATOR_API_KEY", "a" * 32)

    response = client.post(
        "/chat",
        json={"prompt": "status"},
    )

    assert response.status_code == 401


def test_internal_service_routes_require_an_explicit_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("SENTINELOPS_ENV", raising=False)

    response = client.post("/warmup")

    assert response.status_code == 503


def test_internal_service_routes_reject_short_configured_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AI_ORCHESTRATOR_API_KEY", "too-short")

    response = client.post(
        "/chat",
        json={"prompt": "status"},
        headers={"Authorization": "Bearer too-short"},
    )

    assert response.status_code == 503


def test_warmup_loads_and_verifies_both_configured_models(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def embeddings(
        texts: list[str],
    ) -> tuple[str, list[list[float]]]:
        calls.append("embeddings")
        assert texts == ["SentinelOps model warm-up."]
        return EMBEDDING_MODEL, [[0.0] * EMBEDDING_DIMENSIONS]

    async def chat(
        prompt: str,
        max_tokens: int,
        response_format: Literal["text", "json"],
        response_schema: dict[str, object] | None = None,
    ) -> tuple[str, str]:
        calls.append("chat")
        assert prompt == "Responde solo con la palabra listo."
        assert max_tokens == 8
        assert response_format == "text"
        assert response_schema is None
        return "qwen3.5:4b", "listo"

    async def loaded_models() -> set[str]:
        return {EMBEDDING_MODEL, "qwen3.5:4b"}

    monkeypatch.setenv("OLLAMA_CHAT_MODEL", "qwen3.5:4b")
    monkeypatch.setenv("OLLAMA_EMBEDDING_MODEL", EMBEDDING_MODEL)
    app.dependency_overrides[get_embedding_generator] = (
        lambda: embeddings
    )
    app.dependency_overrides[get_local_chat_generator] = lambda: chat
    app.dependency_overrides[get_model_readiness_checker] = (
        lambda: loaded_models
    )

    response = client.post("/warmup")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "sentinelops-ai-orchestrator",
    }
    assert calls == ["embeddings", "chat"]


def test_warmup_preserves_model_timeout_errors() -> None:
    async def embeddings(
        texts: list[str],
    ) -> tuple[str, list[list[float]]]:
        return EMBEDDING_MODEL, [[0.0] * EMBEDDING_DIMENSIONS]

    async def chat(
        prompt: str,
        max_tokens: int,
        response_format: Literal["text", "json"],
        response_schema: dict[str, object] | None = None,
    ) -> tuple[str, str]:
        raise LocalModelTimeout

    app.dependency_overrides[get_embedding_generator] = (
        lambda: embeddings
    )
    app.dependency_overrides[get_local_chat_generator] = lambda: chat

    response = client.post("/warmup")

    assert response.status_code == 504
    assert response.json() == {
        "detail": "Local model request timed out."
    }


def test_openapi_contains_health_embeddings_and_chat() -> None:
    response = client.get("/openapi.json")

    assert response.status_code == 200

    paths = response.json()["paths"]

    assert "get" in paths["/health"]
    assert "get" in paths["/ready"]
    assert "post" in paths["/embeddings"]
    assert "post" in paths["/chat"]
    assert "post" in paths["/warmup"]


def test_generate_embeddings_uses_local_ollama(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    texts = [
        "La API presenta latencia elevada.",
        "El servicio de autenticación no responde.",
    ]

    expected_vectors = [
        [0.1] * EMBEDDING_DIMENSIONS,
        [0.2] * EMBEDDING_DIMENSIONS,
    ]

    mock_client = FakeOllamaAsyncClient(
        response=FakeOllamaResponse(
            {
                "model": EMBEDDING_MODEL,
                "embeddings": expected_vectors,
            }
        )
    )

    def fake_client_factory(
        *,
        timeout: float,
    ) -> FakeOllamaAsyncClient:
        mock_client.timeout = timeout
        return mock_client

    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        fake_client_factory,
    )
    monkeypatch.setenv(
        "OLLAMA_BASE_URL",
        "http://127.0.0.1:11434/",
    )
    monkeypatch.setenv(
        "OLLAMA_EMBEDDING_MODEL",
        EMBEDDING_MODEL,
    )

    model, vectors = asyncio.run(
        orchestrator.generate_embeddings(texts)
    )

    assert model == EMBEDDING_MODEL
    assert vectors == expected_vectors
    assert mock_client.request_url == (
        "http://127.0.0.1:11434/api/embed"
    )
    assert mock_client.request_json == {
        "model": EMBEDDING_MODEL,
        "input": texts,
    }
    assert mock_client.timeout == 30.0


def test_generate_embeddings_rejects_wrong_dimensions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_client = FakeOllamaAsyncClient(
        response=FakeOllamaResponse(
            {
                "model": EMBEDDING_MODEL,
                "embeddings": [[0.1, 0.2, 0.3]],
            }
        )
    )

    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        lambda **kwargs: mock_client,
    )

    with pytest.raises(EmbeddingProviderRequestError):
        asyncio.run(
            orchestrator.generate_embeddings(["Texto de prueba"])
        )


def test_generate_embeddings_rejects_non_finite_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invalid_vector = [0.1] * EMBEDDING_DIMENSIONS
    invalid_vector[0] = float("nan")

    mock_client = FakeOllamaAsyncClient(
        response=FakeOllamaResponse(
            {
                "model": EMBEDDING_MODEL,
                "embeddings": [invalid_vector],
            }
        )
    )

    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        lambda **kwargs: mock_client,
    )

    with pytest.raises(EmbeddingProviderRequestError):
        asyncio.run(
            orchestrator.generate_embeddings(["Texto de prueba"])
        )


def test_generate_embeddings_maps_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_client = FakeOllamaAsyncClient(
        error=httpx.TimeoutException("simulated timeout")
    )

    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        lambda **kwargs: mock_client,
    )

    with pytest.raises(EmbeddingProviderTimeout):
        asyncio.run(
            orchestrator.generate_embeddings(["Texto de prueba"])
        )


def test_generate_embeddings_maps_connection_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_client = FakeOllamaAsyncClient(
        error=httpx.ConnectError("simulated connection failure")
    )

    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        lambda **kwargs: mock_client,
    )

    with pytest.raises(EmbeddingProviderUnavailable):
        asyncio.run(
            orchestrator.generate_embeddings(["Texto de prueba"])
        )


def test_embeddings_returns_vectors_for_each_text() -> None:
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
    assert (
        len(payload["data"][0]["embedding"])
        == EMBEDDING_DIMENSIONS
    )
    assert (
        len(payload["data"][1]["embedding"])
        == EMBEDDING_DIMENSIONS
    )


def test_embeddings_rejects_empty_text_list() -> None:
    response = client.post("/embeddings", json={"texts": []})

    assert response.status_code == 422


def test_embeddings_rejects_blank_text() -> None:
    response = client.post(
        "/embeddings",
        json={"texts": ["   "]},
    )

    assert response.status_code == 422


def test_embeddings_returns_503_when_ollama_is_unavailable() -> None:
    async def unavailable_generator(
        texts: list[str],
    ) -> tuple[str, list[list[float]]]:
        raise EmbeddingProviderUnavailable

    app.dependency_overrides[get_embedding_generator] = (
        lambda: unavailable_generator
    )

    response = client.post(
        "/embeddings",
        json={"texts": ["Texto de prueba"]},
    )

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Local embedding model service is unavailable."
    }


def test_embeddings_returns_504_when_ollama_times_out() -> None:
    async def timeout_generator(
        texts: list[str],
    ) -> tuple[str, list[list[float]]]:
        raise EmbeddingProviderTimeout

    app.dependency_overrides[get_embedding_generator] = (
        lambda: timeout_generator
    )

    response = client.post(
        "/embeddings",
        json={"texts": ["Texto de prueba"]},
    )

    assert response.status_code == 504
    assert response.json() == {
        "detail": "Local embedding model request timed out."
    }


def test_embeddings_returns_502_when_provider_fails() -> None:
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
        "detail": "Local embedding model returned an invalid response."
    }


def test_embeddings_rejects_invalid_generator_contract() -> None:
    async def invalid_generator(
        texts: list[str],
    ) -> tuple[str, list[list[float]]]:
        return EMBEDDING_MODEL, [[0.1, 0.2]]

    app.dependency_overrides[get_embedding_generator] = (
        lambda: invalid_generator
    )

    response = client.post(
        "/embeddings",
        json={"texts": ["Texto de prueba"]},
    )

    assert response.status_code == 502


def test_chat_returns_response_from_local_model() -> None:
    async def fake_generator(
        prompt: str,
        max_tokens: int,
        response_format: Literal["text", "json"],
        response_schema: dict[str, object] | None = None,
    ) -> tuple[str, str]:
        assert prompt == "Investiga un error HTTP 503."
        assert max_tokens == 1536
        assert response_format == "text"
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


def test_chat_forwards_a_bounded_token_budget() -> None:
    async def fake_generator(
        prompt: str,
        max_tokens: int,
        response_format: Literal["text", "json"],
        response_schema: dict[str, object] | None = None,
    ) -> tuple[str, str]:
        assert prompt == "Investiga INC-001."
        assert max_tokens == 320
        assert response_format == "json"
        assert response_schema == {"type": "object", "required": ["answer"]}
        return "qwen3.5:4b", "Respuesta concisa."

    app.dependency_overrides[get_local_chat_generator] = (
        lambda: fake_generator
    )

    response = client.post(
        "/chat",
        json={
            "prompt": "Investiga INC-001.",
            "max_tokens": 320,
            "response_format": "json",
            "response_schema": {"type": "object", "required": ["answer"]},
        },
    )

    assert response.status_code == 200
    assert response.json()["response"] == "Respuesta concisa."


def test_generate_local_chat_rejects_a_token_limited_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_client = FakeOllamaAsyncClient(
        response=FakeOllamaResponse(
            {
                "model": "qwen3.5:4b",
                "message": {"content": "Respuesta incompleta"},
                "done": True,
                "done_reason": "length",
                "eval_count": 1024,
            }
        )
    )

    def fake_client_factory(*, timeout: float) -> FakeOllamaAsyncClient:
        mock_client.timeout = timeout
        return mock_client

    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        fake_client_factory,
    )

    with pytest.raises(LocalModelResponseError):
        asyncio.run(
            orchestrator.generate_local_chat(
                "Investiga INC-001.",
                max_tokens=1024,
            )
        )

    assert mock_client.request_json["options"] == {
        "num_predict": 1024,
        "temperature": 0.1,
    }
    assert "format" not in mock_client.request_json


def test_generate_local_chat_requests_json_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_client = FakeOllamaAsyncClient(
        response=FakeOllamaResponse(
            {
                "model": "qwen3.5:4b",
                "message": {"content": '{"summary":"Evidencia."}'},
                "done": True,
            }
        )
    )
    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        lambda *, timeout: mock_client,
    )

    model, response = asyncio.run(
        orchestrator.generate_local_chat(
            "Devuelve JSON.",
            response_format="json",
        )
    )

    assert model == "qwen3.5:4b"
    assert response == '{"summary":"Evidencia."}'
    assert mock_client.request_json["format"] == "json"


def test_generate_local_chat_uses_a_bounded_configured_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_client = FakeOllamaAsyncClient(
        response=FakeOllamaResponse(
            {
                "model": "qwen3.5:4b",
                "message": {"content": "Respuesta."},
                "done": True,
            }
        )
    )
    monkeypatch.setenv("OLLAMA_CHAT_TIMEOUT_SECONDS", "300")

    def fake_client_factory(*, timeout: float) -> FakeOllamaAsyncClient:
        mock_client.timeout = timeout
        return mock_client

    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        fake_client_factory,
    )

    asyncio.run(orchestrator.generate_local_chat("Investiga INC-001."))

    assert mock_client.timeout == 300.0


def test_generate_local_chat_forwards_the_investigation_schema(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    mock_client = FakeOllamaAsyncClient(
        response=FakeOllamaResponse(
            {
                "model": "qwen3.5:4b",
                "message": {"content": '{"summary":"Evidencia."}'},
                "done": True,
            }
        )
    )
    monkeypatch.setattr(
        orchestrator.httpx,
        "AsyncClient",
        lambda *, timeout: mock_client,
    )

    asyncio.run(
        orchestrator.generate_local_chat(
            "Devuelve una investigación.",
            response_format="json",
            response_schema=INVESTIGATION_ANALYSIS_SCHEMA,
        )
    )

    assert mock_client.request_json["format"] == INVESTIGATION_ANALYSIS_SCHEMA


def test_chat_rejects_blank_prompt() -> None:
    response = client.post(
        "/chat",
        json={"prompt": "   "},
    )

    assert response.status_code == 422


def test_chat_rejects_token_budgets_above_the_existing_cap() -> None:
    response = client.post(
        "/chat",
        json={"prompt": "Investiga INC-001.", "max_tokens": 1537},
    )

    assert response.status_code == 422


def test_chat_rejects_a_schema_outside_json_mode() -> None:
    response = client.post(
        "/chat",
        json={
            "prompt": "status",
            "response_format": "text",
            "response_schema": {"type": "object"},
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": "A response schema requires JSON response format."
    }


def test_chat_rejects_an_oversized_response_schema() -> None:
    response = client.post(
        "/chat",
        json={
            "prompt": "status",
            "response_format": "json",
            "response_schema": {"description": "x" * 17_000},
        },
    )

    assert response.status_code == 422


def test_chat_returns_503_when_local_model_is_unavailable() -> None:
    async def unavailable_generator(
        prompt: str,
        max_tokens: int,
        response_format: Literal["text", "json"],
        response_schema: dict[str, object] | None = None,
    ) -> tuple[str, str]:
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
    async def timeout_generator(
        prompt: str,
        max_tokens: int,
        response_format: Literal["text", "json"],
        response_schema: dict[str, object] | None = None,
    ) -> tuple[str, str]:
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
    async def invalid_generator(
        prompt: str,
        max_tokens: int,
        response_format: Literal["text", "json"],
        response_schema: dict[str, object] | None = None,
    ) -> tuple[str, str]:
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
