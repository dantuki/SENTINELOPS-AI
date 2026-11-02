"""FastAPI application for the SentinelOps AI orchestrator."""

import logging
import math
import os
from collections.abc import Awaitable, Callable
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator


# Embeddings locales mediante Ollama.
EMBEDDING_MODEL = "qwen3-embedding:0.6b"
EMBEDDING_DIMENSIONS = 1024
MAX_BATCH_SIZE = 32
MAX_TEXT_CHARS = 20_000
EMBEDDING_TIMEOUT_SECONDS = 30.0

logger = logging.getLogger("uvicorn.error")


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
        logger.warning("Local embedding model request timed out.")
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

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, prompt: str) -> str:
        """Reject blank prompts before contacting the model."""
        if not prompt.strip():
            raise ValueError("Prompt must not be empty.")

        return prompt


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
    [str],
    Awaitable[tuple[str, str]],
]


async def generate_local_chat(
    prompt: str,
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

    messages = [
        {
            "role": "system",
            "content": (
                "Eres SentinelOps AI, un asistente especializado en "
                "investigacion de incidentes de software. "
                "Distingue hechos, hipotesis y recomendaciones. "
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

    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            response = await client.post(
                f"{base_url}/api/chat",
                json={
                    "model": model,
                    "messages": messages,
                    "stream": False,
                    "think": False,
                    "options": {
                        "num_predict": 1536,
                    },
                },
            )

            response.raise_for_status()
            payload = response.json()

    except httpx.TimeoutException as exc:
        logger.warning("Local model request timed out.")
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

    return (
        payload["model"],
        payload["message"]["content"].strip(),
    )


def get_local_chat_generator() -> LocalChatGenerator:
    """Dependency hook that allows chat generation to be mocked in tests."""
    return generate_local_chat


@app.post(
    "/chat",
    response_model=ChatResponse,
    tags=["Chat"],
    summary="Generate a response using the local language model",
)
async def create_chat_response(
    payload: ChatRequest,
    generator: LocalChatGenerator = Depends(get_local_chat_generator),
) -> ChatResponse:
    """Generate a response without exposing internal thinking output."""

    try:
        model, generated_text = await generator(payload.prompt)

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