"""Inference server: FastAPI application for Qwen3-VL visual inference.

Endpoints (must match HttpInferenceClient in agent/inference.py):
  POST /api/find_element  - locate a UI element, return bounding box
  POST /api/checkpoint    - verify page state matches expectations
  POST /api/infer_action  - recommend next browser action
  GET  /health            - liveness check with model info

All endpoints are stateless. Each request includes a base64 screenshot
and context. The server loads the VLM once at startup and serves requests.

Usage:
    uvicorn inference.server:app --host 0.0.0.0 --port 8420
    # or:
    python -m inference.server
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from inference.config import Config
from inference.model import (
    InferenceBackend,
    create_backend,
    parse_checkpoint,
    parse_find_element,
    parse_infer_action,
    preprocess_image,
)
from inference.prompts import (
    CHECKPOINT_SYSTEM,
    FIND_ELEMENT_SYSTEM,
    INFER_ACTION_SYSTEM,
    build_checkpoint_prompt,
    build_find_element_prompt,
    build_infer_action_prompt,
    check_password_guard,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Global state (set during lifespan)
# ---------------------------------------------------------------------------

_config: Config | None = None
_backend: InferenceBackend | None = None


def get_config() -> Config:
    assert _config is not None, "Server not initialized"
    return _config


def get_backend() -> InferenceBackend:
    assert _backend is not None, "Server not initialized"
    return _backend


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load model on startup, clean up on shutdown."""
    global _config, _backend
    _config = Config.load()

    logging.basicConfig(
        level=getattr(logging, _config.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    log.info(
        "Starting inference server (backend=%s, port=%d)",
        _config.model_backend,
        _config.port,
    )

    _backend = create_backend(_config)
    log.info("Backend ready: %s", _backend.model_info())

    yield

    log.info("Shutting down inference server")
    if _backend is not None and hasattr(_backend, "shutdown"):
        _backend.shutdown()
    _backend = None
    _config = None


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="UnsaltedButter Inference Server",
    version="1.0.0",
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class FindElementRequest(BaseModel):
    screenshot: str = Field(..., description="Base64-encoded PNG screenshot")
    description: str = Field(..., description="What UI element to find")
    context: str = Field("", description="Optional context (service, flow, action)")


class FindElementResponseModel(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int
    confidence: float
    inference_ms: int = 0


class CheckpointRequest(BaseModel):
    screenshot: str = Field(..., description="Base64-encoded PNG screenshot")
    prompt: str = Field(..., description="Expected page state description")
    context: str = Field("", description="Optional context")


class CheckpointResponseModel(BaseModel):
    on_track: bool
    confidence: float
    reasoning: str
    inference_ms: int = 0


class InferActionRequest(BaseModel):
    screenshot: str = Field(..., description="Base64-encoded PNG screenshot")
    context: str = Field("", description="Context about the current task")


class InferActionResponseModel(BaseModel):
    action: str
    target_x: int
    target_y: int
    text: str
    confidence: float
    reasoning: str
    inference_ms: int = 0


class HealthResponse(BaseModel):
    status: str
    backend: dict


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.post("/api/find_element", response_model=FindElementResponseModel)
async def find_element(req: FindElementRequest) -> FindElementResponseModel:
    """Locate a UI element in the screenshot. Returns bounding box."""
    config = get_config()
    backend = get_backend()

    # Password guard
    if config.password_guard_enabled and check_password_guard(req.description):
        raise HTTPException(
            status_code=400,
            detail="Refused: prompt appears to request password field contents.",
        )

    # Preprocess image
    try:
        image = preprocess_image(req.screenshot, config.max_image_dimension)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid screenshot: {exc}")

    # Build prompt and run inference
    user_prompt = build_find_element_prompt(req.description, req.context)

    start = time.monotonic()
    try:
        raw_output = backend.infer(FIND_ELEMENT_SYSTEM, user_prompt, image)
    except Exception as exc:
        log.error("Inference failed for find_element: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")
    elapsed_ms = int((time.monotonic() - start) * 1000)

    # Parse response
    try:
        result = parse_find_element(raw_output, elapsed_ms)
    except ValueError as exc:
        log.error("Failed to parse find_element response: %s", exc)
        log.debug("Raw VLM output: %s", raw_output[:500])
        raise HTTPException(
            status_code=502,
            detail=f"VLM returned unparseable output: {exc}",
        )

    return FindElementResponseModel(
        x1=result.x1,
        y1=result.y1,
        x2=result.x2,
        y2=result.y2,
        confidence=result.confidence,
        inference_ms=result.inference_ms,
    )


@app.post("/api/checkpoint", response_model=CheckpointResponseModel)
async def checkpoint(req: CheckpointRequest) -> CheckpointResponseModel:
    """Verify page state matches the expected description."""
    config = get_config()
    backend = get_backend()

    # Password guard
    if config.password_guard_enabled and check_password_guard(req.prompt):
        raise HTTPException(
            status_code=400,
            detail="Refused: prompt appears to request password field contents.",
        )

    # Preprocess image
    try:
        image = preprocess_image(req.screenshot, config.max_image_dimension)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid screenshot: {exc}")

    # Build prompt and run inference
    user_prompt = build_checkpoint_prompt(req.prompt, req.context)

    start = time.monotonic()
    try:
        raw_output = backend.infer(CHECKPOINT_SYSTEM, user_prompt, image)
    except Exception as exc:
        log.error("Inference failed for checkpoint: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")
    elapsed_ms = int((time.monotonic() - start) * 1000)

    # Parse response
    try:
        result = parse_checkpoint(raw_output, elapsed_ms)
    except ValueError as exc:
        log.error("Failed to parse checkpoint response: %s", exc)
        log.debug("Raw VLM output: %s", raw_output[:500])
        raise HTTPException(
            status_code=502,
            detail=f"VLM returned unparseable output: {exc}",
        )

    return CheckpointResponseModel(
        on_track=result.on_track,
        confidence=result.confidence,
        reasoning=result.reasoning,
        inference_ms=result.inference_ms,
    )


@app.post("/api/infer_action", response_model=InferActionResponseModel)
async def infer_action(req: InferActionRequest) -> InferActionResponseModel:
    """Recommend the next browser action based on the screenshot and context."""
    config = get_config()
    backend = get_backend()

    # Password guard
    if config.password_guard_enabled and check_password_guard(req.context):
        raise HTTPException(
            status_code=400,
            detail="Refused: prompt appears to request password field contents.",
        )

    # Preprocess image
    try:
        image = preprocess_image(req.screenshot, config.max_image_dimension)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid screenshot: {exc}")

    # Build prompt and run inference
    user_prompt = build_infer_action_prompt(req.context)

    start = time.monotonic()
    try:
        raw_output = backend.infer(INFER_ACTION_SYSTEM, user_prompt, image)
    except Exception as exc:
        log.error("Inference failed for infer_action: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail=f"Inference error: {exc}")
    elapsed_ms = int((time.monotonic() - start) * 1000)

    # Parse response
    try:
        result = parse_infer_action(raw_output, elapsed_ms)
    except ValueError as exc:
        log.error("Failed to parse infer_action response: %s", exc)
        log.debug("Raw VLM output: %s", raw_output[:500])
        raise HTTPException(
            status_code=502,
            detail=f"VLM returned unparseable output: {exc}",
        )

    return InferActionResponseModel(
        action=result.action,
        target_x=result.target_x,
        target_y=result.target_y,
        text=result.text,
        confidence=result.confidence,
        reasoning=result.reasoning,
        inference_ms=result.inference_ms,
    )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness check. Returns model info."""
    backend = get_backend()
    return HealthResponse(
        status="ok",
        backend=backend.model_info(),
    )


# ---------------------------------------------------------------------------
# Direct execution
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    cfg = Config.load()
    uvicorn.run(
        "inference.server:app",
        host=cfg.host,
        port=cfg.port,
        log_level=cfg.log_level.lower(),
    )
