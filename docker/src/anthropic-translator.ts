/**
 * Anthropic ↔ OpenAI translation helpers for the sovBrain BYO AI Proxy.
 *
 * Pure functions — no I/O, no side effects.
 * Workers-runtime only: no Node APIs, no Buffer.
 */

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

interface OpenAITextBlock {
  type: "text";
  text: string;
}

interface OpenAIImageUrlBlock {
  type: "image_url";
  image_url: { url: string };
}

type OpenAIContentBlock = OpenAITextBlock | OpenAIImageUrlBlock | { type: string; [key: string]: unknown };

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentBlock[];
}

interface OpenAIRequestBody {
  model?: unknown;
  max_tokens?: unknown;
  stream?: unknown;
  messages?: unknown;
  [key: string]: unknown;
}

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequestBody {
  model: unknown;
  max_tokens: unknown;
  stream: unknown;
  system?: string;
  messages: AnthropicMessage[];
}

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/;

function translateContentBlock(block: OpenAIContentBlock): AnthropicContentBlock {
  if (block.type === "text") {
    return { type: "text", text: (block as OpenAITextBlock).text };
  }
  if (block.type === "image_url") {
    const { url } = (block as OpenAIImageUrlBlock).image_url;
    const match = DATA_URL_RE.exec(url);
    if (!match) {
      throw new Error(
        `image_url blocks must use base64 data URIs (e.g. data:image/png;base64,...). Got: ${url.slice(0, 80)}`
      );
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: match[1],
        data: match[2],
      },
    };
  }
  throw new Error(`Unsupported content block type: "${block.type}"`);
}

function extractSystemText(content: string | OpenAIContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((b): b is OpenAITextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

export function translateRequestBody(openaiBody: OpenAIRequestBody): AnthropicRequestBody {
  if (openaiBody.model === undefined || openaiBody.model === null) {
    throw new Error("Missing required field: model");
  }
  if (openaiBody.max_tokens === undefined || openaiBody.max_tokens === null) {
    throw new Error("Missing required field: max_tokens");
  }
  if (!Array.isArray(openaiBody.messages)) {
    throw new Error("Missing required field: messages");
  }

  const rawMessages = openaiBody.messages as OpenAIMessage[];
  const systemParts: string[] = [];
  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of rawMessages) {
    if (msg.role === "system") {
      systemParts.push(extractSystemText(msg.content as string | OpenAIContentBlock[]));
      continue;
    }

    if (msg.role !== "user" && msg.role !== "assistant") {
      throw new Error(
        `Unsupported message role: "${msg.role}". Only user, assistant, and system are supported.`
      );
    }

    const role = msg.role as "user" | "assistant";

    if (typeof msg.content === "string") {
      anthropicMessages.push({ role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const blocks = (msg.content as OpenAIContentBlock[]).map(translateContentBlock);
      anthropicMessages.push({ role, content: blocks });
    } else {
      throw new Error(`Message content must be a string or array of blocks`);
    }
  }

  const result: AnthropicRequestBody = {
    model: openaiBody.model,
    max_tokens: openaiBody.max_tokens,
    stream: openaiBody.stream,
    messages: anthropicMessages,
  };

  if (systemParts.length > 0) {
    result.system = systemParts.join("\n\n");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Response stream translation
// ---------------------------------------------------------------------------

interface AnthropicStreamEvent {
  type: string;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
  };
  [key: string]: unknown;
}

export function createOpenAITranslatedStream(
  anthropicStream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

  let buffer = "";
  let doneSent = false;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Decode incrementally; stream:true keeps the decoder state between chunks
      buffer += decoder.decode(chunk, { stream: true });

      // Normalize CRLF to LF
      buffer = buffer.replace(/\r\n/g, "\n");

      // Split on blank lines (event boundaries)
      const parts = buffer.split("\n\n");

      // Last element is either empty (trailing \n\n) or a partial event
      buffer = parts.pop() ?? "";

      for (const eventBlock of parts) {
        if (!eventBlock.trim()) continue;

        // Collect data: lines from the event block
        const dataLines: string[] = [];
        for (const line of eventBlock.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
          // event:, id:, retry:, : comments — ignore
        }

        const dataStr = dataLines.join("");
        if (!dataStr) continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(dataStr) as AnthropicStreamEvent;
        } catch {
          console.warn(`[anthropic-translator] Could not parse SSE data: ${dataStr.slice(0, 100)}`);
          continue;
        }

        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          typeof event.delta.text === "string"
        ) {
          const text = event.delta.text;
          const openaiChunk = JSON.stringify({
            choices: [{ delta: { content: text }, index: 0 }],
          });
          controller.enqueue(encoder.encode(`data: ${openaiChunk}\n\n`));
        } else if (event.type === "message_stop") {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          doneSent = true;
        }
        // ping, message_start, content_block_start, content_block_stop,
        // message_delta, and everything else — discard
      }
    },

    flush(controller) {
      // Flush remaining decoder state
      const tail = decoder.decode(undefined, { stream: false });
      if (tail) {
        buffer += tail.replace(/\r\n/g, "\n");
        // Process any final complete events in the tail
        const parts = buffer.split("\n\n");
        for (const eventBlock of parts) {
          if (!eventBlock.trim()) continue;
          const dataLines: string[] = [];
          for (const line of eventBlock.split("\n")) {
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trim());
            }
          }
          const dataStr = dataLines.join("");
          if (!dataStr) continue;
          try {
            const event = JSON.parse(dataStr) as AnthropicStreamEvent;
            if (
              event.type === "content_block_delta" &&
              event.delta?.type === "text_delta" &&
              typeof event.delta.text === "string"
            ) {
              const openaiChunk = JSON.stringify({
                choices: [{ delta: { content: event.delta.text }, index: 0 }],
              });
              controller.enqueue(encoder.encode(`data: ${openaiChunk}\n\n`));
            } else if (event.type === "message_stop") {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              doneSent = true;
            }
          } catch {
            // ignore parse errors on flush
          }
        }
      }

      // Defensive: emit [DONE] if upstream closed without message_stop
      if (!doneSent) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      }
    },
  });

  return anthropicStream.pipeThrough(transform);
}
