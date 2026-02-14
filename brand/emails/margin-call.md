# Margin Call — Renewal Reminder Emails

Three emails in sequence. The tone escalates. "Margin call" is the metaphor: your position is expiring and you need to cover it.

---

## Day -7: First Notice

**Subject:** Your membership renews in 7 days.

**Body:**

Your UnsaltedButter membership renews on {{renewal_date}}.

Current balance due: {{amount}} (BTC/Lightning)

If you want to keep your rotation going, no action is needed — we'll send a Lightning invoice on renewal day. If you'd prefer to pay early, you can do that from your dashboard.

If you don't renew, your account and all stored credentials will be permanently destroyed on {{destruction_date}}. No grace period. No recovery.

**[Go to dashboard →]** {{dashboard_url}}

---

## Day -3: Second Notice

**Subject:** 3 days until your credentials are destroyed.

**Body:**

This is your second notice.

Your UnsaltedButter membership expires on {{renewal_date}}. We have not received payment.

On {{destruction_date}}, we will:
- Let any active streaming subscription lapse (gift card balance will expire naturally)
- Destroy all stored credentials (logins, gift card codes)
- Delete your account and all associated data
- Release your spot to the waitlist

None of this is reversible. If you want back in after expiry, you'll need a new invite.

**[Pay now →]** {{payment_url}}

---

## Day -1: Final Notice

**Subject:** Tomorrow your account is destroyed.

**Body:**

Last call.

Your membership expires tomorrow, {{renewal_date}}. After midnight EST, everything is gone.

Your streaming credentials. Your rotation queue. Your payment history. Your account. All of it — destroyed. Your spot goes to someone on the waitlist.

We are not going to email you again after this.

**[Pay now →]** {{payment_url}}

---

## Day 0 (post-destruction, no email sent)

No email is sent on Day 0. The account is destroyed silently. If the user attempts to log in, they see the "Account Destroyed" error page (see errors.md).

---

# Service Credit Margin Calls

Different from membership renewal. This fires when the user's service credits are too low to cover the next gift card purchase in their rotation.

---

## Day -10: Low Balance Warning (in-app only)

This is shown on the dashboard, not emailed. Just documenting the copy.

**Banner text:** Your service credits may not cover your next rotation. Add more to keep your queue moving.
**CTA:** Add credits

---

## Day -5: Email Warning

**Subject:** Low balance — your rotation may pause.

**Body:**

Your BTC balance is running low.

Your current service (**{{current_service}}**) is winding down around **{{lapse_date}}**. The next service in your queue (**{{next_service}}**) needs a **{{gift_card_amount}}** gift card, which costs approximately **{{cost_sats}} sats**.

Your current balance: **{{balance_sats}} sats**

If your balance isn't enough when rotation day comes, we'll pause your queue until you add more credits.

**[Add credits →]** {{deposit_url}}

---

## Day -3: Urgent Email

**Subject:** Your rotation pauses in 3 days — add credits.

**Body:**

Your **{{current_service}}** subscription ends around **{{lapse_date}}**.

We need approximately **{{cost_sats}} sats** to buy a **{{next_service}}** gift card, and your balance is **{{balance_sats}} sats**. That's not enough.

Without more credits, your rotation will pause. You won't lose your spot or your queue order — it just waits until you add credits.

**[Add credits now →]** {{deposit_url}}

---

## Lapse Day: Rotation Paused

**Subject:** Rotation paused — insufficient balance.

**Body:**

Your **{{current_service}}** subscription has ended, and your BTC balance is too low to activate **{{next_service}}**.

Your rotation is paused. Your queue order is preserved. Add credits and your rotation resumes automatically.

**[Add credits →]** {{deposit_url}}
