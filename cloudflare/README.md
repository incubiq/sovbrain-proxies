# sovBrain BYO AI Proxy — Cloudflare Worker

A Cloudflare Worker that lets you hold your own AI provider credentials while accepting signed requests from sovBrain.

---

## Setup

**IMPORTANT:** Every `wrangler` command below passes `--config wrangler.toml` explicitly. If your parent directory contains another wrangler config (e.g. a root-level `wrangler.jsonc` for a different Cloudflare project), wrangler's directory-walk can pick it up instead of this one and deploy to the wrong Worker. The `--config` flag forces wrangler to use the local file and nothing else.

**1. Install dependencies**

```bash
npm install
```

**2. Create your local `wrangler.toml`**

The repo ships a template `wrangler.toml.example` but does not commit `wrangler.toml` itself (the real file holds a KV namespace id tied to the deployer's Cloudflare account, so it's git-ignored). Make a local copy:

```bash
cp wrangler.toml.example wrangler.toml
```

**3. Create the KV namespace for nonce deduplication**

```bash
npx wrangler kv namespace create NONCE_CACHE
```

Copy the `id` from the output and paste it into your local `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "NONCE_CACHE"
id = "abc123..."   # <-- paste here
```

**4. Set secrets**

```bash
npx wrangler secret put SOVBRAIN_PUBLIC_KEY    --config wrangler.toml
npx wrangler secret put SOVBRAIN_USER_ID       --config wrangler.toml
npx wrangler secret put PROVIDER_UPSTREAM_URL  --config wrangler.toml
npx wrangler secret put PROVIDER_API_KEY       --config wrangler.toml
```

Values:
- `SOVBRAIN_PUBLIC_KEY` — base64 Ed25519 public key from sovBrain Settings → External AI
- `SOVBRAIN_USER_ID` — your userId UUID from sovBrain Settings → External AI
- `PROVIDER_UPSTREAM_URL` — e.g. `https://api.openai.com`
- `PROVIDER_API_KEY` — your upstream provider API key (OpenAI / Anthropic / etc.)

**5. Deploy**

```bash
npx wrangler deploy --config wrangler.toml
```

The output should say `Uploaded sovbrain-proxy` (not any other name). Note the URL printed — something like `https://sovbrain-proxy.<your-subdomain>.workers.dev`. Enter it in sovBrain Settings → External AI.

---

## Environment variables / secrets

| Name | Description |
|------|-------------|
| `SOVBRAIN_PUBLIC_KEY` | Base64 Ed25519 public key provided by sovBrain (Settings → External AI → "Your Signing Key") |
| `SOVBRAIN_USER_ID` | Your sovBrain userId (UUID). Requests from other users are rejected. |
| `PROVIDER_UPSTREAM_URL` | Base URL of your AI provider, e.g. `https://api.openai.com` (no trailing slash) |
| `PROVIDER_API_KEY` | Your AI provider API key. Never leaves this Worker. |

---

## Testing

**Connectivity check (no auth required):**

```bash
curl https://<your-worker>.workers.dev/health
# expected: ok
```

**Signed requests** must come from sovBrain — the signature covers the request body, path, timestamp, and nonce. You can use the "Test access" button in sovBrain Settings → External AI after entering your Worker URL.

---

## Troubleshooting

| Error code | HTTP status | Meaning | Fix |
|------------|-------------|---------|-----|
| `signature_invalid` | 401 | Ed25519 verification failed | Check that `SOVBRAIN_PUBLIC_KEY` matches the key shown in sovBrain Settings → External AI. Rotate keys if needed. |
| `signature_expired` | 401 | Request timestamp is more than 5 minutes old | Ensure your Worker's system clock is correct (Workers use Cloudflare's NTP — this is almost never the issue). More likely the request was delayed in transit or replayed. |
| `nonce_reused` | 409 | Duplicate request detected | This is a replay attack or a retried request with the same nonce. sovBrain generates a fresh nonce per request; if you see this unexpectedly, check for retry logic sending identical requests. |
| `upstream_error` | 502 | Your AI provider returned an error | Check `upstream_status` in the response body. Common causes: invalid `PROVIDER_API_KEY`, rate limiting (429), or wrong `PROVIDER_UPSTREAM_URL`. |

---

## Protocol reference

This Worker implements `BYO AI Proxy Protocol v1` — Ed25519-signed requests with replay protection. Two signed endpoints:

- `POST /v1/chat/completions` — OpenAI-compatible chat completions, forwarded as-is to your upstream
- `GET /v1/models` — model discovery, forwarded as-is

Plus one unsigned endpoint:

- `GET /health` — liveness check, returns `ok`

The Worker auto-detects upstream auth: Anthropic gets `x-api-key` + `anthropic-version`; everything else gets `Authorization: Bearer`.
