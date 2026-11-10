"""FastAPI application for the SentinelOps AI orchestrator."""

import json
import logging
import math
import os
import secrets
import time
from collections.abc import Awaitable, Callable
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator


# Embeddings locales mediante Ollama.
EMBEDDING_MODEL = "qwen3-embedding:0.6b"
EMBEDDING_DIMENSIONS = 1024
MAX_BATCH_SIZE = 32
MAX_TEXT_CHARS = 20_000
EMBEDDING_TIMEOUT_SECONDS = 30.0
DEFAULT_CHAT_TIMEOUT_SECONDS = 90.0
MAX_CHAT_TIMEOUT_SECONDS = 300.0


def get_chat_timeout_seconds() -> float:
    """Read a bounded per-process chat timeout without changing the default."""
    configured = os.environ.get("OLLAMA_CHAT_TIMEOUT_SECONDS")
    if configured is None:
        return DEFAULT_CHAT_TIMEOUT_SECONDS
    try:
        timeout = float(configured)
    except ValueError:
        return DEFAULT_CHAT_TIMEOUT_SECONDS
    return (
        timeout
        if 1.0 <= timeout <= MAX_CHAT_TIMEOUT_SECONDS
        else DEFAULT_CHAT_TIMEOUT_SECONDS
    )

INVESTIGATION_ANALYSIS_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string", "minLength": 1, "maxLength": 2000},
        "summary_evidence_refs": {
            "type": "array",
            "minItems": 1,
            "maxItems": 20,
            "items": {"type": "string", "pattern": "^E[1-9][0-9]*$"},
        },
        "observed_facts": {
            "type": "array",
            "maxItems": 32,
            "items": {
                "type": "object",
                "properties": {
                    "claim": {"type": "string", "minLength": 1, "maxLength": 2000},
                    "evidence_refs": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 20,
                        "items": {"type": "string", "pattern": "^E[1-9][0-9]*$"},
                    },
                },
                "required": ["claim", "evidence_refs"],
                "additionalProperties": False,
            },
        },
        "hypotheses": {
            "type": "array",
            "maxItems": 24,
            "items": {
                "type": "object",
                "properties": {
                    "statement": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 2000,
                    },
                    "status": {
                        "type": "string",
                        "enum": [
                            "supported_unconfirmed",
                            "unverified",
                            "contradicted",
                            "insufficient_evidence",
                        ],
                    },
                    "supporting_evidence": {
                        "type": "array",
                        "maxItems": 20,
                        "items": {"type": "string", "pattern": "^E[1-9][0-9]*$"},
                    },
                    "contradicting_evidence": {
                        "type": "array",
                        "maxItems": 20,
                        "items": {"type": "string", "pattern": "^E[1-9][0-9]*$"},
                    },
                },
                "required": [
                    "statement",
                    "status",
                    "supporting_evidence",
                    "contradicting_evidence",
                ],
                "additionalProperties": False,
            },
        },
        "missing_information": {
            "type": "array",
            "maxItems": 32,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
        "next_checks": {
            "type": "array",
            "maxItems": 32,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
        "limitations": {
            "type": "array",
            "maxItems": 32,
            "items": {"type": "string", "minLength": 1, "maxLength": 1000},
        },
    },
    "required": [
        "summary",
        "summary_evidence_refs",
        "observed_facts",
        "hypotheses",
        "missing_information",
        "next_checks",
        "limitations",
    ],
    "additionalProperties": False,
}

logger = logging.getLogger("uvicorn.error")


def _duration_ms(payload: object, key: str) -> float | None:
    if not isinstance(payload, dict):
        return None

    value = payload.get(key)
    if (
        not isinstance(value, (int, float))
        or isinstance(value, bool)
        or not math.isfinite(value)
        or value < 0
    ):
        return None

    return round(value / 1_000_000, 1)


class HealthResponse(BaseModel):
    """Response schema for the service liveness endpoint."""

    status: Literal["ok"]
    service: str


class EmbeddingRequest(BaseModel):
    """Input texts to convert into vector embeddings."""

    texts: list[str] = Field(
        min_length=1,
        max_length=MAX_BATCH_SIZE,
    )

    @field_validator("texts")
    @classmethod
    def validate_texts(cls, texts: list[str]) -> list[str]:
        """Reject blank or excessively long texts."""
        for text in texts:
            if not text.strip():
                raise ValueError("Texts must not be empty.")

            if len(text) > MAX_TEXT_CHARS:
                raise ValueError(
                    f"Each text must be at most {MAX_TEXT_CHARS} characters."
                )

        return texts


class EmbeddingItem(BaseModel):
    """A vector returned for one input text."""

    index: int
    embedding: list[float] = Field(
        min_length=EMBEDDING_DIMENSIONS,
        max_length=EMBEDDING_DIMENSIONS,
    )


class EmbeddingResponse(BaseModel):
    """Embedding response returned to the product API."""

    model: str
    dimensions: int
    data: list[EmbeddingItem]


class EmbeddingProviderUnavailable(Exception):
    """Raised when the local Ollama service cannot be reached."""


class EmbeddingProviderTimeout(Exception):
    """Raised when the local embedding model exceeds its timeout."""


class EmbeddingProviderRequestError(Exception):
    """Raised when Ollama fails or returns an invalid embedding response."""


EmbeddingGenerator = Callable[
    [list[str]],
    Awaitable[tuple[str, list[list[float]]]],
]


app = FastAPI(
    title="SentinelOps AI Orchestrator",
    description=(
        "Internal API for incident investigation workflows "
        "in SentinelOps AI."
    ),
    version="0.1.0",
)


async def require_internal_service_auth(
    authorization: str | None = Header(default=None),
) -> None:
    """Require the configured API-to-orchestrator bearer secret."""
    environment = os.environ.get("SENTINELOPS_ENV")
    if environment not in {"development", "production"}:
        raise HTTPException(
            status_code=503,
            detail="Internal service environment is not configured.",
        )
    expected = os.environ.get("AI_ORCHESTRATOR_API_KEY")
    if not expected:
        if environment == "production":
            raise HTTPException(
                status_code=503,
                detail="Internal service authentication is unavailable.",
            )
        return
    if len(expected) < 32:
        raise HTTPException(
            status_code=503,
            detail="Internal service authentication is misconfigured.",
        )

    provided = (
        authorization.removeprefix("Bearer ").strip()
        if authorization
        else ""
    )
    if not secrets.compare_digest(provided, expected):
        raise HTTPException(
            status_code=401,
            detail="Internal service authentication failed.",
        )


@app.get(
    "/health",
    response_model=HealthResponse,
    tags=["Health"],
    summary="Check whether the service process is responding",
)
def health_check() -> HealthResponse:
    """Return process liveness, without checking external dependencies."""
    return HealthResponse(
        status="ok",
        service="sentinelops-ai-orchestrator",
    )


async def get_loaded_model_names() -> set[str]:
    """Return the models currently loaded in the local Ollama process."""
    base_url = (
        os.environ.get("OLLAMA_BASE_URL")
        or "http://127.0.0.1:11434"
    ).rstrip("/")

    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            response = await client.get(f"{base_url}/api/ps")
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning(
            "Could not check loaded local models: type=%s",
            type(exc).__name__,
        )
        raise HTTPException(
            status_code=503,
            detail="Local model service is not ready.",
        ) from None

    if not isinstance(payload, dict) or not isinstance(
        payload.get("models"), list
    ):
        logger.error("Local model readiness response is invalid.")
        raise HTTPException(
            status_code=503,
            detail="Local model service returned an invalid readiness response.",
        )

    names: set[str] = set()
    for model in payload["models"]:
        if not isinstance(model, dict):
            continue

        name = model.get("name") or model.get("model")
        if isinstance(name, str) and name.strip():
            names.add(name.strip())

    return names


def get_model_readiness_checker() -> Callable[[], Awaitable[set[str]]]:
    """Dependency hook for local model readiness checks."""
    return get_loaded_model_names


def get_required_model_names() -> set[str]:
    """Return the configured chat and embedding model names."""
    return {
        (
            os.environ.get("OLLAMA_CHAT_MODEL")
            or "qwen3.5:4b"
        ),
        (
            os.environ.get("OLLAMA_EMBEDDING_MODEL")
            or EMBEDDING_MODEL
        ),
    }


@app.get(
    "/ready",
    response_model=HealthResponse,
    tags=["Health"],
    summary="Check whether the required local models are loaded",
)
async def readiness_check(
    loaded_models: Callable[[], Awaitable[set[str]]] = Depends(
        get_model_readiness_checker
    ),
) -> HealthResponse:
    """Report ready only when both configured models are loaded."""
    try:
        loaded = await loaded_models()
    except HTTPException:
        raise

    missing = get_required_model_names() - loaded
    if missing:
        logger.info(
            "Local model service is not ready: missing_models=%s",
            sorted(missing),
        )
        raise HTTPException(
            status_code=503,
            detail="Required local models are not loaded.",
        )

    return HealthResponse(
        status="ok",
        service="sentinelops-ai-orchestrator",
    )


async def generate_embeddings(
    texts: list[str],
) -> tuple[str, list[list[float]]]:
    """Generate validated embeddings through the local Ollama API."""

    base_url = (
        os.environ.get("OLLAMA_BASE_URL")
        or "http://127.0.0.1:11434"
    ).rstrip("/")

    model = (
        os.environ.get("OLLAMA_EMBEDDING_MODEL")
        or EMBEDDING_MODEL
    )
    request_started = time.perf_counter()

    try:
        async with httpx.AsyncClient(
            timeout=EMBEDDING_TIMEOUT_SECONDS,
        ) as client:
            response = await client.post(
                f"{base_url}/api/embed",
                json={
                    "model": model,
                    "input": texts,
                },
            )
            response.raise_for_status()
            payload = response.json()

    except httpx.TimeoutException as exc:
        logger.warning(
            "Local embedding model request timed out: request_ms=%.1f",
            (time.perf_counter() - request_started) * 1000,
        )
        raise EmbeddingProviderTimeout from exc

    except httpx.ConnectError as exc:
        logger.warning(
            "Local Ollama service is unavailable for embeddings."
        )
        raise EmbeddingProviderUnavailable from exc

    except httpx.HTTPError as exc:
        logger.error(
            "Local embedding request failed: type=%s status_code=%s",
            type(exc).__name__,
            getattr(
                getattr(exc, "response", None),
                "status_code",
                None,
            ),
        )
        raise EmbeddingProviderRequestError from exc

    except ValueError as exc:
        logger.error("Local embedding model returned invalid JSON.")
        raise EmbeddingProviderRequestError from exc

    if not isinstance(payload, dict):
        logger.error(
            "Local embedding model returned a non-object response."
        )
        raise EmbeddingProviderRequestError

    returned_model = payload.get("model")
    raw_embeddings = payload.get("embeddings")

    if (
        not isinstance(returned_model, str)
        or not returned_model.strip()
        or not isinstance(raw_embeddings, list)
        or len(raw_embeddings) != len(texts)
    ):
        logger.error(
            "Local embedding response contract is invalid: "
            "expected_items=%s",
            len(texts),
        )
        raise EmbeddingProviderRequestError

    vectors: list[list[float]] = []

    for index, raw_vector in enumerate(raw_embeddings):
        if (
            not isinstance(raw_vector, list)
            or len(raw_vector) != EMBEDDING_DIMENSIONS
        ):
            logger.error(
                "Local embedding vector has invalid dimensions: "
                "item_index=%s expected_dimensions=%s actual_dimensions=%s",
                index,
                EMBEDDING_DIMENSIONS,
                (
                    len(raw_vector)
                    if isinstance(raw_vector, list)
                    else "not-a-list"
                ),
            )
            raise EmbeddingProviderRequestError

        if not all(
            isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(value)
            for value in raw_vector
        ):
            logger.error(
                "Local embedding vector contains invalid values: "
                "item_index=%s",
                index,
            )
            raise EmbeddingProviderRequestError

        vectors.append(
            [float(value) for value in raw_vector]
        )

    logger.info(
        "Local embedding inference completed: model=%s request_ms=%.1f "
        "ollama_total_ms=%s model_load_ms=%s prompt_tokens=%s items=%s",
        returned_model,
        (time.perf_counter() - request_started) * 1000,
        _duration_ms(payload, "total_duration"),
        _duration_ms(payload, "load_duration"),
        (
            payload.get("prompt_eval_count")
            if isinstance(payload, dict)
            else None
        ),
        len(texts),
    )

    return returned_model, vectors


def get_embedding_generator() -> EmbeddingGenerator:
    """Dependency hook that allows the provider to be mocked in tests."""
    return generate_embeddings


@app.post(
    "/embeddings",
    response_model=EmbeddingResponse,
    tags=["Embeddings"],
    summary="Generate local vector embeddings for a batch of texts",
)
async def create_embeddings(
    payload: EmbeddingRequest,
    _service_auth: None = Depends(require_internal_service_auth),
    generator: EmbeddingGenerator = Depends(get_embedding_generator),
) -> EmbeddingResponse:
    """Return one 1024-dimensional vector for each input text."""

    try:
        model, vectors = await generator(payload.texts)

    except EmbeddingProviderUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Local embedding model service is unavailable.",
        ) from None

    except EmbeddingProviderTimeout:
        raise HTTPException(
            status_code=504,
            detail="Local embedding model request timed out.",
        ) from None

    except EmbeddingProviderRequestError:
        raise HTTPException(
            status_code=502,
            detail="Local embedding model returned an invalid response.",
        ) from None

    # Validate again in case the generator has been replaced in tests.
    if (
        not isinstance(model, str)
        or not model.strip()
        or len(vectors) != len(payload.texts)
        or any(
            len(vector) != EMBEDDING_DIMENSIONS
            or not all(
                isinstance(value, (int, float))
                and not isinstance(value, bool)
                and math.isfinite(value)
                for value in vector
            )
            for vector in vectors
        )
    ):
        logger.error(
            "Embedding generator returned an invalid response contract."
        )
        raise HTTPException(
            status_code=502,
            detail="Local embedding model returned an invalid response.",
        )

    return EmbeddingResponse(
        model=model,
        dimensions=EMBEDDING_DIMENSIONS,
        data=[
            EmbeddingItem(
                index=index,
                embedding=vector,
            )
            for index, vector in enumerate(vectors)
        ],
    )


class ChatRequest(BaseModel):
    """A prompt sent to the local language model."""

    prompt: str = Field(
        min_length=1,
        max_length=MAX_TEXT_CHARS,
    )
    max_tokens: int = Field(default=1536, ge=1, le=1536)
    response_format: Literal["text", "json"] = "text"
    response_schema: dict[str, object] | None = None

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, prompt: str) -> str:
        """Reject blank prompts before contacting the model."""
        if not prompt.strip():
            raise ValueError("Prompt must not be empty.")

        return prompt

    @field_validator("response_schema")
    @classmethod
    def validate_response_schema(
        cls,
        response_schema: dict[str, object] | None,
    ) -> dict[str, object] | None:
        """Bound the JSON schema forwarded to the local model."""
        if response_schema is not None:
            try:
                encoded = json.dumps(response_schema, allow_nan=False)
            except (TypeError, ValueError) as exc:
                raise ValueError("Response schema must be JSON serializable.") from exc
            if len(encoded.encode("utf-8")) > 16_384:
                raise ValueError("Response schema is too large.")
        return response_schema


class ChatResponse(BaseModel):
    """A response generated by the local language model."""

    model: str
    response: str


class LocalModelUnavailable(Exception):
    """Raised when the local model service cannot be reached."""


class LocalModelTimeout(Exception):
    """Raised when the local model exceeds its timeout."""


class LocalModelResponseError(Exception):
    """Raised when the local model returns an invalid response."""


LocalChatGenerator = Callable[
    [str, int, Literal["text", "json"], dict[str, object] | None],
    Awaitable[tuple[str, str]],
]


async def generate_local_chat(
    prompt: str,
    max_tokens: int = 1536,
    response_format: Literal["text", "json"] = "text",
    response_schema: dict[str, object] | None = None,
) -> tuple[str, str]:
    """Generate a response using the local Ollama chat API."""

    base_url = (
        os.environ.get("OLLAMA_BASE_URL")
        or "http://127.0.0.1:11434"
    ).rstrip("/")

    model = (
        os.environ.get("OLLAMA_CHAT_MODEL")
        or "qwen3.5:4b"
    )
    request_started = time.perf_counter()

    messages = [
        {
            "role": "system",
            "content": (
                "Eres SentinelOps AI, un asistente especializado en "
                "investigacion de incidentes de software. "
                "Distingue hechos, hipotesis y recomendaciones. "
                "Interpreta waiting_requests como solicitudes esperando "
                "disponibilidad del pool, no como transacciones bloqueadas. "
                "active_connections son conexiones activas; "
                "idle_connections son conexiones inactivas disponibles. "
                "Un HTTP 200 de un componente no demuestra el exito de "
                "una operacion de negocio completa. "
                "La similitud semantica mide relevancia de recuperacion, "
                "no probabilidad causal. "
                "No inventes logs, metricas, resultados de herramientas "
                "ni evidencias. No declares una causa raiz sin pruebas "
                "suficientes. Si falta informacion, indica que "
                "comprobaciones permitirian obtenerla. "
                "Responde en espanol de forma clara y tecnica."
            ),
        },
        {
            "role": "user",
            "content": prompt,
        },
    ]

    ollama_request: dict[str, object] = {
        "model": model,
        "messages": messages,
        "stream": False,
        "think": False,
        "options": {
            "num_predict": max_tokens,
            "temperature": 0.1,
        },
    }
    if response_format == "json":
        ollama_request["format"] = response_schema or "json"

    try:
        async with httpx.AsyncClient(
            timeout=get_chat_timeout_seconds()
        ) as client:
            response = await client.post(
                f"{base_url}/api/chat",
                json=ollama_request,
            )

            response.raise_for_status()
            payload = response.json()

    except httpx.TimeoutException as exc:
        logger.warning(
            "Local model request timed out: request_ms=%.1f",
            (time.perf_counter() - request_started) * 1000,
        )
        raise LocalModelTimeout from exc

    except httpx.ConnectError as exc:
        logger.warning("Local model service is unavailable.")
        raise LocalModelUnavailable from exc

    except httpx.HTTPError as exc:
        logger.error(
            "Local model HTTP request failed: type=%s status_code=%s",
            type(exc).__name__,
            getattr(
                getattr(exc, "response", None),
                "status_code",
                None,
            ),
        )
        raise LocalModelResponseError from exc

    except ValueError as exc:
        logger.error("Local model returned invalid JSON.")
        raise LocalModelResponseError from exc

    if (
        not isinstance(payload, dict)
        or not isinstance(payload.get("model"), str)
        or not isinstance(payload.get("message"), dict)
        or not isinstance(
            payload["message"].get("content"),
            str,
        )
        or not payload["message"]["content"].strip()
        or payload.get("done") is not True
    ):
        logger.error(
            "Local model returned an invalid response contract."
        )
        raise LocalModelResponseError

    if payload.get("done_reason") == "length":
        logger.warning(
            "Local model response reached its token limit: model=%s "
            "max_tokens=%s generated_tokens=%s",
            payload["model"],
            max_tokens,
            payload.get("eval_count"),
        )
        raise LocalModelResponseError

    logger.info(
        "Local chat inference completed: model=%s request_ms=%.1f "
        "ollama_total_ms=%s model_load_ms=%s prompt_eval_ms=%s "
        "generation_ms=%s prompt_tokens=%s generated_tokens=%s",
        payload["model"],
        (time.perf_counter() - request_started) * 1000,
        _duration_ms(payload, "total_duration"),
        _duration_ms(payload, "load_duration"),
        _duration_ms(payload, "prompt_eval_duration"),
        _duration_ms(payload, "eval_duration"),
        payload.get("prompt_eval_count"),
        payload.get("eval_count"),
    )

    return (
        payload["model"],
        payload["message"]["content"].strip(),
    )


def get_local_chat_generator() -> LocalChatGenerator:
    """Dependency hook that allows chat generation to be mocked in tests."""
    return generate_local_chat


@app.post(
    "/warmup",
    response_model=HealthResponse,
    tags=["Health"],
    summary="Load and verify the configured local models",
)
async def warm_up_models(
    _service_auth: None = Depends(require_internal_service_auth),
    embedding_generator: EmbeddingGenerator = Depends(
        get_embedding_generator
    ),
    chat_generator: LocalChatGenerator = Depends(
        get_local_chat_generator
    ),
    loaded_models: Callable[[], Awaitable[set[str]]] = Depends(
        get_model_readiness_checker
    ),
) -> HealthResponse:
    """Warm both models explicitly, using each provider's existing timeout."""
    try:
        await embedding_generator(["SentinelOps model warm-up."])
    except EmbeddingProviderUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Local embedding model service is unavailable.",
        ) from None
    except EmbeddingProviderTimeout:
        raise HTTPException(
            status_code=504,
            detail="Local embedding model request timed out.",
        ) from None
    except EmbeddingProviderRequestError:
        raise HTTPException(
            status_code=502,
            detail="Local embedding model returned an invalid response.",
        ) from None

    try:
        await chat_generator(
            "Responde solo con la palabra listo.",
            8,
            "text",
            None,
        )
    except LocalModelUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Local model service is unavailable.",
        ) from None
    except LocalModelTimeout:
        raise HTTPException(
            status_code=504,
            detail="Local model request timed out.",
        ) from None
    except LocalModelResponseError:
        raise HTTPException(
            status_code=502,
            detail="Local model returned an invalid response.",
        ) from None

    try:
        loaded = await loaded_models()
    except HTTPException:
        raise

    missing = get_required_model_names() - loaded
    if missing:
        logger.warning(
            "Local model warm-up completed but models are not ready: "
            "missing_models=%s",
            sorted(missing),
        )
        raise HTTPException(
            status_code=503,
            detail="Required local models are not loaded after warm-up.",
        )

    return HealthResponse(
        status="ok",
        service="sentinelops-ai-orchestrator",
    )


@app.post(
    "/chat",
    response_model=ChatResponse,
    tags=["Chat"],
    summary="Generate a response using the local language model",
)
async def create_chat_response(
    payload: ChatRequest,
    _service_auth: None = Depends(require_internal_service_auth),
    generator: LocalChatGenerator = Depends(get_local_chat_generator),
) -> ChatResponse:
    """Generate a response without exposing internal thinking output."""
    if payload.response_schema is not None and payload.response_format != "json":
        raise HTTPException(
            status_code=422,
            detail="A response schema requires JSON response format.",
        )

    try:
        model, generated_text = await generator(
            payload.prompt,
            payload.max_tokens,
            payload.response_format,
            payload.response_schema,
        )

    except LocalModelUnavailable:
        raise HTTPException(
            status_code=503,
            detail="Local model service is unavailable.",
        ) from None

    except LocalModelTimeout:
        raise HTTPException(
            status_code=504,
            detail="Local model request timed out.",
        ) from None

    except LocalModelResponseError:
        raise HTTPException(
            status_code=502,
            detail="Local model returned an invalid response.",
        ) from None

    return ChatResponse(
        model=model,
        response=generated_text,
    )
