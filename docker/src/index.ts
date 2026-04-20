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
 *   PROVIDER_UPSTREAM_URL  — upstream provider base URL (no trailing slash)
 *   PROVIDER_API_KEY       — provider API key (never leaves this container)
 *   PORT                   — listen port (default 8787)
 *
 * Nonce cache is in-memory. For multi-replica deployments, replace
 * NonceStore with a Redis-backed implementation (see README).
 */

import http from "node:http";
import { webcrypto } from "node:crypto";
import { Readable } from "node:stream";

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
const HEALTH_PATH = "/health";
const TIMESTAMP_WINDOW_SECONDS = 300; // ±5 minutes
const NONCE_TTL_SECONDS = 600; // 10 minutes

// ---------------------------------------------------------------------------
// Config — read once at startup, fail fast if missing
// ---------------------------------------------------------------------------

interface Config {
  publicKey: string;
  userId: string;
  upstreamUrl: string;
  apiKey: string;
  port: number;
}

function loadConfig(): Config {
  const required = ["SOVBRAIN_PUBLIC_KEY", "SOVBRAIN_USER_ID", "PROVIDER_UPSTREAM_URL", "PROVIDER_API_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`[fatal] missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  return {
    publicKey: process.env.SOVBRAIN_PUBLIC_KEY!,
    userId: process.env.SOVBRAIN_USER_ID!,
    upstreamUrl: process.env.PROVIDER_UPSTREAM_URL!.replace(/\/$/, ""),
    apiKey: process.env.PROVIDER_API_KEY!,
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
  console.log(`[ready] sovbrain-proxy listening on port ${config.port}`);
  console.log(`[ready] forwarding to ${config.upstreamUrl}`);
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
  if (userId !== config.userId) {
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
    config.publicKey,
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
  if (isModels) {
    await forwardModels(res);
    return;
  }
  await forwardChat(res, body);
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
// Upstream forwarding
// ---------------------------------------------------------------------------

function upstreamAuthHeaders(): Record<string, string> {
  if (config.upstreamUrl.includes("anthropic.com")) {
    return { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${config.apiKey}` };
}

async function forwardChat(res: http.ServerResponse, body: string): Promise<void> {
  let upstream: Response;
  try {
    upstream = await fetch(`${config.upstreamUrl}${CHAT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...upstreamAuthHeaders() },
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error reaching upstream";
    sendError(res, 502, "upstream_error", `Provider unreachable: ${message}`);
    return;
  }

  if (!upstream.ok) {
    await upstream.text();
    sendErrorWithUpstream(res, 502, "upstream_error", `Provider returned HTTP ${upstream.status}`, upstream.status);
    return;
  }

  // Pipe streaming body (SSE-friendly) through unchanged.
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    // Skip transfer-encoding — Node sets it automatically when chunked
    if (key.toLowerCase() === "transfer-encoding") return;
    headers[key] = value;
  });
  res.writeHead(upstream.status, headers);

  if (upstream.body) {
    Readable.fromWeb(upstream.body as any).pipe(res);
  } else {
    res.end();
  }
}

async function forwardModels(res: http.ServerResponse): Promise<void> {
  let upstream: Response;
  try {
    upstream = await fetch(`${config.upstreamUrl}${MODELS_PATH}`, {
      method: "GET",
      headers: upstreamAuthHeaders(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error reaching upstream";
    sendError(res, 502, "upstream_error", `Provider unreachable: ${message}`);
    return;
  }

  if (!upstream.ok) {
    await upstream.text();
    sendErrorWithUpstream(
      res,
      502,
      "upstream_error",
      `Provider returned HTTP ${upstream.status} on /v1/models`,
      upstream.status
    );
    return;
  }

  const payload = await upstream.text();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
}

function sendErrorWithUpstream(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  upstreamStatus: number
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { code, message, upstream_status: upstreamStatus } }));
}
