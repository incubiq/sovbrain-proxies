# sovbrain-proxies

Reference implementations of the **sovBrain BYO AI Proxy Protocol** — small, user-deployed servers that hold your upstream AI provider credentials (OpenAI, Anthropic, Ollama, etc.) and accept Ed25519-signed requests from [sovBrain](https://sovbrain.com).

The point: **sovBrain never sees your provider API key.** It signs every request with a per-user keypair; your proxy verifies the signature and forwards to whichever upstream you configured. If sovBrain is ever compromised, the worst an attacker can do is forge requests to your proxy until you rotate keys — they cannot exfiltrate your provider credential.

## Available reference implementations

| Runtime | Status | Directory |
|---------|--------|-----------|
| Cloudflare Workers | Stable | [`cloudflare/`](./cloudflare/) |
| Docker (Node 20) | Stable | [`docker/`](./docker/) |
| Deno | Planned | — |

Pick whichever runtime you prefer. They all implement the same wire protocol — sovBrain doesn't care which one you use.

## Quick start

### Cloudflare Workers

```bash
git clone https://github.com/incubiq/sovbrain-proxies.git
cd sovbrain-proxies/cloudflare
npm install
npx wrangler login
# Follow the README in cloudflare/ for the rest
```

### Docker

```bash
git clone https://github.com/incubiq/sovbrain-proxies.git
cd sovbrain-proxies/docker
cp .env.example .env
# Edit .env with your secrets
docker compose up -d
curl http://localhost:8787/health   # -> "ok"
```

For a step-by-step guide you can feed to Claude Code or any AI coding assistant, sovBrain Sovereign-tier users can download `sovbrain-byo-proxy-setup.md` from their Settings page.

## Protocol

Wire format, signed payload canonical string, replay protection, error codes, and protocol versioning are all documented in **[SPECS_PROXY_PROTOCOL.md](https://github.com/incubiq/sovbrain-proxies/blob/main/SPECS_PROXY_PROTOCOL.md)** *(coming soon — currently sovBrain users can find the spec in their Settings → External AI documentation).*

The protocol is platform-neutral. Anyone can implement a conforming proxy in any language with Ed25519 signature verification + an HTTP forwarder. PRs adding new runtime implementations are welcome.

## Why a separate repo

The proxy reference code is generic infrastructure with no sovBrain-specific logic. It deserves to be open, forkable, and auditable by the people who will run it. The main sovBrain repository is private; this one isn't.

## License

MIT — use, fork, modify, deploy commercially. See [LICENSE](./LICENSE).
