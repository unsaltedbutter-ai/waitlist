"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams } from "next/navigation";

interface AudioMeta {
  token: string;
  plays_remaining: number;
  max_plays: number;
  tweet_text: string;
  tweet_author: string | null;
  tweet_url: string;
  char_count: number;
  duration_seconds: number | null;
  has_audio: boolean;
  exhausted: boolean;
}

interface RefillResponse {
  invoice_id: string;
  bolt11: string;
  amount_sats: number;
  already_pending?: boolean;
}

type PageState = "loading" | "playing" | "exhausted" | "expired" | "error";

export default function ListenPage() {
  const params = useParams();
  const token = params.token as string;

  const [state, setState] = useState<PageState>("loading");
  const [meta, setMeta] = useState<AudioMeta | null>(null);
  const [error, setError] = useState<string>("");
  const [refill, setRefill] = useState<RefillResponse | null>(null);
  const [refillLoading, setRefillLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const fetchMeta = useCallback(async () => {
    try {
      const res = await fetch(`/api/audio/${token}/meta`);
      if (res.status === 404) {
        setState("expired");
        return null;
      }
      if (!res.ok) {
        setState("error");
        setError("Failed to load audio info");
        return null;
      }
      const data: AudioMeta = await res.json();
      setMeta(data);

      if (!data.has_audio) {
        setState("loading");
      } else if (data.exhausted) {
        setState("exhausted");
      } else {
        setState("playing");
      }
      return data;
    } catch {
      setState("error");
      setError("Network error");
      return null;
    }
  }, [token]);

  useEffect(() => {
    fetchMeta();
  }, [fetchMeta]);

  // Set up Media Session API for lock-screen controls
  useEffect(() => {
    if (meta && "mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.tweet_author
          ? `Post by ${meta.tweet_author}`
          : "X.com Post Audio",
        artist: meta.tweet_author ?? "Unknown",
        album: "UnsaltedButter Audio",
      });
    }
  }, [meta]);

  const handleRefill = async () => {
    setRefillLoading(true);
    try {
      const res = await fetch(`/api/audio/${token}/refill`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error || "Refill failed");
        return;
      }
      const data: RefillResponse = await res.json();
      setRefill(data);

      // Start polling for payment
      pollRef.current = setInterval(async () => {
        const refreshed = await fetchMeta();
        if (refreshed && refreshed.plays_remaining > 0) {
          if (pollRef.current) clearInterval(pollRef.current);
          setRefill(null);
          setState("playing");
        }
      }, 3000);
    } catch {
      setError("Refill request failed");
    } finally {
      setRefillLoading(false);
    }
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const copyBolt11 = async () => {
    if (refill?.bolt11) {
      await navigator.clipboard.writeText(refill.bolt11);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-xl font-semibold text-zinc-200">
            UnsaltedButter Audio
          </h1>
        </div>

        {state === "loading" && (
          <div className="bg-zinc-900 rounded-2xl p-8 text-center">
            <div className="animate-pulse text-zinc-400">
              Loading audio...
            </div>
          </div>
        )}

        {state === "error" && (
          <div className="bg-zinc-900 rounded-2xl p-8 text-center">
            <p className="text-red-400">{error}</p>
          </div>
        )}

        {state === "expired" && (
          <div className="bg-zinc-900 rounded-2xl p-8 text-center">
            <p className="text-zinc-400 text-lg mb-2">
              This audio has expired.
            </p>
            <p className="text-zinc-500 text-sm">
              DM the bot to regenerate it.
            </p>
          </div>
        )}

        {(state === "playing" || state === "exhausted") && meta && (
          <div className="bg-zinc-900 rounded-2xl overflow-hidden">
            {/* Tweet info */}
            <div className="p-6 border-b border-zinc-800">
              {meta.tweet_author && (
                <p className="text-sm text-zinc-400 mb-2">
                  {meta.tweet_author}
                </p>
              )}
              <p className="text-zinc-300 text-sm leading-relaxed max-h-48 overflow-y-auto">
                {meta.tweet_text.length > 500
                  ? meta.tweet_text.substring(0, 500) + "..."
                  : meta.tweet_text}
              </p>
              <a
                href={meta.tweet_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-zinc-500 hover:text-zinc-400 mt-2 inline-block"
              >
                View original post
              </a>
            </div>

            {/* Player */}
            {state === "playing" && (
              <div className="p-6">
                <audio
                  ref={audioRef}
                  preload="auto"
                  controls
                  className="w-full mb-4"
                  style={{
                    filter: "invert(1) hue-rotate(180deg)",
                    borderRadius: "8px",
                  }}
                >
                  <source
                    src={`/api/audio/${token}/stream`}
                    type="audio/mpeg"
                  />
                </audio>

                <div className="flex items-center justify-between text-sm text-zinc-400">
                  <span>
                    {meta.plays_remaining} of {meta.max_plays} plays remaining
                  </span>
                  {meta.duration_seconds && (
                    <span>{formatDuration(meta.duration_seconds)}</span>
                  )}
                </div>

                {/* Download button */}
                <a
                  href={`/api/audio/${token}/stream`}
                  download={`post-${token}.mp3`}
                  className="mt-4 block w-full text-center py-3 px-4 bg-zinc-800 hover:bg-zinc-700 rounded-xl text-zinc-200 text-sm font-medium transition-colors"
                >
                  Download MP3
                </a>
              </div>
            )}

            {/* Exhausted */}
            {state === "exhausted" && !refill && (
              <div className="p-6 text-center">
                <p className="text-zinc-400 mb-4">No plays remaining</p>
                <button
                  onClick={handleRefill}
                  disabled={refillLoading}
                  className="w-full py-3 px-4 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 rounded-xl text-white font-medium transition-colors"
                >
                  {refillLoading ? "Creating invoice..." : "Get more plays"}
                </button>
              </div>
            )}

            {/* Refill invoice */}
            {state === "exhausted" && refill && (
              <div className="p-6 text-center">
                <p className="text-zinc-400 mb-2">
                  Pay {refill.amount_sats} sats for {meta.max_plays} more plays
                </p>
                <div className="bg-zinc-800 rounded-xl p-4 mb-4">
                  <p className="text-xs text-zinc-500 mb-2 break-all font-mono">
                    {refill.bolt11.substring(0, 60)}...
                  </p>
                  <button
                    onClick={copyBolt11}
                    className="text-sm text-amber-400 hover:text-amber-300"
                  >
                    {copied ? "Copied!" : "Copy invoice"}
                  </button>
                </div>
                <p className="text-xs text-zinc-500 animate-pulse">
                  Waiting for payment...
                </p>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="text-center mt-6">
          <p className="text-xs text-zinc-600">
            Powered by UnsaltedButter.ai
          </p>
        </div>
      </div>
    </div>
  );
}
