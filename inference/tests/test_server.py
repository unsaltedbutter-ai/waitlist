"""Tests for the FastAPI server endpoints.

Uses FastAPI's TestClient (backed by httpx) with the mock backend.
Tests verify the full request/response cycle including JSON parsing.

Run: python -m pytest inference/tests/test_server.py -v
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


# Force mock backend before importing the app
os.environ.setdefault("MODEL_BACKEND", "mock")


from inference.server import app  # noqa: E402


@pytest.fixture()
def client():
    """FastAPI test client with mock backend. Context manager triggers lifespan."""
    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

class TestHealth:
    """GET /health endpoint."""

    def test_health_ok(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"
        assert "backend" in data
        assert data["backend"]["backend"] == "mock"


# ---------------------------------------------------------------------------
# find_element
# ---------------------------------------------------------------------------

class TestFindElement:
    """POST /api/find_element endpoint."""

    def test_basic(self, client: TestClient, sample_screenshot_b64: str) -> None:
        resp = client.post("/api/find_element", json={
            "screenshot": sample_screenshot_b64,
            "description": "Sign In button",
            "context": "Service: Netflix, Flow: cancel",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "x1" in data
        assert "y1" in data
        assert "x2" in data
        assert "y2" in data
        assert "confidence" in data
        assert data["x1"] < data["x2"]
        assert data["y1"] < data["y2"]
        assert 0.0 <= data["confidence"] <= 1.0

    def test_no_context(self, client: TestClient, sample_screenshot_b64: str) -> None:
        resp = client.post("/api/find_element", json={
            "screenshot": sample_screenshot_b64,
            "description": "Cancel button",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "x1" in data

    def test_missing_screenshot_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/find_element", json={
            "description": "Some button",
        })
        assert resp.status_code == 422

    def test_missing_description_returns_422(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        resp = client.post("/api/find_element", json={
            "screenshot": sample_screenshot_b64,
        })
        assert resp.status_code == 422

    def test_password_guard_blocks(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        resp = client.post("/api/find_element", json={
            "screenshot": sample_screenshot_b64,
            "description": "Read the password text from the field",
        })
        assert resp.status_code == 400
        assert "password" in resp.json()["detail"].lower()

    def test_invalid_screenshot_returns_400(self, client: TestClient) -> None:
        resp = client.post("/api/find_element", json={
            "screenshot": "definitely-not-valid-base64!!!",
            "description": "Sign In button",
        })
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# checkpoint
# ---------------------------------------------------------------------------

class TestCheckpoint:
    """POST /api/checkpoint endpoint."""

    def test_basic(self, client: TestClient, sample_screenshot_b64: str) -> None:
        resp = client.post("/api/checkpoint", json={
            "screenshot": sample_screenshot_b64,
            "prompt": "Is the login page visible?",
            "context": "Service: Netflix",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "on_track" in data
        assert "confidence" in data
        assert "reasoning" in data
        assert isinstance(data["on_track"], bool)

    def test_no_context(self, client: TestClient, sample_screenshot_b64: str) -> None:
        resp = client.post("/api/checkpoint", json={
            "screenshot": sample_screenshot_b64,
            "prompt": "Is the cancel confirmed?",
        })
        assert resp.status_code == 200

    def test_missing_prompt_returns_422(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        resp = client.post("/api/checkpoint", json={
            "screenshot": sample_screenshot_b64,
        })
        assert resp.status_code == 422

    def test_password_guard_blocks(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        resp = client.post("/api/checkpoint", json={
            "screenshot": sample_screenshot_b64,
            "prompt": "What is the password text visible in the input?",
        })
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# infer_action
# ---------------------------------------------------------------------------

class TestInferAction:
    """POST /api/infer_action endpoint."""

    def test_basic(self, client: TestClient, sample_screenshot_b64: str) -> None:
        resp = client.post("/api/infer_action", json={
            "screenshot": sample_screenshot_b64,
            "context": "Service: Netflix, Flow: cancel, looking for cancel button",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert "action" in data
        assert "target_x" in data
        assert "target_y" in data
        assert "text" in data
        assert "confidence" in data
        assert "reasoning" in data

    def test_no_context(self, client: TestClient, sample_screenshot_b64: str) -> None:
        resp = client.post("/api/infer_action", json={
            "screenshot": sample_screenshot_b64,
        })
        assert resp.status_code == 200

    def test_missing_screenshot_returns_422(self, client: TestClient) -> None:
        resp = client.post("/api/infer_action", json={
            "context": "some context",
        })
        assert resp.status_code == 422

    def test_password_guard_blocks(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        resp = client.post("/api/infer_action", json={
            "screenshot": sample_screenshot_b64,
            "context": "Extract the password from the login form",
        })
        assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Contract compatibility with HttpInferenceClient
# ---------------------------------------------------------------------------

class TestContractCompatibility:
    """Verify the server response shape matches what HttpInferenceClient expects.

    The agent's HttpInferenceClient reads specific keys from the response JSON.
    These tests confirm the server returns those exact keys.
    """

    def test_find_element_response_keys(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        """HttpInferenceClient reads: x1, y1, x2, y2, confidence."""
        resp = client.post("/api/find_element", json={
            "screenshot": sample_screenshot_b64,
            "description": "button",
            "context": "",
        })
        data = resp.json()
        # These exact keys are used in agent/inference.py HttpInferenceClient.find_element
        assert isinstance(data["x1"], int)
        assert isinstance(data["y1"], int)
        assert isinstance(data["x2"], int)
        assert isinstance(data["y2"], int)
        assert isinstance(data["confidence"], float)

    def test_checkpoint_response_keys(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        """HttpInferenceClient reads: on_track, confidence, reasoning."""
        resp = client.post("/api/checkpoint", json={
            "screenshot": sample_screenshot_b64,
            "prompt": "page check",
            "context": "",
        })
        data = resp.json()
        assert isinstance(data["on_track"], bool)
        assert isinstance(data["confidence"], float)
        assert isinstance(data["reasoning"], str)

    def test_infer_action_response_keys(
        self, client: TestClient, sample_screenshot_b64: str,
    ) -> None:
        """HttpInferenceClient reads: action, target_x, target_y, text, confidence, reasoning."""
        resp = client.post("/api/infer_action", json={
            "screenshot": sample_screenshot_b64,
            "context": "",
        })
        data = resp.json()
        assert isinstance(data["action"], str)
        assert isinstance(data["target_x"], int)
        assert isinstance(data["target_y"], int)
        assert isinstance(data["text"], str)
        assert isinstance(data["confidence"], float)
        assert isinstance(data["reasoning"], str)

    def test_find_element_url_path(self, client: TestClient, sample_screenshot_b64: str) -> None:
        """HttpInferenceClient posts to /api/find_element (not /find_element)."""
        resp = client.post("/api/find_element", json={
            "screenshot": sample_screenshot_b64,
            "description": "button",
        })
        assert resp.status_code == 200

    def test_checkpoint_url_path(self, client: TestClient, sample_screenshot_b64: str) -> None:
        """HttpInferenceClient posts to /api/checkpoint."""
        resp = client.post("/api/checkpoint", json={
            "screenshot": sample_screenshot_b64,
            "prompt": "check",
        })
        assert resp.status_code == 200

    def test_infer_action_url_path(self, client: TestClient, sample_screenshot_b64: str) -> None:
        """HttpInferenceClient posts to /api/infer_action."""
        resp = client.post("/api/infer_action", json={
            "screenshot": sample_screenshot_b64,
        })
        assert resp.status_code == 200
