# Playbooks

Playbook JSON files drive the browser automation agent through cancel/resume flows.

## Schema

Each playbook is a JSON file with this structure:

```json
{
  "service": "netflix",
  "flow": "cancel",
  "version": 1,
  "tier": "",
  "last_validated": null,
  "notes": "Human-readable notes about this playbook",
  "steps": [...]
}
```

### Step Types

| Action | Description |
|--------|-------------|
| `navigate` | Open a URL (`url` field) |
| `click` | Click an element described by `target_description` |
| `type_text` | Type into a field. `value` uses template vars: `{email}`, `{pass}`, `{gift}`, `{zip}` |
| `press_key` | Press a key (`value`: `tab`, `enter`, `escape`) |
| `scroll` | Scroll the page (`target_description`: `down N` or `up N`) |
| `wait` | Random delay between `wait_after_sec[0]` and `wait_after_sec[1]` seconds |
| `select_plan` | Choose a subscription plan tier |
| `select_payment_method` | Choose a payment method |
| `handle_retention` | Click through retention offers (`may_repeat` + `max_repeats`) |
| `verify_success` | Verify the action completed successfully |
| `hover` | Move mouse to a region (no click) |

### Step Fields

| Field | Type | Description |
|-------|------|-------------|
| `action` | string | Required. Step type (see above). |
| `target_description` | string | Human description of the UI element to interact with. |
| `url` | string | URL for `navigate` actions. |
| `value` | string | Text to type or key to press. Supports template vars. |
| `sensitive` | bool | If true, value is never logged or sent to VLM. |
| `optional` | bool | If true, failure does not abort the playbook. |
| `disabled` | bool | If true, step is skipped during execution. |
| `checkpoint` | bool | If true, VLM verifies page state after this step. |
| `checkpoint_prompt` | string | Prompt for the VLM checkpoint verification. |
| `may_repeat` | bool | If true, step can be retried up to `max_repeats` times. |
| `max_repeats` | int | Max retry count (default 3). |
| `wait_after_sec` | [float, float] | Random delay range [min, max] seconds. |
| `fallback` | string | `"infer"` = use VLM if step cannot be resolved. |
| `ref_region` | [int, int, int, int] | Reference bounding box from recording [x1, y1, x2, y2]. |

### File Naming

Files follow the pattern `{service}_{flow}[_{variant}].json`:
- `netflix_cancel.json` (base variant)
- `netflix_cancel_home.json` (variant starting from home page)
- `netflix_resume_standard_with_ads_home.json` (tier in filename)

Multiple variants per (service, flow) pair are supported. The agent picks one at random.

## Real Playbooks

Real service playbooks are in the private `unsaltedbutter-prompts` package.
Install it to populate this directory via `agent/config.py` resolution:

```
env var PLAYBOOK_DIR > unsaltedbutter-prompts package > this directory
```
