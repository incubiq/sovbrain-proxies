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
- An API key from an upstream provider (OpenAI, Anthropic, together.ai, Ollama, vLLM, ...)

## Quick start

```bash
git clone https://github.com/incubiq/sovbrain-proxies.git
cd sovbrain-proxies/docker

cp .env.example .env
# Edit .env — fill in the four secrets (see below)

docker compose up -d
curl http://localhost:8787/health   # -> "ok"
```

## Environment variables

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `SOVBRAIN_PUBLIC_KEY` | Base64 Ed25519 public key | sovBrain Settings → External AI → Step 1 ("Generate signing key") |
| `SOVBRAIN_USER_ID` | Your sovBrain user ID (UUID) | Same Step 1 card |
| `PROVIDER_UPSTREAM_URL` | Upstream provider base URL, no trailing slash | Provider docs (see table below) |
| `PROVIDER_API_KEY` | Upstream provider API key | Provider dashboard |
| `PORT` | Listen port (default `8787`) | Optional |

Common upstream URLs:

| Provider | URL |
|----------|-----|
| OpenAI | `https://api.openai.com` |
| Anthropic | `https://api.anthropic.com` |
| together.ai | `https://api.together.xyz` |
| Ollama (host network) | `http://host.docker.internal:11434` |
| vLLM (same compose network) | `http://vllm:8000` |

The Worker auto-detects Anthropic by hostname and switches to `x-api-key` + `anthropic-version` headers; everything else uses `Authorization: Bearer …` (OpenAI convention).

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
fly secrets set SOVBRAIN_PUBLIC_KEY=... SOVBRAIN_USER_ID=... PROVIDER_UPSTREAM_URL=... PROVIDER_API_KEY=...
fly deploy
```

Proxy URL → `https://<app-name>.fly.dev`.

### Kubernetes

Container is stateless aside from the in-memory nonce cache. For multi-replica:

- Pin to one replica (replicas: 1) — simplest, accepts that nonce dedup is per-pod
- OR replace `NonceStore` in `src/index.ts` with a Redis-backed implementation (use `SET key 1 EX 600 NX` for atomic check-and-store)

A single replica handles thousands of req/s and many concurrent users — scale only when you hit a real bottleneck.

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
- Startup banner with port and upstream URL
- Unhandled errors only

It does **not** log signature failures, nonce reuses, or upstream errors by default — those are surfaced to sovBrain in the response body. If you want verbose logs for debugging, add `console.log` calls in `src/index.ts` and rebuild.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `signature_invalid` (401) | `SOVBRAIN_PUBLIC_KEY` doesn't match sovBrain's current key | Re-paste from sovBrain Settings → External AI |
| `signature_expired` (401) | Container clock drift (>5 min from sovBrain) | Sync clocks (NTP). Common on long-running VMs that hibernated |
| `nonce_reused` (409) | sovBrain re-sent the same nonce, OR you're running multiple replicas without shared nonce store | Single replica is fine; multi-replica needs Redis-backed `NonceStore` |
| `upstream_error` (502) | Provider unreachable or returned non-2xx | Check `PROVIDER_UPSTREAM_URL` and `PROVIDER_API_KEY`; test the provider directly with curl |
| Container won't start, exits with `[fatal] missing required env vars: …` | `.env` not loaded | Verify `.env` exists; `docker compose --env-file` if non-default location |
| Local Ollama not reachable from container | Default Docker bridge can't see host | Use `http://host.docker.internal:11434` (Docker Desktop) or `--network=host` (Linux) |

## Security notes

- The container runs as a non-root user (`sovbrain:sovbrain`)
- No third-party runtime dependencies — only Node 20's standard library
- The image is ~50MB (alpine + node) with zero `node_modules` shipped
- Audit surface: `src/index.ts` is ~270 lines. Read it before deploying.

## License

MIT — see [LICENSE](../LICENSE) at the repo root.
