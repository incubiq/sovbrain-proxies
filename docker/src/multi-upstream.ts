/**
 * Multi-upstream config, prefix routing, and dispatch for the sovBrain BYO AI Proxy.
 *
 * Node 20 compatible: uses only Web API globals available globally in Node 20.
 */

import {
  errorResponse,
  forwardChatToAnthropic,
  forwardChatToOpenAICompat,
  forwardModelsToUpstreamGeneric,
} from "./dispatchers.js";

import type { Env } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpstreamConfig {
  anthropic?: { apiKey: string };
  openai?: { apiKey: string };
  ollama?: { baseUrl: string; apiKey?: string };
  default?: "anthropic" | "openai" | "ollama";
}

type UpstreamKey = "anthropic" | "openai" | "ollama";

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/**
 * Build the upstream config from env vars.
 *
 * Multi-upstream vars take precedence. Legacy PROVIDER_UPSTREAM_URL /
 * PROVIDER_API_KEY are only consulted if no multi-upstream var is set,
 * ensuring existing single-upstream deployments keep working with no change.
 */
export function buildUpstreamConfig(env: Env): UpstreamConfig {
  const cfg: UpstreamConfig = {};

  if (env.ANTHROPIC_API_KEY) {
    cfg.anthropic = { apiKey: env.ANTHROPIC_API_KEY };
  }
  if (env.OPENAI_API_KEY) {
    cfg.openai = { apiKey: env.OPENAI_API_KEY };
  }
  if (env.OLLAMA_URL) {
    cfg.ollama = {
      baseUrl: env.OLLAMA_URL.replace(/\/+$/, ""),
      ...(env.OLLAMA_API_KEY ? { apiKey: env.OLLAMA_API_KEY } : {}),
    };
  }

  const validDefaults: UpstreamKey[] = ["anthropic", "openai", "ollama"];
  if (env.DEFAULT_UPSTREAM && (validDefaults as string[]).includes(env.DEFAULT_UPSTREAM)) {
    cfg.default = env.DEFAULT_UPSTREAM as UpstreamKey;
  }

  // Legacy fallback: only used when no multi-upstream var was set above
  if (!cfg.anthropic && !cfg.openai && !cfg.ollama) {
    if (env.PROVIDER_UPSTREAM_URL && env.PROVIDER_API_KEY) {
      const url = env.PROVIDER_UPSTREAM_URL;
      if (url.includes("anthropic.com")) {
        cfg.anthropic = { apiKey: env.PROVIDER_API_KEY };
        cfg.default = "anthropic";
      } else if (url.includes("openai.com")) {
        cfg.openai = { apiKey: env.PROVIDER_API_KEY };
        cfg.default = "openai";
      } else {
        // Any other URL (Ollama, vLLM, together.ai, etc.) treated as
        // OpenAI-compat passthrough with the given base URL.
        cfg.ollama = {
          baseUrl: env.PROVIDER_UPSTREAM_URL.replace(/\/+$/, ""),
          apiKey: env.PROVIDER_API_KEY,
        };
        cfg.default = "ollama";
      }
    }
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Prefix routing
// ---------------------------------------------------------------------------

type RoutingSuccess = { upstream: UpstreamKey; modelId: string };
type RoutingError = { errorCode: string; message: string };

/**
 * Parse the model field's prefix (split on FIRST colon only) and resolve
 * which upstream should handle the request.
 */
export function parseRouting(
  modelString: string,
  cfg: UpstreamConfig
): RoutingSuccess | RoutingError {
  const colonIdx = modelString.indexOf(":");
  const knownPrefixes: UpstreamKey[] = ["anthropic", "openai", "ollama"];

  if (colonIdx !== -1) {
    const prefix = modelString.slice(0, colonIdx);
    const rest = modelString.slice(colonIdx + 1);

    if ((knownPrefixes as string[]).includes(prefix)) {
      const upstream = prefix as UpstreamKey;
      if (!cfg[upstream]) {
        return {
          errorCode: "upstream_not_configured",
          message: `Model prefix '${prefix}:' requested but no ${upstream} upstream is configured on this container.`,
        };
      }
      return { upstream, modelId: rest };
    }
    // Unrecognised prefix (e.g. "qwen3" in "qwen3:32b") — fall through to
    // default-upstream logic treating the full string as the model name.
  }

  // No recognised prefix — route via default or sole configured upstream.
  if (cfg.default && cfg[cfg.default]) {
    return { upstream: cfg.default, modelId: modelString };
  }

  const configuredCount = knownPrefixes.filter((k) => Boolean(cfg[k])).length;

  if (configuredCount === 1) {
    const sole = knownPrefixes.find((k) => Boolean(cfg[k]))!;
    return { upstream: sole, modelId: modelString };
  }

  if (configuredCount === 0) {
    return {
      errorCode: "ambiguous_model",
      message:
        "No upstream is configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY / OLLAMA_URL.",
    };
  }

  return {
    errorCode: "ambiguous_model",
    message:
      "Multiple upstreams configured but model has no recognised prefix. Use one of: anthropic:, openai:, ollama:, or set DEFAULT_UPSTREAM env var.",
  };
}

// ---------------------------------------------------------------------------
// Chat dispatch
// ---------------------------------------------------------------------------

/**
 * Entry point for POST /v1/chat/completions in multi-upstream mode.
 * Parses model prefix, strips it, and dispatches to the right upstream.
 */
export async function dispatchChatMulti(
  cfg: UpstreamConfig,
  body: string
): Promise<Response> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "JSON parse error";
    return errorResponse(400, "bad_request", `Worker could not parse request body: ${message}`);
  }

  if (typeof parsed.model !== "string") {
    return errorResponse(400, "bad_request", "Request body missing 'model' field");
  }

  const routing = parseRouting(parsed.model, cfg);

  if ("errorCode" in routing) {
    return errorResponse(400, routing.errorCode, routing.message);
  }

  // Strip prefix from model before forwarding
  parsed.model = routing.modelId;
  const cleanedBody = JSON.stringify(parsed);

  switch (routing.upstream) {
    case "anthropic":
      return forwardChatToAnthropic(cfg.anthropic!.apiKey, cleanedBody);
    case "openai":
      return forwardChatToOpenAICompat(
        "https://api.openai.com",
        cfg.openai!.apiKey,
        cleanedBody,
        "openai"
      );
    case "ollama":
      return forwardChatToOpenAICompat(
        cfg.ollama!.baseUrl,
        cfg.ollama!.apiKey,
        cleanedBody,
        "ollama"
      );
  }
}

// ---------------------------------------------------------------------------
// Models dispatch
// ---------------------------------------------------------------------------

/**
 * Entry point for GET /v1/models in multi-upstream mode.
 * Queries all configured upstreams in parallel and returns the prefixed union.
 */
export async function dispatchModelsMulti(cfg: UpstreamConfig): Promise<Response> {
  const fetches: Promise<{ ids: string[]; error?: string }>[] = [];

  if (cfg.anthropic) {
    fetches.push(
      forwardModelsToUpstreamGeneric(
        "https://api.anthropic.com/v1/models",
        {
          "x-api-key": cfg.anthropic.apiKey,
          "anthropic-version": "2023-06-01",
        },
        "anthropic"
      )
    );
  }

  if (cfg.openai) {
    fetches.push(
      forwardModelsToUpstreamGeneric(
        "https://api.openai.com/v1/models",
        { Authorization: `Bearer ${cfg.openai.apiKey}` },
        "openai"
      )
    );
  }

  if (cfg.ollama) {
    const ollamaHeaders: Record<string, string> = cfg.ollama.apiKey
      ? { Authorization: `Bearer ${cfg.ollama.apiKey}` }
      : {};
    fetches.push(
      forwardModelsToUpstreamGeneric(
        `${cfg.ollama.baseUrl}/v1/models`,
        ollamaHeaders,
        "ollama"
      )
    );
  }

  const results = await Promise.all(fetches);

  const allIds: string[] = [];
  const errors: string[] = [];

  for (const result of results) {
    allIds.push(...result.ids);
    if (result.error) {
      errors.push(result.error);
      // Surface per-upstream failures in logs even when other upstreams succeed
      // and the overall response is 200.
      console.warn(`[/v1/models] upstream failure: ${result.error}`);
    }
  }

  if (allIds.length === 0) {
    return errorResponse(
      502,
      "upstream_error",
      `All configured upstreams failed model discovery. Errors: ${errors.join("; ")}`
    );
  }

  return new Response(
    JSON.stringify({ data: allIds.map((id) => ({ id })) }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}
