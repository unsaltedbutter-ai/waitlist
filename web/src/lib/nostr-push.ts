import { readFileSync } from "fs";
import { wrapEvent } from "nostr-tools/nip17";
import { decode } from "nostr-tools/nip19";
import { SimplePool } from "nostr-tools/pool";
import { hexToBytes } from "nostr-tools/utils";

const DEFAULT_RELAYS =
  "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band";

const PUBLISH_TIMEOUT_MS = 5_000;

// Lazy-initialized pool (reused across calls)
let pool: SimplePool | null = null;

function getPool(): SimplePool {
  if (!pool) {
    pool = new SimplePool();
  }
  return pool;
}

function getRelays(): string[] {
  const raw = process.env.NOSTR_RELAYS || DEFAULT_RELAYS;
  return raw.split(",").map((r) => r.trim()).filter(Boolean);
}

function getPrivKey(): string | null {
  const keyFile = process.env.VPS_NOSTR_PRIVKEY_FILE;
  if (keyFile) {
    try {
      return readFileSync(keyFile, "utf8").trim();
    } catch (err) {
      console.warn("Failed to read VPS_NOSTR_PRIVKEY_FILE:", (err as Error).message);
      return null;
    }
  }
  return process.env.VPS_NOSTR_PRIVKEY ?? null;
}

function getPrivkeyBytes(): Uint8Array | null {
  const hex = getPrivKey();
  if (!hex) return null;
  return hexToBytes(hex);
}

function getRecipientPubkey(): string | null {
  const npub = process.env.ORCHESTRATOR_NPUB;
  if (!npub) return null;
  try {
    const decoded = decode(npub);
    if (decoded.type !== "npub") return null;
    return decoded.data;
  } catch {
    return null;
  }
}

/**
 * Publish a NIP-17 gift-wrapped DM to the orchestrator.
 *
 * Best-effort: logs errors but never throws. The VPS should not crash
 * if a relay is unreachable.
 */
async function sendPushDM(payload: Record<string, unknown>): Promise<void> {
  const privkey = getPrivkeyBytes();
  if (!privkey) {
    console.warn("[nostr-push] VPS_NOSTR_PRIVKEY not set, skipping push");
    return;
  }

  const recipientPubkey = getRecipientPubkey();
  if (!recipientPubkey) {
    console.warn("[nostr-push] ORCHESTRATOR_NPUB not set or invalid, skipping push");
    return;
  }

  const relays = getRelays();
  if (relays.length === 0) {
    console.warn("[nostr-push] No relays configured, skipping push");
    return;
  }

  const message = JSON.stringify(payload);

  let wrapped;
  try {
    wrapped = wrapEvent(privkey, { publicKey: recipientPubkey }, message);
  } catch (err) {
    console.error("[nostr-push] Failed to create gift-wrapped event:", err);
    return;
  }

  const p = getPool();
  const promises = p.publish(relays, wrapped);

  // Race each relay publish against a timeout
  const results = await Promise.allSettled(
    promises.map((pub) =>
      Promise.race([
        pub,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("publish timeout")), PUBLISH_TIMEOUT_MS)
        ),
      ])
    )
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  if (failed > 0) {
    const errors = results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => String(r.reason));
    console.warn(
      `[nostr-push] Published to ${succeeded}/${relays.length} relays. Failures: ${errors.join(", ")}`
    );
  }
}

// ---- Public push functions ----

export async function pushNewUser(npub: string): Promise<void> {
  await sendPushDM({
    type: "new_user",
    npub,
    timestamp: Date.now(),
  });
}

export async function pushJobsReady(jobIds: string[]): Promise<void> {
  await sendPushDM({
    type: "jobs_ready",
    job_ids: jobIds,
    timestamp: Date.now(),
  });
}

export async function pushPaymentReceived(
  jobId: string,
  amountSats: number
): Promise<void> {
  await sendPushDM({
    type: "payment_received",
    job_id: jobId,
    amount_sats: amountSats,
    timestamp: Date.now(),
  });
}

export async function pushPaymentExpired(
  jobId: string,
  npub: string
): Promise<void> {
  await sendPushDM({
    type: "payment_expired",
    job_id: jobId,
    npub,
    timestamp: Date.now(),
  });
}

/** Reset the cached pool (for testing only). */
function resetPool(): void {
  pool = null;
}

// Exported for testing only
export { sendPushDM as _sendPushDM, getPool as _getPool, resetPool as _resetPool };
