/**
 * sovBrain BYO AI Proxy — Docker / Node 20 reference implementation
 *
 * Implements the BYO AI Proxy Protocol v1, identical wire format to the
 * Cloudflare Worker version. See ../cloudflare/src/index.ts for the
 * Workers variant; the protocol bytes are the same.
 *
 * Environment variables (read at startup):
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
 *   PROVIDER_API_KEY       — provider API key (never leaves this container)
 *
 * PORT                     — listen port (default 8787)
 *
 * Nonce cache is in-memory. For multi-replica deployments, replace
 * NonceStore with a Redis-backed implementation (see README).
 */

import http from "node:http";
import { webcrypto } from "node:crypto";
import { Readable } from "node:stream";
import { buildUpstreamConfig, dispatchChatMulti, dispatchModelsMulti } from "./multi-upstream.js";

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
const HEALTH_PATH = "/health";
const TIMESTAMP_WINDOW_SECONDS = 300; // ±5 minutes
const NONCE_TTL_SECONDS = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Env shape — mirrors cloudflare's Env interface (without KV, which is Node's
// in-memory NonceStore instead)
// ---------------------------------------------------------------------------

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
}

interface RuntimeConfig {
  env: Env;
  port: number;
}

// ---------------------------------------------------------------------------
// Config — read once at startup, fail fast if missing
// ---------------------------------------------------------------------------

function loadConfig(): RuntimeConfig {
  const requiredCore = ["SOVBRAIN_PUBLIC_KEY", "SOVBRAIN_USER_ID"];
  const missing = requiredCore.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[fatal] missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  const env: Env = {
    SOVBRAIN_PUBLIC_KEY: process.env.SOVBRAIN_PUBLIC_KEY!,
    SOVBRAIN_USER_ID: process.env.SOVBRAIN_USER_ID!,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OLLAMA_URL: process.env.OLLAMA_URL,
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
    DEFAULT_UPSTREAM: process.env.DEFAULT_UPSTREAM,
    PROVIDER_UPSTREAM_URL: process.env.PROVIDER_UPSTREAM_URL,
    PROVIDER_API_KEY: process.env.PROVIDER_API_KEY,
  };

  const hasMulti = !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.OLLAMA_URL);
  const hasLegacy = !!(env.PROVIDER_UPSTREAM_URL && env.PROVIDER_API_KEY);
  if (!hasMulti && !hasLegacy) {
    console.error(
      "[fatal] no upstream configured. Set one of:\n" +
      "  - Multi-upstream: ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_URL\n" +
      "  - Legacy: PROVIDER_UPSTREAM_URL + PROVIDER_API_KEY"
    );
    process.exit(1);
  }

  return {
    env,
    port: parseInt(process.env.PORT ?? "8787", 10),
  };
}

// ---------------------------------------------------------------------------
// In-memory nonce store with TTL
// ---------------------------------------------------------------------------

class NonceStore {
  private map = new Map<string, number>();

  has(key: string): boolean {
    const expiresAt = this.map.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt < Date.now()) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  put(key: string, ttlSeconds: number): void {
    this.map.set(key, Date.now() + ttlSeconds * 1000);
  }

  // Periodic sweep to keep the map from growing unboundedly even when
  // nonces are never re-checked. Called every 60s via setInterval.
  sweep(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.map) {
      if (expiresAt < now) this.map.delete(key);
    }
  }
}

const nonceStore = new NonceStore();

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const config = loadConfig();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[unhandled]", err);
    sendError(res, 500, "internal_error", "Internal server error");
  });
});

setInterval(() => nonceStore.sweep(), 60_000).unref();

server.listen(config.port, () => {
  const cfg = buildUpstreamConfig(config.env);
  const upstreams: string[] = [];
  if (cfg.anthropic) upstreams.push("anthropic");
  if (cfg.openai) upstreams.push("openai");
  if (cfg.ollama) upstreams.push(`ollama (${cfg.ollama.baseUrl})`);
  console.log(`[ready] sovbrain-proxy listening on port ${config.port}`);
  console.log(`[ready] upstreams: ${upstreams.join(", ")}${cfg.default ? ` (default: ${cfg.default})` : ""}`);
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";

  // Health check — no auth required
  if (method === "GET" && url.pathname === HEALTH_PATH) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // Signed endpoints
  const isChat = method === "POST" && url.pathname === CHAT_PATH;
  const isModels = method === "GET" && url.pathname === MODELS_PATH;
  if (!isChat && !isModels) {
    sendError(res, 404, "not_found", "Not found");
    return;
  }

  // --- 1. Extract required headers ---
  const protocol = headerOf(req, "x-sovbrain-protocol");
  const userId = headerOf(req, "x-sovbrain-user");
  const timestamp = headerOf(req, "x-sovbrain-timestamp");
  const nonce = headerOf(req, "x-sovbrain-nonce");
  const signature = headerOf(req, "x-sovbrain-signature");

  if (!protocol || !userId || !timestamp || !nonce || !signature) {
    sendError(res, 400, "missing_headers", "Missing required sovBrain headers");
    return;
  }

  // --- 2. Protocol version check ---
  if (protocol !== "1") {
    sendError(res, 400, "unsupported_version", "Protocol version not supported");
    return;
  }

  // --- 3. UserId check ---
  if (userId !== config.env.SOVBRAIN_USER_ID) {
    sendError(res, 401, "signature_invalid", "Ed25519 signature verification failed");
    return;
  }

  // --- 4. Timestamp freshness ---
  if (!isTimestampFresh(timestamp)) {
    sendError(res, 401, "signature_expired", "Request timestamp outside the 5-minute window");
    return;
  }

  // --- 5. Read body (empty string for GET) ---
  const body = isChat ? await readBody(req) : "";

  // --- 6. Nonce dedup (store before sig check, same as Cloudflare worker) ---
  const nonceKey = `${userId}:${nonce}`;
  if (nonceStore.has(nonceKey)) {
    sendError(res, 409, "nonce_reused", "Nonce already used within the last 10 minutes");
    return;
  }
  nonceStore.put(nonceKey, NONCE_TTL_SECONDS);

  // --- 7. Ed25519 signature verification ---
  const sigOk = await verifySignature(
    config.env.SOVBRAIN_PUBLIC_KEY,
    signature,
    method,
    url.pathname,
    timestamp,
    nonce,
    body
  );
  if (!sigOk) {
    sendError(res, 401, "signature_invalid", "Ed25519 signature verification failed");
    return;
  }

  // --- 8. Dispatch to upstream ---
  const cfg = buildUpstreamConfig(config.env);

  if (!cfg.anthropic && !cfg.openai && !cfg.ollama) {
    sendError(res, 500, "no_upstream_configured", "No upstream is configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_URL, or the legacy PROVIDER_UPSTREAM_URL + PROVIDER_API_KEY.");
    return;
  }

  const response = isModels
    ? await dispatchModelsMulti(cfg)
    : await dispatchChatMulti(cfg, body);
  await sendResponse(res, response);
}

// ---------------------------------------------------------------------------
// Response adapter — Web Response → http.ServerResponse
// ---------------------------------------------------------------------------

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    // Skip transfer-encoding — Node sets it automatically when chunked.
    // Skip content-length on streamed bodies (we don't know it ahead of time).
    if (key.toLowerCase() === "transfer-encoding") return;
    headers[key] = value;
  });
  res.writeHead(response.status, headers);

  if (response.body) {
    // Readable.fromWeb pipes the Web ReadableStream to the Node response.
    // The `as any` is because @types/node's typing for this argument is
    // overly narrow vs what Node 20 actually accepts.
    Readable.fromWeb(response.body as any).pipe(res);
  } else {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Header / body helpers
// ---------------------------------------------------------------------------

function headerOf(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Timestamp + signature
// ---------------------------------------------------------------------------

function isTimestampFresh(timestampHeader: string): boolean {
  const ts = parseInt(timestampHeader, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  return Math.abs(now - ts) <= TIMESTAMP_WINDOW_SECONDS;
}

async function verifySignature(
  publicKeyBase64: string,
  signatureBase64: string,
  method: string,
  pathname: string,
  timestamp: string,
  nonce: string,
  body: string
): Promise<boolean> {
  try {
    const bodyHash = await sha256Hex(body);
    const canonical = `1\n${method}\n${pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
    const canonicalBytes = new TextEncoder().encode(canonical);

    const publicKeyBytes = Buffer.from(publicKeyBase64, "base64");
    const signatureBytes = Buffer.from(signatureBase64, "base64");

    const cryptoKey = await webcrypto.subtle.importKey(
      "raw",
      publicKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    return await webcrypto.subtle.verify("Ed25519", cryptoKey, signatureBytes, canonicalBytes);
  } catch {
    return false;
  }
}

async function sha256Hex(text: string): Promise<string> {
  const buffer = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
}
