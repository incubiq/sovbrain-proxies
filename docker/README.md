# sovBrain BYO AI Proxy — Docker / Node 20

Reference implementation of the [sovBrain BYO AI Proxy Protocol](https://github.com/incubiq/sovbrain-proxies) packaged as a Docker container. Holds your AI provider credentials on infrastructure you control; verifies Ed25519-signed requests from sovBrain.

Same wire protocol as the [`cloudflare/`](../cloudflare/) variant — pick whichever runtime fits your deployment model.

## When to use this instead of Cloudflare

- You want the proxy on a machine you fully own (homelab, VPS, on-prem)
- You're already running Docker / Kubernetes and want one less account to manage
- You need to reach a private/internal upstream provider (e.g. self-hosted Ollama on the same network) without exposing it to the internet

## Prerequisites

- Docker 20.10+ (or Docker Desktop / Podman / any OCI runtime)
- A Sovereign-tier sovBrain account
- At least one upstream configured: an Anthropic API key, OpenAI API key, or an Ollama server URL

## Quick start

Multi-upstream — set whichever upstreams you want. You don't need all three; any combination works.

```bash
git clone https://github.com/incubiq/sovbrain-proxies.git
cd sovbrain-proxies/docker

cp .env.example .env
# Edit .env — fill in SOVBRAIN_PUBLIC_KEY, SOVBRAIN_USER_ID, and at least one upstream

docker compose up -d
curl http://localhost:8787/health   # -> "ok"
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOVBRAIN_PUBLIC_KEY` | Yes | Base64 Ed25519 public key from sovBrain Settings → External AI |
| `SOVBRAIN_USER_ID` | Yes | Your sovBrain user ID (UUID) |
| `ANTHROPIC_API_KEY` | Optional* | Anthropic API key (`sk-ant-...`). Container translates OpenAI ↔ Anthropic Messages API automatically. |
| `OPENAI_API_KEY` | Optional* | OpenAI API key (`sk-...`). |
| `OLLAMA_URL` | Optional* | Base URL of your Ollama server (no trailing slash). |
| `OLLAMA_API_KEY` | Optional | Bearer token for hosted/gatewayed Ollama (Ollama Cloud, Tailscale Funnel, custom reverse proxy). Omit for local/private Ollama with no auth. |
| `DEFAULT_UPSTREAM` | Optional | `anthropic`, `openai`, or `ollama`. Routes unprefixed model names. Required only when multiple upstreams are configured. |
| `PROVIDER_UPSTREAM_URL` | Legacy | Single-upstream fallback (only used if no multi-upstream var is set). |
| `PROVIDER_API_KEY` | Legacy | Single-upstream fallback API key. |
| `PORT` | Optional | Listen port (default `8787`) |

*At least one upstream (Anthropic / OpenAI / Ollama) must be configured. The legacy vars count as a fallback configuration.

Example upstream URLs for `OLLAMA_URL`:

| Deployment | URL |
|------------|-----|
| Local Ollama (Docker Desktop) | `http://host.docker.internal:11434` |
| Ollama on the same compose network | `http://ollama:11434` |
| Hosted Ollama gateway | `https://ai.example.com` |

The container picks the correct auth scheme per upstream — `x-api-key` + `anthropic-version` for Anthropic, `Authorization: Bearer` for OpenAI and Ollama.

## Connecting to sovBrain

Once the container is running and reachable from sovBrain (publicly or via tunnel):

1. sovBrain → Settings → External AI → Step 2: paste your proxy URL (e.g. `https://ai.example.com` or `http://your-host:8787`)
2. Click **Test access** — sovBrain calls `GET /v1/models` and lists available models
3. Pick Scribe and Sparring Partner models, click **Test model**
4. Click **Save**

For local-only sovBrain dev (sovBrain on `localhost:3000`, proxy on `localhost:8787`), no tunnel needed. For deployed sovBrain → local Docker, expose the proxy via Cloudflare Tunnel, ngrok, or a VPS reverse proxy.

## Deployment topologies

### Single-host with Caddy / Traefik (recommended)

Run the proxy on a small VPS behind a reverse proxy that handles TLS:

```yaml
# docker-compose.yml example
services:
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
  sovbrain-proxy:
    build: .
    env_file: .env
    expose: ["8787"]
```

```caddy
# Caddyfile
ai.example.com {
  reverse_proxy sovbrain-proxy:8787
}
```

Caddy auto-issues a Let's Encrypt cert; sovBrain talks to `https://ai.example.com`.

### Fly.io

```bash
fly launch --no-deploy
fly secrets set SOVBRAIN_PUBLIC_KEY=... SOVBRAIN_USER_ID=... ANTHROPIC_API_KEY=...
fly deploy
```

Proxy URL → `https://<app-name>.fly.dev`.

### Kubernetes

Container is stateless aside from the in-memory nonce cache. For multi-replica:

- Pin to one replica (replicas: 1) — simplest, accepts that nonce dedup is per-pod
- OR replace `NonceStore` in `src/index.ts` with a Redis-backed implementation (use `SET key 1 EX 600 NX` for atomic check-and-store)

A single replica handles thousands of req/s and many concurrent users — scale only when you hit a real bottleneck.

## Upstream routing

The container routes requests based on a prefix in the model name (split on the first colon):

| Model sent by sovBrain | Routed to |
|------------------------|-----------|
| `anthropic:claude-haiku-4-5-20251001` | Anthropic Messages API (with translation) |
| `openai:gpt-4o` | OpenAI `/v1/chat/completions` |
| `ollama:qwen3:32b` | Ollama `/v1/chat/completions` |
| `gpt-4o` (no prefix) | Default upstream (if `DEFAULT_UPSTREAM` set or only one upstream configured) |

**Dispatch rules:**

1. If the model string starts with a recognised prefix (`anthropic:`, `openai:`, `ollama:`), the prefix is stripped and the request is forwarded to that upstream. Returns `400 upstream_not_configured` if that upstream has no credentials.
2. If there is no recognised prefix, the full model string is passed as-is to the default upstream (set via `DEFAULT_UPSTREAM`) or to the sole configured upstream.
3. If multiple upstreams are configured with no `DEFAULT_UPSTREAM` and no prefix, returns `400 ambiguous_model`.

**Examples:**

Anthropic only (`ANTHROPIC_API_KEY=sk-ant-...`):
```
sovBrain sends:  anthropic:claude-haiku-4-5-20251001
Container:       translates OpenAI → Anthropic Messages, streams OpenAI deltas back
```

Anthropic + Ollama (`ANTHROPIC_API_KEY=...`, `OLLAMA_URL=http://ollama:11434`, `DEFAULT_UPSTREAM=anthropic`):
```
sovBrain sends:  anthropic:claude-haiku-4-5-20251001  → Anthropic
sovBrain sends:  ollama:qwen3:32b                     → Ollama
sovBrain sends:  claude-haiku-4-5-20251001            → Anthropic (default)
```

Migrating from legacy single-upstream (`PROVIDER_UPSTREAM_URL=https://api.openai.com`, `PROVIDER_API_KEY=sk-...`):
- No change needed. The container detects no multi-upstream vars and falls back to the legacy config automatically.
- The startup banner will show `upstreams: openai (default: openai)`.
- Once you're ready, set `OPENAI_API_KEY` directly and remove the legacy vars.

## Updating the public key (rotation)

1. sovBrain → Settings → External AI → **Rotate signing key…**
2. Copy the new public key from the modal
3. Update the secret on the container side:
   - **docker compose**: edit `.env`, then `docker compose up -d` (forces re-create)
   - **Fly.io**: `fly secrets set SOVBRAIN_PUBLIC_KEY=<new-key>`
   - **Kubernetes**: update the Secret resource and roll the deployment
4. Click **Test access** in sovBrain Settings to confirm

No code redeploy required — the proxy reads env vars at startup, so a container restart is enough.

## Verification

```bash
# 1. Container health
docker compose ps                             # status: healthy
curl http://localhost:8787/health             # -> "ok"

# 2. Sanity check: unsigned request to a signed endpoint should be rejected
curl -i http://localhost:8787/v1/models       # -> 400 missing_headers

# 3. End-to-end: use sovBrain Settings -> Test access (signs the request)
```

## Logs

```bash
docker compose logs -f sovbrain-proxy
```

The proxy logs:
- Startup banner with port and configured upstreams
- Unhandled errors only

It does **not** log signature failures, nonce reuses, or upstream errors by default — those are surfaced to sovBrain in the response body. If you want verbose logs for debugging, add `console.log` calls in `src/index.ts` and rebuild.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `signature_invalid` (401) | `SOVBRAIN_PUBLIC_KEY` doesn't match sovBrain's current key | Re-paste from sovBrain Settings → External AI |
| `signature_expired` (401) | Container clock drift (>5 min from sovBrain) | Sync clocks (NTP). Common on long-running VMs that hibernated |
| `nonce_reused` (409) | sovBrain re-sent the same nonce, OR you're running multiple replicas without shared nonce store | Single replica is fine; multi-replica needs Redis-backed `NonceStore` |
| `upstream_error` (502) | Provider unreachable or returned non-2xx | Check the matching upstream's secret(s); test the provider directly with curl |
| `ambiguous_model` (400) | Multiple upstreams configured, unprefixed model name | Set `DEFAULT_UPSTREAM` env var, or use a prefixed model name (`anthropic:`, `openai:`, `ollama:`) |
| `upstream_not_configured` (400) | Model prefix references an upstream you didn't configure | Set the matching `*_API_KEY` / URL var, or use a different prefix |
| `no_upstream_configured` (500) | No upstream secrets configured at all | Set at least one of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_URL` (or the legacy `PROVIDER_*` pair) |
| Container won't start, exits with `[fatal] missing required env vars: …` | `.env` not loaded | Verify `.env` exists; `docker compose --env-file` if non-default location |
| Container won't start, exits with `[fatal] no upstream configured` | No upstream vars set | Set at least one upstream in `.env` |
| Local Ollama not reachable from container | Default Docker bridge can't see host | Use `http://host.docker.internal:11434` (Docker Desktop) or `--network=host` (Linux) |

## Security notes

- The container runs as a non-root user (`sovbrain:sovbrain`)
- No third-party runtime dependencies — only Node 20's standard library
- The image is ~50MB (alpine + node) with zero `node_modules` shipped
- Audit surface: four source files — `anthropic-translator.ts` (~240 lines), `dispatchers.ts` (~220 lines), `multi-upstream.ts` (~230 lines), `index.ts` (~230 lines). Read them before deploying.

## License

MIT — see [LICENSE](../LICENSE) at the repo root.
