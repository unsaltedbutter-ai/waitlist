# Dashboard UI Copy

## Page Title
Your rotation

## Subscription Status Messages

### Active
**[Service Name]** — active through [date]
Helper: You have full access to this service until the date shown.

### Scheduled
**[Service Name]** — scheduled to start [date]
Helper: We'll activate this when your current service ends.

### Lapsing
**[Service Name]** — winding down, ends ~[date]
Helper: Gift card balance running out. Service will end naturally.

### Lapsed
**[Service Name]** — ended [date]
Helper: Gift card expired. Next service in your queue activates soon.

### Signup in Progress
**[Service Name]** — signing up now
Helper: We're setting up your subscription. This usually takes a few minutes.

### Signup Failed (not shown to user — operator only)
*This state is never displayed on the dashboard. The system retries silently.*

### Paused
**[Service Name]** — paused
Helper: This service is in your queue but won't activate until you unpause it.

### Skipped
**[Service Name]** — skipped this cycle
Helper: This service was skipped. It stays in your queue for next time.

---

## Queue Section

### Section Title
Rotation queue

### Explanation Text
Services rotate from top to bottom. When the last service finishes, the queue loops back to the top. Drag to reorder.

### Empty Queue
No services in your queue. Add at least two to start rotating.

### Single Service Warning
You only have one service. Add another to enable rotation.

---

## Action Buttons

### Stay Button
**Label:** Stay on [Service Name]
**Tooltip:** Buy another gift card to keep this service for another cycle.
**Confirmation:** Stay on [Service Name]? We'll purchase another gift card (~$XX) from your BTC balance.

### Skip Button
**Label:** Skip [Service Name]
**Tooltip:** Skip this service in the current rotation and move to the next one.
**Confirmation:** Skip [Service Name] this cycle? It stays in your queue for next time.

### Reorder Button
**Label:** Edit queue
**Tooltip:** Drag to change your rotation order.

### Pause Service Button
**Label:** Pause
**Tooltip:** Remove this service from rotation without deleting it.

### Remove Service Button
**Label:** Remove
**Tooltip:** Remove this service from your queue entirely.
**Confirmation:** Remove [Service Name]? This deletes your stored credentials for this service.

---

## Rotation Calendar

### Section Title
Schedule

### Explanation Text
Estimated rotation dates based on typical 30-day billing cycles. Actual dates may shift by a day or two depending on the service.

### Month View Label
[Month Year]

---

## Account Section

### Service Credits
**Balance display:** XX,XXX sats (~$XX.XX)
**Add credits button:** Add credits
**Low balance warning:** Your credits may not cover the next rotation. Add more to keep your queue moving.

### Membership Status
**Active:** Membership active. Balance: XX,XXX sats.
**Expiring:** Membership expires [date]. Add credits to keep your rotation going.
**Expired:** Membership expired. Your credentials have been destroyed.

### Payment History Label
Payment history

### Update Credentials Button
Update credentials

### Danger Zone
**Delete account:** This destroys all your data immediately. Credentials, payment history, queue — everything. This cannot be undone.
**CTA:** Delete my account
**Confirmation:** This is permanent. All your stored credentials and data will be destroyed immediately. Type "destroy" to confirm.
