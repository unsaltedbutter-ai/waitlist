"""Tests for push notification parsing and formatting (concierge model).

Run: cd nostr-bot && python -m pytest test_notifications.py -v
"""

import json

import pytest

import notifications


NPUB_HEX = "abcd1234" * 8
OPERATOR_HEX = "operator0" * 7 + "operator"


# -- parse_push_notification ---------------------------------------------------


class TestParsePushNotification:
    def test_valid_payload(self):
        msg = json.dumps({"type": "job_complete", "data": {"foo": "bar"}})
        result = notifications.parse_push_notification(msg)
        assert result is not None
        assert result["type"] == "job_complete"

    def test_invalid_json(self):
        assert notifications.parse_push_notification("not json") is None

    def test_missing_type(self):
        msg = json.dumps({"data": {"foo": "bar"}})
        assert notifications.parse_push_notification(msg) is None

    def test_missing_data(self):
        msg = json.dumps({"type": "job_complete"})
        assert notifications.parse_push_notification(msg) is None

    def test_non_dict(self):
        msg = json.dumps([1, 2, 3])
        assert notifications.parse_push_notification(msg) is None

    def test_none_input(self):
        assert notifications.parse_push_notification(None) is None

    def test_empty_string(self):
        assert notifications.parse_push_notification("") is None


# -- format_job_complete -------------------------------------------------------


class TestFormatJobComplete:
    def test_cancel_with_end_date_and_invoice(self):
        data = {
            "service_name": "Netflix",
            "action": "cancel",
            "access_end_date": "March 15",
            "bolt11": "lnbc3000n1fake",
        }
        msg = notifications.format_job_complete(data)
        assert "Netflix was cancelled" in msg
        assert "March 15" in msg
        assert "lnbc3000n1fake" in msg
        assert "3,000 sats" in msg

    def test_cancel_without_end_date(self):
        data = {
            "service_name": "Hulu",
            "action": "cancel",
            "bolt11": "lnbc3000n1test",
        }
        msg = notifications.format_job_complete(data)
        assert "Hulu was cancelled" in msg
        assert "access until" not in msg

    def test_resume(self):
        data = {
            "service_name": "Netflix",
            "action": "resume",
            "bolt11": "lnbc3000n1test",
        }
        msg = notifications.format_job_complete(data)
        assert "Netflix was resumed" in msg
        assert "lnbc3000n1test" in msg

    def test_unknown_action(self):
        data = {
            "service_name": "Netflix",
            "action": "something_else",
        }
        msg = notifications.format_job_complete(data)
        assert "Netflix" in msg
        assert "done" in msg

    def test_missing_fields_uses_defaults(self):
        msg = notifications.format_job_complete({})
        assert "your service" in msg


# -- format_payment_received ---------------------------------------------------


class TestFormatPaymentReceived:
    def test_basic(self):
        data = {"service_name": "Netflix", "amount_sats": 3000}
        msg = notifications.format_payment_received(data)
        assert "3,000 sats" in msg
        assert "Netflix" in msg
        assert "thanks" in msg.lower()

    def test_default_amount(self):
        msg = notifications.format_payment_received({})
        assert "3,000 sats" in msg


# -- format_payment_expired ----------------------------------------------------


class TestFormatPaymentExpired:
    def test_basic(self):
        data = {"service_name": "Netflix", "debt_sats": 3000}
        msg = notifications.format_payment_expired(data)
        assert "expired" in msg.lower()
        assert "3,000 sats" in msg
        assert "Netflix" in msg

    def test_custom_debt(self):
        data = {"service_name": "Hulu", "debt_sats": 6000}
        msg = notifications.format_payment_expired(data)
        assert "6,000 sats" in msg


# -- format_new_user -----------------------------------------------------------


class TestFormatNewUser:
    def test_basic(self):
        data = {"npub": "npub1abc123xyz456..."}
        msg = notifications.format_new_user(data)
        assert "New user" in msg
        assert "npub1abc123xyz45" in msg

    def test_default_npub(self):
        msg = notifications.format_new_user({})
        assert "unknown" in msg


# -- format_notification (routing) ---------------------------------------------


class TestFormatNotification:
    def test_job_complete(self):
        payload = {
            "type": "job_complete",
            "data": {
                "npub_hex": NPUB_HEX,
                "service_name": "Netflix",
                "action": "cancel",
            },
        }
        target, msg = notifications.format_notification(payload)
        assert target == NPUB_HEX
        assert "Netflix" in msg

    def test_payment_received(self):
        payload = {
            "type": "payment_received",
            "data": {
                "npub_hex": NPUB_HEX,
                "service_name": "Netflix",
                "amount_sats": 3000,
            },
        }
        target, msg = notifications.format_notification(payload)
        assert target == NPUB_HEX
        assert "3,000" in msg

    def test_payment_expired(self):
        payload = {
            "type": "payment_expired",
            "data": {
                "npub_hex": NPUB_HEX,
                "service_name": "Netflix",
                "debt_sats": 3000,
            },
        }
        target, msg = notifications.format_notification(payload)
        assert target == NPUB_HEX
        assert "expired" in msg.lower()

    def test_new_user_targets_operator(self):
        payload = {
            "type": "new_user",
            "data": {
                "npub": "npub1test123...",
                "operator_npub_hex": OPERATOR_HEX,
            },
        }
        target, msg = notifications.format_notification(payload)
        assert target == OPERATOR_HEX
        assert "New user" in msg

    def test_unknown_type_returns_none(self):
        payload = {"type": "something_weird", "data": {}}
        target, msg = notifications.format_notification(payload)
        assert target is None
        assert msg is None

    def test_missing_npub_hex(self):
        payload = {
            "type": "job_complete",
            "data": {
                "service_name": "Netflix",
                "action": "cancel",
                # no npub_hex
            },
        }
        target, msg = notifications.format_notification(payload)
        assert target is None
        assert msg is not None  # message is still formatted


# -- No old model references ---------------------------------------------------


class TestNoOldModelReferences:
    """Ensure no old-model terms leaked into notification messages."""

    def test_no_credit_references(self):
        data = {"service_name": "Netflix", "action": "cancel", "bolt11": "lnbc123"}
        msg = notifications.format_job_complete(data)
        for term in ["credit", "balance", "gift card", "lock-in", "margin"]:
            assert term not in msg.lower(), f"Message contains old-model term: {term}"

    def test_no_old_references_in_payment_expired(self):
        data = {"service_name": "Netflix", "debt_sats": 3000}
        msg = notifications.format_payment_expired(data)
        for term in ["credit", "gift card", "lock-in", "margin"]:
            assert term not in msg.lower(), f"Message contains old-model term: {term}"
