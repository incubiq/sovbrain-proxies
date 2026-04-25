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

Choose which upstream(s) you want behind the Worker. Set the matching secrets:

```bash
# Required
npx wrangler secret put SOVBRAIN_PUBLIC_KEY    --config wrangler.toml
npx wrangler secret put SOVBRAIN_USER_ID       --config wrangler.toml

# Multi-upstream — set whichever upstreams you want behind this Worker
npx wrangler secret put ANTHROPIC_API_KEY      --config wrangler.toml   # optional
npx wrangler secret put OPENAI_API_KEY         --config wrangler.toml   # optional
npx wrangler secret put OLLAMA_URL             --config wrangler.toml   # optional
npx wrangler secret put OLLAMA_API_KEY         --config wrangler.toml   # optional, Bearer token for hosted/gatewayed Ollama
npx wrangler secret put DEFAULT_UPSTREAM       --config wrangler.toml   # optional, "anthropic"|"openai"|"ollama"
```

If you only have one upstream, you can skip `DEFAULT_UPSTREAM` — the Worker auto-routes unprefixed model names to the only configured upstream.

Migrating from the old single-upstream config (`PROVIDER_UPSTREAM_URL` + `PROVIDER_API_KEY`)? Those secrets still work as a fallback if no multi-upstream var is set, but we recommend migrating to the per-upstream secrets so you can stack providers.

**5. Deploy**

```bash
npx wrangler deploy --config wrangler.toml
```

The output should say `Uploaded sovbrain-proxy` (not any other name). Note the URL printed — something like `https://sovbrain-proxy.<your-subdomain>.workers.dev`. Enter it in sovBrain Settings → External AI.

---

## Environment variables / secrets

| Name | Required | Description |
|------|----------|-------------|
| `SOVBRAIN_PUBLIC_KEY` | Yes | Base64 Ed25519 public key from sovBrain Settings → External AI |
| `SOVBRAIN_USER_ID` | Yes | Your sovBrain userId (UUID). Requests from other users are rejected. |
| `ANTHROPIC_API_KEY` | Optional* | Your Anthropic API key (`sk-ant-...`). Worker translates OpenAI ↔ Anthropic Messages API automatically. |
| `OPENAI_API_KEY` | Optional* | Your OpenAI API key (`sk-...`). |
| `OLLAMA_URL` | Optional* | Base URL of your Ollama server (no trailing slash). |
| `OLLAMA_API_KEY` | Optional | Bearer token sent to Ollama on every request. Set this when your Ollama is fronted by a gateway that requires auth (Ollama Cloud, Tailscale Funnel, custom reverse proxy). Omit for local/private Ollama with no auth. |
| `DEFAULT_UPSTREAM` | Optional | `anthropic`, `openai`, or `ollama`. Routes unprefixed model names. Required only when multiple upstreams are configured. |
| `PROVIDER_UPSTREAM_URL` | Legacy | Single-upstream fallback. Used only if no multi-upstream var is set. |
| `PROVIDER_API_KEY` | Legacy | Single-upstream fallback API key. |

*At least one upstream (Anthropic / OpenAI / Ollama) must be configured. The legacy vars count as a fallback configuration.

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

---

## Upstream routing

This Worker can serve up to three upstreams from a single URL: Anthropic, OpenAI, and Ollama. sovBrain's [Fetch models] returns the union with prefixed IDs (e.g. `anthropic:claude-haiku-4-5`, `ollama:qwen3:32b`). When sovBrain sends a chat completion, the Worker reads the model field's prefix and dispatches:

| Prefix | Upstream | Behaviour |
|--------|----------|-----------|
| `anthropic:` | `https://api.anthropic.com/v1/messages` | Worker translates OpenAI chat-completions → Anthropic Messages and translates the streaming response back. PDFs not supported. |
| `openai:` | `https://api.openai.com/v1/chat/completions` | Forwarded as-is. |
| `ollama:` | `${OLLAMA_URL}/v1/chat/completions` | Forwarded as-is. Ollama is OpenAI-compatible at this endpoint. |

Unprefixed model names route to `DEFAULT_UPSTREAM` if set. If only one upstream is configured, unprefixed names always work (no ambiguity). With multiple upstreams configured and no `DEFAULT_UPSTREAM`, unprefixed names return 400 `ambiguous_model`.

Errors from upstreams include an `upstream_provider` field so sovBrain can tell you which provider failed.

### Examples

**Anthropic only**: set `ANTHROPIC_API_KEY`. Models discovery returns `anthropic:claude-haiku-4-5`, etc. sovBrain's existing single-upstream Settings configuration works unchanged.

**Anthropic + Ollama**: set both `ANTHROPIC_API_KEY` and `OLLAMA_URL`. sovBrain's [Fetch models] returns the union. Pick `anthropic:claude-sonnet-4-5-20250929` for Sparring Partner, `ollama:qwen3:32b` for Scribe — both flow through the same Worker.

**Migrating from legacy single-upstream**: your current `PROVIDER_UPSTREAM_URL` + `PROVIDER_API_KEY` keep working with no change. To stack a second upstream, just `wrangler secret put` the new one (e.g. `OLLAMA_URL`) and the Worker switches to multi-upstream mode automatically. Once switched, the legacy vars are ignored — clean them up with `wrangler secret delete`.
