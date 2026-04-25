/**
 * Per-upstream forwarding helpers for the sovBrain BYO AI Proxy.
 *
 * Workers-runtime only: no Node APIs, no Buffer.
 */

import { translateRequestBody, createOpenAITranslatedStream } from "./anthropic-translator";

// ---------------------------------------------------------------------------
// Error helpers (exported so index.ts can import)
// ---------------------------------------------------------------------------

export function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function errorResponseWithUpstream(
  status: number,
  code: string,
  message: string,
  upstreamStatus?: number,
  upstreamProvider?: string
): Response {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errBody: any = { error: { code, message } };
  if (upstreamStatus !== undefined) errBody.error.upstream_status = upstreamStatus;
  if (upstreamProvider !== undefined) errBody.error.upstream_provider = upstreamProvider;
  return new Response(JSON.stringify(errBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Anthropic forwarder
// ---------------------------------------------------------------------------

/**
 * Translate an OpenAI-shaped chat-completions request and forward to
 * Anthropic Messages API. Returns an SSE stream in OpenAI delta shape.
 */
export async function forwardChatToAnthropic(
  apiKey: string,
  body: string
): Promise<Response> {
  const upstreamBaseUrl = "https://api.anthropic.com";

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "JSON parse error";
    return errorResponse(
      502,
      "upstream_error",
      `Worker could not parse request body for Anthropic translation: ${message}`
    );
  }

  let translatedBody: unknown;
  try {
    translatedBody = translateRequestBody(parsed as Record<string, unknown>);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Translation error";
    return errorResponse(502, "upstream_error", `Anthropic translation failed: ${message}`);
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${upstreamBaseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(translatedBody),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network error reaching upstream";
    return errorResponseWithUpstream(
      502,
      "upstream_error",
      `Provider unreachable: ${message}`,
      undefined,
      "anthropic"
    );
  }

  if (!upstream.ok) {
    const upstreamBody = await upstream.text();
    const preview = upstreamBody.slice(0, 200);
    return errorResponseWithUpstream(
      502,
      "upstream_error",
      `Provider returned HTTP ${upstream.status}: ${preview}`,
      upstream.status,
      "anthropic"
    );
  }

  if (!upstream.body) {
    return errorResponseWithUpstream(
      502,
      "upstream_error",
      "Anthropic returned no response body",
      undefined,
      "anthropic"
    );
  }

  const translatedStream = createOpenAITranslatedStream(upstream.body);

  return new Response(translatedStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible forwarder (OpenAI + Ollama)
// ---------------------------------------------------------------------------

/**
 * Forward a chat-completions request as-is to any OpenAI-compatible upstream.
 * Strips transport-layer headers that cause chunk-marker corruption on streaming
 * responses (observed with Ollama upstream through Cloudflare).
 */
export async function forwardChatToOpenAICompat(
  baseUrl: string,
  apiKey: string | undefined,
  body: string,
  providerLabel: "openai" | "ollama"
): Promise<Response> {
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey !== undefined) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network error reaching upstream";
    return errorResponseWithUpstream(
      502,
      "upstream_error",
      `Provider unreachable: ${message}`,
      undefined,
      providerLabel
    );
  }

  if (!upstream.ok) {
    const upstreamBody = await upstream.text();
    const preview = upstreamBody.slice(0, 200);
    return errorResponseWithUpstream(
      502,
      "upstream_error",
      `Provider returned HTTP ${upstream.status}: ${preview}`,
      upstream.status,
      providerLabel
    );
  }

  // Strip transport-layer headers. fetch() already de-chunked the HTTP/1.1
  // chunked body and decompressed gzip/br, so leaving those headers in place
  // makes the Worker's outgoing response framing inconsistent with the body
  // bytes — on streaming responses this leaks chunk-size markers and bare \n
  // buffer flushes into the SSE body, corrupting JSON payloads at 4KB
  // boundaries. Observed with Ollama upstream.
  const forwardHeaders = new Headers(upstream.headers);
  forwardHeaders.delete("Transfer-Encoding");
  forwardHeaders.delete("Content-Encoding");
  forwardHeaders.delete("Content-Length");
  forwardHeaders.delete("Connection");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: forwardHeaders,
  });
}

// ---------------------------------------------------------------------------
// Generic models discovery forwarder
// ---------------------------------------------------------------------------

/**
 * Fetch a single upstream's model list and return prefixed IDs.
 * Never throws — on any failure returns { ids: [], error: "..." } so
 * the caller can continue with other upstreams.
 */
export async function forwardModelsToUpstreamGeneric(
  url: string,
  headers: Record<string, string>,
  providerLabel: "anthropic" | "openai" | "ollama"
): Promise<{ ids: string[]; error?: string }> {
  let upstream: Response;
  try {
    upstream = await fetch(url, { method: "GET", headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Network error";
    return { ids: [], error: `${providerLabel}: ${message}` };
  }

  if (!upstream.ok) {
    return {
      ids: [],
      error: `${providerLabel}: HTTP ${upstream.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await upstream.json();
  } catch {
    return { ids: [], error: `${providerLabel}: response was not valid JSON` };
  }

  // Ollama /api/tags shape: { models: [{ name: "qwen3:32b" }] }
  if (url.endsWith("/api/tags")) {
    const ollamaPayload = payload as { models?: { name?: unknown }[] };
    const names: string[] = [];
    if (Array.isArray(ollamaPayload.models)) {
      for (const m of ollamaPayload.models) {
        if (typeof m.name === "string") {
          names.push(`${providerLabel}:${m.name}`);
        }
      }
    }
    names.sort();
    return { ids: names };
  }

  // OpenAI / Anthropic shape: { data: [{ id: "..." }] }
  const openaiPayload = payload as { data?: { id?: unknown }[] };
  const ids: string[] = [];
  if (Array.isArray(openaiPayload.data)) {
    for (const item of openaiPayload.data) {
      if (typeof item.id === "string") {
        ids.push(`${providerLabel}:${item.id}`);
      }
    }
  }
  ids.sort();
  return { ids };
}
