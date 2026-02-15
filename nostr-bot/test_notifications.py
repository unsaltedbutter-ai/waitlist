"""Tests for proactive outbound notification queries and formatting.

Uses the same mock pattern as test_commands.py: real logic, mocked DB.

Run: cd nostr-bot && python -m pytest test_notifications.py -v
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID

import pytest

import notifications

USER_ID = UUID("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
USER_ID_2 = UUID("bbbbbbbb-cccc-dddd-eeee-ffffffffffff")
NPUB_HEX = "abcd1234" * 8  # 64 hex chars


# ── Helpers ───────────────────────────────────────────────────


def _make_pool_mock():
    """Create an AsyncMock that behaves like an asyncpg pool."""
    pool = AsyncMock()
    pool.fetch = AsyncMock(return_value=[])
    pool.execute = AsyncMock()
    return pool


# ── Message formatting ────────────────────────────────────────


class TestFormatLockInMessage:
    def test_with_date(self):
        msg = notifications.format_lock_in_message("Netflix", datetime(2026, 3, 15))
        assert "Netflix" in msg
        assert "Mar 15" in msg
        assert "SKIP" in msg
        assert "gift card" in msg

    def test_without_date(self):
        msg = notifications.format_lock_in_message("Hulu", None)
        assert "Hulu" in msg
        assert "soon" in msg


class TestFormatMembershipDueMessage:
    def test_monthly(self):
        msg = notifications.format_membership_due_message(
            "monthly", 4400, datetime(2026, 2, 28)
        )
        assert "monthly" in msg
        assert "4,400 sats" in msg
        assert "Feb 28" in msg
        assert "destroy" in msg

    def test_annual(self):
        msg = notifications.format_membership_due_message(
            "annual", 3500, datetime(2026, 12, 1)
        )
        assert "annual" in msg
        assert "3,500 sats" in msg

    def test_without_date(self):
        msg = notifications.format_membership_due_message("monthly", 4400, None)
        assert "soon" in msg


class TestFormatCreditTopupMessage:
    def test_basic(self):
        msg = notifications.format_credit_topup_message("Netflix", 1799, 5000)
        assert "Netflix" in msg
        assert "$18/mo" in msg
        assert "sats" in msg
        assert "dashboard" in msg

    def test_needed_sats_calculation(self):
        # Netflix = 1799 cents, credit = 5000 sats
        # needed = max(0, (1799 * 10) - 5000) = 12990
        msg = notifications.format_credit_topup_message("Netflix", 1799, 5000)
        assert "12,990 sats" in msg

    def test_zero_credits(self):
        msg = notifications.format_credit_topup_message("Hulu", 1899, 0)
        assert "18,990 sats" in msg


# ── Query functions (mocked DB pool) ─────────────────────────


class TestGetUsersLockInApproaching:
    @pytest.mark.asyncio
    async def test_returns_matching_users(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Netflix",
                "estimated_start_date": datetime(2026, 3, 15, tzinfo=timezone.utc),
                "next_service_id": "netflix",
            }
        ]
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_lock_in_approaching()
        assert len(result) == 1
        assert result[0]["user_id"] == USER_ID
        assert result[0]["next_service_name"] == "Netflix"
        # Verify the query was called (single efficient query, not N+1)
        pool.fetch.assert_called_once()

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_matches(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_lock_in_approaching()
        assert result == []

    @pytest.mark.asyncio
    async def test_query_excludes_recently_notified(self):
        """The SQL itself handles dedup via NOT EXISTS on notification_log.
        We verify the query text references notification_log."""
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        # Inspect the SQL passed to fetch
        call_args = pool.fetch.call_args
        sql = call_args[0][0]
        assert "notification_log" in sql
        assert "lock_in_approaching" in sql
        assert "7 days" in sql


class TestGetUsersMembershipDue:
    @pytest.mark.asyncio
    async def test_returns_matching_users(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "membership_plan": "solo",
                "billing_period": "monthly",
                "membership_expires_at": datetime(2026, 2, 20, tzinfo=timezone.utc),
                "price_sats": 4400,
            }
        ]
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_membership_due()
        assert len(result) == 1
        assert result[0]["price_sats"] == 4400

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_matches(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_membership_due()
        assert result == []

    @pytest.mark.asyncio
    async def test_query_joins_membership_pricing(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "membership_pricing" in sql
        assert "membership_due" in sql


class TestGetUsersCreditTopup:
    @pytest.mark.asyncio
    async def test_returns_matching_users(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "credit_sats": 5000,
                "cheapest_service_name": "Prime Video",
                "cheapest_service_price_cents": 899,
            }
        ]
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_credit_topup()
        assert len(result) == 1
        assert result[0]["credit_sats"] == 5000
        assert result[0]["cheapest_service_name"] == "Prime Video"

    @pytest.mark.asyncio
    async def test_returns_empty_when_no_matches(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_credit_topup()
        assert result == []

    @pytest.mark.asyncio
    async def test_query_uses_threshold_param(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        call_args = pool.fetch.call_args
        # Second arg is the threshold parameter
        assert call_args[0][1] == notifications.CREDIT_LOW_THRESHOLD_SATS

    @pytest.mark.asyncio
    async def test_query_checks_14_day_dedup(self):
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "14 days" in sql
        assert "credit_topup" in sql


# ── record_notification ───────────────────────────────────────


class TestRecordNotification:
    @pytest.mark.asyncio
    async def test_inserts_row(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.record_notification(USER_ID, "lock_in_approaching", "netflix")
        pool.execute.assert_called_once()
        call_args = pool.execute.call_args[0]
        assert "INSERT INTO notification_log" in call_args[0]
        assert call_args[1] == USER_ID
        assert call_args[2] == "lock_in_approaching"
        assert call_args[3] == "netflix"

    @pytest.mark.asyncio
    async def test_accepts_none_reference_id(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.record_notification(USER_ID, "credit_topup", None)
        call_args = pool.execute.call_args[0]
        assert call_args[3] is None


# ── check_and_send_notifications (integration) ───────────────


class TestCheckAndSendNotifications:
    @pytest.mark.asyncio
    async def test_sends_all_notification_types(self):
        """Verify the orchestrator calls all three queries and sends DMs."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        lock_in_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Netflix",
                "estimated_start_date": datetime(2026, 3, 15),
                "next_service_id": "netflix",
            }
        ]
        membership_data = [
            {
                "user_id": USER_ID_2,
                "nostr_npub": "def0" * 16,
                "membership_plan": "solo",
                "billing_period": "monthly",
                "membership_expires_at": datetime(2026, 2, 20),
                "price_sats": 4400,
            }
        ]
        topup_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "credit_sats": 3000,
                "cheapest_service_name": "Peacock",
                "cheapest_service_price_cents": 1099,
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=lock_in_data)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=membership_data)),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=topup_data)),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        # 3 DMs sent total (1 lock-in + 1 membership + 1 topup)
        assert mock_client.send_private_msg.call_count == 3
        assert mock_record.call_count == 3

    @pytest.mark.asyncio
    async def test_no_users_sends_nothing(self):
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=[])),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        mock_client.send_private_msg.assert_not_called()
        mock_record.assert_not_called()

    @pytest.mark.asyncio
    async def test_skips_user_when_dm_fails(self):
        """If send_private_msg raises, we log the error but don't crash."""
        mock_client = AsyncMock()
        mock_client.send_private_msg.side_effect = Exception("relay down")
        mock_signer = AsyncMock()

        lock_in_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Netflix",
                "estimated_start_date": datetime(2026, 3, 15),
                "next_service_id": "netflix",
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=lock_in_data)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            # Should not raise
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        # DM attempted but failed, so notification not recorded
        mock_record.assert_not_called()

    @pytest.mark.asyncio
    async def test_query_error_doesnt_crash(self):
        """If a query function raises, the others still execute."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        topup_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "credit_sats": 1000,
                "cheapest_service_name": "Peacock",
                "cheapest_service_price_cents": 1099,
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(side_effect=Exception("db error"))),
            patch("notifications.get_users_membership_due", AsyncMock(side_effect=Exception("db error"))),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=topup_data)),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        # Only the topup notification should have been sent
        assert mock_client.send_private_msg.call_count == 1
        mock_record.assert_called_once()


# ── Edge case: user without npub ──────────────────────────────
# The SQL queries already filter for nostr_npub IS NOT NULL,
# so users without npub never appear in results. We verify
# the SQL contains this filter.


class TestNpubFilterInQueries:
    @pytest.mark.asyncio
    async def test_lock_in_query_requires_npub(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "nostr_npub IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_membership_query_requires_npub(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "nostr_npub IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_topup_query_requires_npub(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "nostr_npub IS NOT NULL" in sql


# ═══════════════════════════════════════════════════════════════
# A. FALSE-POSITIVE PREVENTION — SQL filter verification
# ═══════════════════════════════════════════════════════════════
#
# These tests verify that the SQL queries contain the correct WHERE
# clauses to exclude users who should NOT be notified. Since the DB
# is mocked, we inspect the SQL text rather than running it against
# a real database. The SQL is the source of truth for exclusion logic.


class TestLockInFalsePositivePrevention:
    """Lock-in approaching should NOT notify when conditions are unmet."""

    @pytest.mark.asyncio
    async def test_query_requires_next_service_id_set(self):
        """No notification when next_service_id is NULL (nothing upcoming)."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "rs.next_service_id IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_query_requires_not_already_locked(self):
        """No notification when next service is already locked (locked_at IS NOT NULL)."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "rs.locked_at IS NULL" in sql

    @pytest.mark.asyncio
    async def test_query_requires_cancel_within_4_days(self):
        """No notification when cancel_scheduled_at is more than 4 days away."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        # cancel_scheduled_at <= NOW() + INTERVAL '4 days' filters out far-future cancels
        assert "cancel_scheduled_at" in sql
        assert "4 days" in sql

    @pytest.mark.asyncio
    async def test_query_requires_cancel_scheduled_at_not_null(self):
        """No notification when cancel_scheduled_at is NULL (no cancel scheduled).
        Also covers the 'already cancelled' case: if cancel is in the past,
        the subscription row wouldn't match a current_subscription_id join."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "s.cancel_scheduled_at IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_query_requires_nostr_npub(self):
        """No notification for email-only users (no npub)."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "u.nostr_npub IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_query_dedup_by_next_service_id(self):
        """No notification if same user+type+reference_id notified within 7 days."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "NOT EXISTS" in sql
        assert "nl.reference_id = rs.next_service_id" in sql
        assert "7 days" in sql

    @pytest.mark.asyncio
    async def test_not_sent_when_db_returns_empty_for_no_next_service(self):
        """Functional test: DB returns [] when no user qualifies -> no DMs."""
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_lock_in_approaching()
        assert result == []


class TestMembershipDueFalsePositivePrevention:
    """Membership due should NOT notify when conditions are unmet."""

    @pytest.mark.asyncio
    async def test_query_requires_expires_within_7_days(self):
        """No notification when membership_expires_at is more than 7 days out."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "membership_expires_at" in sql
        assert "7 days" in sql
        # The query uses <= NOW() + INTERVAL '7 days'
        assert "NOW() + INTERVAL" in sql

    @pytest.mark.asyncio
    async def test_query_requires_expires_at_not_null(self):
        """No notification when membership_expires_at is NULL."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "u.membership_expires_at IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_query_excludes_users_with_future_payment(self):
        """No notification if user already has a pending/paid payment for the future."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "membership_payments" in sql
        assert "pending" in sql
        assert "paid" in sql
        assert "pay.period_start > NOW()" in sql

    @pytest.mark.asyncio
    async def test_query_requires_active_status(self):
        """No notification for churned users."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "u.status = 'active'" in sql

    @pytest.mark.asyncio
    async def test_query_requires_nostr_npub(self):
        """No notification for email-only users."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "u.nostr_npub IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_query_dedup_by_month_reference(self):
        """No notification if same month reference already sent within 7 days."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "NOT EXISTS" in sql
        assert "membership_due" in sql
        # Dedup uses TO_CHAR(NOW(), 'YYYY-MM') as the reference
        assert "YYYY-MM" in sql
        assert "7 days" in sql

    @pytest.mark.asyncio
    async def test_not_sent_when_db_returns_empty(self):
        """Functional: DB returns [] -> no DMs."""
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_membership_due()
        assert result == []


class TestCreditTopupFalsePositivePrevention:
    """Credit top-up should NOT notify when conditions are unmet."""

    @pytest.mark.asyncio
    async def test_query_uses_threshold_to_exclude_sufficient_credits(self):
        """No notification if user has >= 15,000 sats (sufficient credits)."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        # Query uses $1 parameter which is CREDIT_LOW_THRESHOLD_SATS
        assert "< $1" in sql
        # Verify the threshold value is passed
        threshold_arg = pool.fetch.call_args[0][1]
        assert threshold_arg == 15_000

    @pytest.mark.asyncio
    async def test_query_requires_services_in_rotation_queue(self):
        """No notification if user has no services in rotation queue.
        The LATERAL JOIN ensures at least one rotation_queue entry exists."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "rotation_queue" in sql
        assert "LATERAL" in sql

    @pytest.mark.asyncio
    async def test_query_requires_active_status(self):
        """No notification for churned users."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "u.status = 'active'" in sql

    @pytest.mark.asyncio
    async def test_query_requires_nostr_npub(self):
        """No notification for email-only users."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "u.nostr_npub IS NOT NULL" in sql

    @pytest.mark.asyncio
    async def test_query_dedup_14_day_window(self):
        """No notification if credit_topup sent within last 14 days."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "NOT EXISTS" in sql
        assert "credit_topup" in sql
        assert "14 days" in sql

    @pytest.mark.asyncio
    async def test_not_sent_when_db_returns_empty(self):
        """Functional: DB returns [] -> no DMs."""
        pool = _make_pool_mock()
        pool.fetch.return_value = []
        with patch("notifications.db._get_pool", return_value=pool):
            result = await notifications.get_users_credit_topup()
        assert result == []


# ═══════════════════════════════════════════════════════════════
# B. DEDUPLICATION TIMING — SQL interval verification + orchestrator behavior
# ═══════════════════════════════════════════════════════════════
#
# Since the DB is mocked, we verify dedup at two levels:
#   1. SQL text contains the correct interval strings
#   2. Orchestrator behavior: when a query returns users on call 1 and
#      empty on call 2, only call 1 triggers DMs.


class TestDedupIntervalInSQL:
    """Verify the SQL queries use the correct dedup interval strings."""

    @pytest.mark.asyncio
    async def test_lock_in_uses_7_day_interval(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "NOW() - INTERVAL '7 days'" in sql

    @pytest.mark.asyncio
    async def test_membership_uses_7_day_interval(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "NOW() - INTERVAL '7 days'" in sql

    @pytest.mark.asyncio
    async def test_credit_topup_uses_14_day_interval(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "NOW() - INTERVAL '14 days'" in sql

    @pytest.mark.asyncio
    async def test_lock_in_dedup_checks_sent_at(self):
        """Dedup comparison is on sent_at, not created_at or some other field."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        assert "nl.sent_at > NOW() - INTERVAL" in sql

    @pytest.mark.asyncio
    async def test_membership_dedup_checks_sent_at(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "nl.sent_at > NOW() - INTERVAL" in sql

    @pytest.mark.asyncio
    async def test_credit_topup_dedup_checks_sent_at(self):
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        assert "nl.sent_at > NOW() - INTERVAL" in sql


class TestDedupReferenceIdBehavior:
    """Verify reference_id-based dedup: different references allow re-notification."""

    @pytest.mark.asyncio
    async def test_lock_in_dedup_is_per_service(self):
        """Lock-in dedup uses next_service_id as reference — different service = new notification."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_lock_in_approaching()
        sql = pool.fetch.call_args[0][0]
        # The NOT EXISTS subquery matches on reference_id = rs.next_service_id
        assert "nl.reference_id = rs.next_service_id" in sql

    @pytest.mark.asyncio
    async def test_membership_dedup_is_per_month(self):
        """Membership dedup uses YYYY-MM as reference — different month = new notification."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_membership_due()
        sql = pool.fetch.call_args[0][0]
        assert "TO_CHAR(NOW(), 'YYYY-MM')" in sql

    @pytest.mark.asyncio
    async def test_credit_topup_has_no_reference_id_filter(self):
        """Credit topup dedup does NOT filter on reference_id — purely time-based."""
        pool = _make_pool_mock()
        with patch("notifications.db._get_pool", return_value=pool):
            await notifications.get_users_credit_topup()
        sql = pool.fetch.call_args[0][0]
        # The NOT EXISTS subquery for credit_topup should NOT contain reference_id
        # Extract just the credit_topup NOT EXISTS block
        topup_not_exists_start = sql.index("NOT EXISTS")
        topup_block = sql[topup_not_exists_start:]
        assert "reference_id" not in topup_block

    @pytest.mark.asyncio
    async def test_lock_in_record_uses_next_service_id(self):
        """Orchestrator records lock-in with next_service_id as reference."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        lock_in_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Hulu",
                "estimated_start_date": datetime(2026, 4, 1),
                "next_service_id": "hulu",
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=lock_in_data)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        mock_record.assert_called_once_with(USER_ID, "lock_in_approaching", "hulu")

    @pytest.mark.asyncio
    async def test_membership_record_uses_year_month_reference(self):
        """Orchestrator records membership_due with YYYY-MM reference."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        membership_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "membership_plan": "duo",
                "billing_period": "annual",
                "membership_expires_at": datetime(2026, 3, 1),
                "price_sats": 5850,
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=[])),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=membership_data)),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        call_args = mock_record.call_args[0]
        assert call_args[0] == USER_ID
        assert call_args[1] == "membership_due"
        # Reference should be current YYYY-MM format
        reference = call_args[2]
        assert len(reference) == 7  # "YYYY-MM"
        assert reference[4] == "-"

    @pytest.mark.asyncio
    async def test_credit_topup_record_uses_none_reference(self):
        """Orchestrator records credit_topup with None reference."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        topup_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "credit_sats": 2000,
                "cheapest_service_name": "Hulu",
                "cheapest_service_price_cents": 1899,
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=[])),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=topup_data)),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        mock_record.assert_called_once_with(USER_ID, "credit_topup", None)


# ═══════════════════════════════════════════════════════════════
# C. INTEGRATION-LEVEL DEDUP — orchestrator behavior
# ═══════════════════════════════════════════════════════════════
#
# These test check_and_send_notifications end-to-end by controlling
# what the query mocks return on successive calls to simulate the
# dedup log existing after the first send.


class TestOrchestratorDedup:
    """Integration tests for dedup behavior in check_and_send_notifications."""

    @pytest.mark.asyncio
    async def test_first_run_sends_second_run_skips(self):
        """First call returns users -> sends DMs + records. Second call returns
        empty (simulating log entries now existing) -> no DMs."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        user_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Netflix",
                "estimated_start_date": datetime(2026, 3, 15),
                "next_service_id": "netflix",
            }
        ]

        # First run: query returns the user
        lock_in_mock = AsyncMock(return_value=user_data)
        with (
            patch("notifications.get_users_lock_in_approaching", lock_in_mock),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        assert mock_client.send_private_msg.call_count == 1
        assert mock_record.call_count == 1

        # Reset mocks for second run
        mock_client.reset_mock()

        # Second run: query returns empty (dedup log now has the record)
        lock_in_mock_empty = AsyncMock(return_value=[])
        with (
            patch("notifications.get_users_lock_in_approaching", lock_in_mock_empty),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record_2,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        mock_client.send_private_msg.assert_not_called()
        mock_record_2.assert_not_called()

    @pytest.mark.asyncio
    async def test_mixed_batch_only_notifies_eligible_users(self):
        """Two users in lock-in query results: one was recently notified (filtered
        by SQL), so only one appears. Verify exactly 1 DM sent."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        # Only the eligible user appears (the other was filtered by NOT EXISTS)
        eligible_only = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Hulu",
                "estimated_start_date": datetime(2026, 3, 20),
                "next_service_id": "hulu",
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=eligible_only)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        # Only 1 user should receive a DM
        assert mock_client.send_private_msg.call_count == 1
        mock_record.assert_called_once()

    @pytest.mark.asyncio
    async def test_all_three_types_for_same_user(self):
        """Same user qualifies for all three notification types. All three
        should send because different notification types have independent dedup."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        lock_in_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Netflix",
                "estimated_start_date": datetime(2026, 3, 15),
                "next_service_id": "netflix",
            }
        ]
        membership_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "membership_plan": "solo",
                "billing_period": "monthly",
                "membership_expires_at": datetime(2026, 2, 20),
                "price_sats": 4400,
            }
        ]
        topup_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "credit_sats": 3000,
                "cheapest_service_name": "Peacock",
                "cheapest_service_price_cents": 1099,
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=lock_in_data)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=membership_data)),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=topup_data)),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        # All 3 DMs sent to the same user for 3 different types
        assert mock_client.send_private_msg.call_count == 3
        assert mock_record.call_count == 3

        # Verify all three notification types were recorded
        recorded_types = {call[0][1] for call in mock_record.call_args_list}
        assert recorded_types == {"lock_in_approaching", "membership_due", "credit_topup"}

    @pytest.mark.asyncio
    async def test_different_service_allows_new_lock_in_notification(self):
        """User was notified about service A (via SQL dedup), but now next_service_id
        changed to service B. The query would return them again because the
        reference_id is different. Verify a DM is sent."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        # Service B is now the next service (service A notification in log
        # doesn't block this because reference_id differs)
        service_b_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Disney+",
                "estimated_start_date": datetime(2026, 4, 1),
                "next_service_id": "disney_plus",
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=service_b_data)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        assert mock_client.send_private_msg.call_count == 1
        mock_record.assert_called_once_with(USER_ID, "lock_in_approaching", "disney_plus")

    @pytest.mark.asyncio
    async def test_different_notification_type_sends_independently(self):
        """User was recently notified for membership_due (dedup blocks it), but
        credit_topup was never sent. Credit topup should still send."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        # membership_due blocked by dedup (returns empty), credit_topup eligible
        topup_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "credit_sats": 5000,
                "cheapest_service_name": "Prime Video",
                "cheapest_service_price_cents": 899,
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=[])),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=topup_data)),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        assert mock_client.send_private_msg.call_count == 1
        mock_record.assert_called_once_with(USER_ID, "credit_topup", None)

    @pytest.mark.asyncio
    async def test_multiple_users_each_get_one_notification(self):
        """Two different users both qualify for lock-in. Both get DMs."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        user_id_3 = UUID("cccccccc-dddd-eeee-ffff-111111111111")
        npub_3 = "9876fedc" * 8

        two_users = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Netflix",
                "estimated_start_date": datetime(2026, 3, 15),
                "next_service_id": "netflix",
            },
            {
                "user_id": user_id_3,
                "nostr_npub": npub_3,
                "next_service_name": "Hulu",
                "estimated_start_date": datetime(2026, 3, 18),
                "next_service_id": "hulu",
            },
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=two_users)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        assert mock_client.send_private_msg.call_count == 2
        assert mock_record.call_count == 2

        # Verify both users' notifications were recorded
        recorded_user_ids = {call[0][0] for call in mock_record.call_args_list}
        assert recorded_user_ids == {USER_ID, user_id_3}

    @pytest.mark.asyncio
    async def test_record_not_called_when_dm_fails(self):
        """If DM sending fails, record_notification must NOT be called.
        This ensures the next cycle will retry sending."""
        mock_client = AsyncMock()
        mock_client.send_private_msg.side_effect = Exception("relay timeout")
        mock_signer = AsyncMock()

        membership_data = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "membership_plan": "solo",
                "billing_period": "monthly",
                "membership_expires_at": datetime(2026, 2, 25),
                "price_sats": 4400,
            }
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=[])),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=membership_data)),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        # DM failed, so notification should NOT be recorded (allows retry)
        mock_record.assert_not_called()

    @pytest.mark.asyncio
    async def test_partial_failure_records_only_successful(self):
        """If DM fails for one user but succeeds for another, only the
        successful one gets a notification_log record."""
        mock_client = AsyncMock()
        mock_signer = AsyncMock()

        user_id_3 = UUID("cccccccc-dddd-eeee-ffff-111111111111")
        npub_3 = "9876fedc" * 8

        # send_private_msg: fails for first call, succeeds for second
        mock_client.send_private_msg.side_effect = [
            Exception("relay down"),  # first user fails
            None,                      # second user succeeds
        ]

        two_users = [
            {
                "user_id": USER_ID,
                "nostr_npub": NPUB_HEX,
                "next_service_name": "Netflix",
                "estimated_start_date": datetime(2026, 3, 15),
                "next_service_id": "netflix",
            },
            {
                "user_id": user_id_3,
                "nostr_npub": npub_3,
                "next_service_name": "Hulu",
                "estimated_start_date": datetime(2026, 3, 18),
                "next_service_id": "hulu",
            },
        ]

        with (
            patch("notifications.get_users_lock_in_approaching", AsyncMock(return_value=two_users)),
            patch("notifications.get_users_membership_due", AsyncMock(return_value=[])),
            patch("notifications.get_users_credit_topup", AsyncMock(return_value=[])),
            patch("notifications.record_notification", AsyncMock()) as mock_record,
        ):
            await notifications.check_and_send_notifications(mock_client, mock_signer)

        # 2 DM attempts, but only 1 succeeded
        assert mock_client.send_private_msg.call_count == 2
        # Only the successful one got recorded
        mock_record.assert_called_once_with(user_id_3, "lock_in_approaching", "hulu")
