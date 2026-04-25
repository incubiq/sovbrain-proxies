import { errorResponse } from "./dispatchers";
import { buildUpstreamConfig, dispatchChatMulti, dispatchModelsMulti } from "./multi-upstream";

/**
 * sovBrain BYO AI Proxy — Cloudflare Worker reference implementation
 *
 * Implements the BYO AI Proxy Protocol v1 as defined in:
 * docs/SPECS_PROXY_PROTOCOL.md
 *
 * Environment variables (set via `wrangler secret put`):
 *   SOVBRAIN_PUBLIC_KEY    — base64 Ed25519 public key from sovBrain
 *   SOVBRAIN_USER_ID       — userId (UUID) this key belongs to
 *
 * Multi-upstream mode (preferred — set whichever upstreams you want):
 *   ANTHROPIC_API_KEY      — your Anthropic API key (sk-ant-...)
 *   OPENAI_API_KEY         — your OpenAI API key (sk-...)
 *   OLLAMA_URL             — your Ollama base URL (no trailing slash)
 *   OLLAMA_API_KEY         — optional Bearer token for hosted/gatewayed Ollama
 *   DEFAULT_UPSTREAM       — optional: "anthropic" | "openai" | "ollama"
 *
 * Legacy single-upstream mode (back-compat):
 *   PROVIDER_UPSTREAM_URL  — upstream provider base URL (no trailing slash)
 *   PROVIDER_API_KEY       — provider API key (never leaves this Worker)
 *
 * KV binding (wrangler.toml):
 *   NONCE_CACHE            — KV namespace for nonce deduplication
 */

export interface Env {
  SOVBRAIN_PUBLIC_KEY: string;
  SOVBRAIN_USER_ID: string;

  // Multi-upstream (preferred)
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OLLAMA_URL?: string;
  OLLAMA_API_KEY?: string; // optional — Bearer token for hosted/gatewayed Ollama
  DEFAULT_UPSTREAM?: string; // "anthropic" | "openai" | "ollama" — validated at runtime

  // Legacy single-upstream (back-compat)
  PROVIDER_UPSTREAM_URL?: string;
  PROVIDER_API_KEY?: string;

  NONCE_CACHE: KVNamespace;
}

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
const TIMESTAMP_WINDOW_SECONDS = 300; // ±5 minutes
const NONCE_TTL_SECONDS = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check — no auth required
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Signed endpoints
    const isChat = request.method === "POST" && url.pathname === CHAT_PATH;
    const isModels = request.method === "GET" && url.pathname === MODELS_PATH;
    if (!isChat && !isModels) {
      return errorResponse(404, "not_found", "Not found");
    }

    // --- 1. Extract required headers ---
    const protocol = request.headers.get("X-SovBrain-Protocol");
    const userId = request.headers.get("X-SovBrain-User");
    const timestamp = request.headers.get("X-SovBrain-Timestamp");
    const nonce = request.headers.get("X-SovBrain-Nonce");
    const signature = request.headers.get("X-SovBrain-Signature");

    if (!protocol || !userId || !timestamp || !nonce || !signature) {
      return errorResponse(400, "missing_headers", "Missing required sovBrain headers");
    }

    // --- 2. Protocol version check ---
    if (protocol !== "1") {
      return errorResponse(400, "unsupported_version", "Protocol version not supported");
    }

    // --- 3. UserId check ---
    if (userId !== env.SOVBRAIN_USER_ID) {
      return errorResponse(401, "signature_invalid", "Ed25519 signature verification failed");
    }

    // --- 4. Timestamp freshness ---
    const freshnessError = checkTimestamp(timestamp);
    if (freshnessError) {
      return freshnessError;
    }

    // --- 5. Read body (empty string for GET) ---
    const body = isChat ? await request.text() : "";

    // --- 6. Nonce deduplication (store before signature check to prevent timing-based bypass) ---
    const nonceError = await checkAndStoreNonce(env.NONCE_CACHE, userId, nonce);
    if (nonceError) {
      return nonceError;
    }

    // --- 7. Ed25519 signature verification ---
    const sigError = await verifySignature(
      env.SOVBRAIN_PUBLIC_KEY,
      signature,
      request.method,
      url.pathname,
      timestamp,
      nonce,
      body
    );
    if (sigError) {
      // Nonce was already stored; on invalid signature we accept the cost of
      // a burned nonce to avoid timing attacks that probe signature validity.
      return sigError;
    }

    // --- 8. Dispatch to upstream ---
    const cfg = buildUpstreamConfig(env);
    if (!cfg.anthropic && !cfg.openai && !cfg.ollama) {
      return errorResponse(
        500,
        "no_upstream_configured",
        "No upstream is configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_URL, or the legacy PROVIDER_UPSTREAM_URL + PROVIDER_API_KEY."
      );
    }

    if (isModels) {
      return dispatchModelsMulti(cfg);
    }
    return dispatchChatMulti(cfg, body);
  },
};

// ---------------------------------------------------------------------------
// Timestamp check
// ---------------------------------------------------------------------------

function checkTimestamp(timestampHeader: string): Response | null {
  const ts = parseInt(timestampHeader, 10);
  if (isNaN(ts)) {
    return errorResponse(401, "signature_expired", "Request timestamp outside the 5-minute window");
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_SECONDS) {
    return errorResponse(401, "signature_expired", "Request timestamp outside the 5-minute window");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Nonce deduplication
// ---------------------------------------------------------------------------

async function checkAndStoreNonce(
  kv: KVNamespace,
  userId: string,
  nonce: string
): Promise<Response | null> {
  const key = `${userId}:${nonce}`;
  const existing = await kv.get(key);
  if (existing !== null) {
    return errorResponse(409, "nonce_reused", "Nonce already used within the last 10 minutes");
  }
  await kv.put(key, "1", { expirationTtl: NONCE_TTL_SECONDS });
  return null;
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

async function verifySignature(
  publicKeyBase64: string,
  signatureBase64: string,
  method: string,
  pathname: string,
  timestamp: string,
  nonce: string,
  body: string
): Promise<Response | null> {
  try {
    const bodyHash = await sha256Hex(body);
    const canonical = `1\n${method}\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const canonicalBytes = new TextEncoder().encode(canonical);

    const publicKeyBytes = b64ToBytes(publicKeyBase64);
    const signatureBytes = b64ToBytes(signatureBase64);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    const isValid = await crypto.subtle.verify(
      "Ed25519",
      cryptoKey,
      signatureBytes,
      canonicalBytes
    );

    if (!isValid) {
      return errorResponse(401, "signature_invalid", "Ed25519 signature verification failed");
    }
  } catch {
    // Malformed key or signature bytes
    return errorResponse(401, "signature_invalid", "Ed25519 signature verification failed");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decode standard base64 to bytes without using Buffer (Workers-native only).
 * atob returns a binary string; we convert each char to its char code.
 * Returns Uint8Array<ArrayBuffer> explicitly so crypto.subtle accepts it.
 */
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
