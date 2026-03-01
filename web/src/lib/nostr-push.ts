import { readFileSync } from "fs";
import { wrapEvent } from "nostr-tools/nip17";
import { decode, npubEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";
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
  if (!keyFile) {
    console.warn("[nostr-push] VPS_NOSTR_PRIVKEY_FILE not set. Set this to the path of your Nostr private key file.");
    return null;
  }
  try {
    return readFileSync(keyFile, "utf8").trim();
  } catch (err) {
    console.warn("Failed to read VPS_NOSTR_PRIVKEY_FILE:", (err as Error).message);
    return null;
  }
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

function getTtsBotPubkey(): string | null {
  const value = process.env.TTS_BOT_NPUB;
  if (!value) return null;
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
 * Publish a NIP-17 gift-wrapped DM to a specific recipient.
 *
 * Best-effort: logs errors but never throws. The VPS should not crash
 * if a relay is unreachable.
 */
async function sendPushDMTo(
  recipientPubkey: string,
  payload: Record<string, unknown>
): Promise<void> {
  const payloadType = payload.type ?? "unknown";

  const privkey = getPrivkeyBytes();
  if (!privkey) {
    console.warn("[nostr-push] VPS_NOSTR_PRIVKEY not set, skipping push");
    return;
  }

  const relays = getRelays();
  if (relays.length === 0) {
    console.warn("[nostr-push] No relays configured, skipping push");
    return;
  }

  const senderPubkeyHex = getPublicKey(privkey);
  const senderNpub = npubEncode(senderPubkeyHex);
  const recipientNpub = recipientPubkey.length === 64 ? npubEncode(recipientPubkey) : recipientPubkey;

  console.log(
    `[nostr-push] Sending type=${payloadType} FROM ${senderNpub} TO ${recipientNpub} via ${relays.join(", ")}`
  );

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
  } else {
    console.log(`[nostr-push] type=${payloadType} published to ${succeeded}/${relays.length} relays OK`);
  }
}

/**
 * Publish a NIP-17 gift-wrapped DM to the orchestrator.
 *
 * Best-effort: logs errors but never throws. The VPS should not crash
 * if a relay is unreachable.
 */
async function sendPushDM(payload: Record<string, unknown>): Promise<void> {
  const payloadType = payload.type ?? "unknown";

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

  // Derive our own pubkey from privkey so we can log the sender identity
  const senderPubkeyHex = getPublicKey(privkey);
  const senderNpub = npubEncode(senderPubkeyHex);
  const recipientNpub = recipientPubkey.length === 64 ? npubEncode(recipientPubkey) : recipientPubkey;

  console.log(
    `[nostr-push] Sending type=${payloadType} FROM ${senderNpub} TO ${recipientNpub} via ${relays.join(", ")}`
  );

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
  } else {
    console.log(`[nostr-push] type=${payloadType} published to ${succeeded}/${relays.length} relays OK`);
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
  amountSats: number,
  jobId: string
): Promise<void> {
  await sendPushDM({
    type: "payment_received",
    data: {
      npub_hex: npubHex,
      service_name: serviceName,
      amount_sats: amountSats,
      job_id: jobId,
    },
    timestamp: Date.now(),
  });
}

export async function pushPaymentExpired(
  npubHex: string,
  serviceName: string,
  debtSats: number,
  jobId: string
): Promise<void> {
  await sendPushDM({
    type: "payment_expired",
    data: {
      npub_hex: npubHex,
      service_name: serviceName,
      debt_sats: debtSats,
      job_id: jobId,
    },
    timestamp: Date.now(),
  });
}

export async function pushAutoInvite(npubHex: string, otpCode: string): Promise<void> {
  await sendPushDM({
    type: "auto_invite",
    data: { npub_hex: npubHex, otp_code: otpCode },
    timestamp: Date.now(),
  });
}

export async function pushAudioPaymentReceived(
  requesterNpub: string,
  amountSats: number,
  audioJobId: string,
  audioCacheId: string,
  tweetText: string,
  tweetAuthor: string | null,
  wasCached: boolean
): Promise<void> {
  const ttsBotPubkey = getTtsBotPubkey();
  if (!ttsBotPubkey) {
    console.warn("[nostr-push] TTS_BOT_NPUB not set, skipping audio push");
    return;
  }

  await sendPushDMTo(ttsBotPubkey, {
    type: "audio_payment_received",
    data: {
      requester_npub: requesterNpub,
      amount_sats: amountSats,
      audio_job_id: audioJobId,
      audio_cache_id: audioCacheId,
      tweet_text: tweetText,
      tweet_author: tweetAuthor,
      was_cached: wasCached,
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
