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
  const raw = getPrivKey();
  if (!raw) return null;
  if (raw.startsWith("nsec1")) {
    try {
      const decoded = decode(raw);
      if (decoded.type !== "nsec") return null;
      return decoded.data;
    } catch {
      return null;
    }
  }
  return hexToBytes(raw);
}

function getRecipientPubkey(): string | null {
  const value = process.env.ORCHESTRATOR_NPUB;
  if (!value) return null;
  // Accept raw hex (64 chars) or npub1 bech32
  if (!value.startsWith("npub1")) {
    return /^[0-9a-f]{64}$/i.test(value) ? value : null;
  }
  try {
    const decoded = decode(value);
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
//
// Payload format: { type, data: { ... }, timestamp }
// The bot (notifications.py) expects "type" + nested "data" object.

export async function pushNewUser(npub: string): Promise<void> {
  await sendPushDM({
    type: "new_user",
    data: {
      npub,
    },
    timestamp: Date.now(),
  });
}

export async function pushJobsReady(jobIds: string[]): Promise<void> {
  await sendPushDM({
    type: "jobs_ready",
    data: {
      job_ids: jobIds,
    },
    timestamp: Date.now(),
  });
}

export async function pushPaymentReceived(
  npubHex: string,
  serviceName: string,
  amountSats: number
): Promise<void> {
  await sendPushDM({
    type: "payment_received",
    data: {
      npub_hex: npubHex,
      service_name: serviceName,
      amount_sats: amountSats,
    },
    timestamp: Date.now(),
  });
}

export async function pushPaymentExpired(
  npubHex: string,
  serviceName: string,
  debtSats: number
): Promise<void> {
  await sendPushDM({
    type: "payment_expired",
    data: {
      npub_hex: npubHex,
      service_name: serviceName,
      debt_sats: debtSats,
    },
    timestamp: Date.now(),
  });
}

/** Reset the cached pool (for testing only). */
function resetPool(): void {
  pool = null;
}

// Exported for testing only
export { sendPushDM as _sendPushDM, getPool as _getPool, resetPool as _resetPool };
