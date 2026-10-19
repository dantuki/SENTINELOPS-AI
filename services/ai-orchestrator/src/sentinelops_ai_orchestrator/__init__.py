
"""SentinelOps AI orchestrator package."""


def main() -> None:
    """Start the local orchestrator API server."""
    import uvicorn

    uvicorn.run(
        "sentinelops_ai_orchestrator.app:app",
        host="127.0.0.1",
        port=8001,
        reload=False,
    )
