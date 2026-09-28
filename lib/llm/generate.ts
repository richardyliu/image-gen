import Anthropic, { AnthropicError } from "@anthropic-ai/sdk";
import type { Effort } from "@/lib/env";
import { parseModelOutput } from "./parse";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt";
import type { GenerateErrorCode, GenerateEvent, GenerateRequest } from "./types";

export interface LlmConfig {
  model: string;
  effort: Effort;
  fastMode: boolean;
  fallbacks: boolean;
  maxTokens: number;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic(); // resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile
  return client;
}

export function mapError(err: unknown): { code: GenerateErrorCode; message: string } {
  const AUTH_HINT = "Anthropic API 认证失败:请在 .env.local 里设置 ANTHROPIC_API_KEY(或用 `ant auth login`)";
  if (err instanceof Anthropic.AuthenticationError) return { code: "auth", message: AUTH_HINT };
  // The SDK throws a plain AnthropicError before any request when no credential source resolves.
  if (err instanceof AnthropicError && !(err instanceof Anthropic.APIError) && /authentication|api ?key|auth ?token/i.test(err.message)) return { code: "auth", message: AUTH_HINT };
  if (err instanceof Anthropic.AuthenticationError) return { code: "auth", message: "Anthropic API 认证失败:请在 .env.local 里设置 ANTHROPIC_API_KEY" };
  if (err instanceof Anthropic.RateLimitError) return { code: "rate_limited", message: "触发了速率限制,请稍后重试" };
  if (err instanceof Anthropic.APIUserAbortError) return { code: "upstream", message: "已取消" };
  if (err instanceof Anthropic.APIConnectionError) return { code: "upstream", message: `无法连接 Anthropic API:${err.message}` };
  if (err instanceof Anthropic.APIError) return { code: "upstream", message: `Anthropic API ${err.status ?? ""}: ${err.message}` };
  return { code: "upstream", message: err instanceof Error ? err.message : String(err) };
}

export async function* streamTikz(req: GenerateRequest, cfg: LlmConfig, signal?: AbortSignal): AsyncGenerator<GenerateEvent> {
  const started = Date.now();
  const betas: Anthropic.Beta.AnthropicBeta[] = [];
  if (cfg.fallbacks) betas.push("server-side-fallback-2026-07-01");
  if (cfg.fastMode) betas.push("fast-mode-2026-02-01");

  let text = "";
  let phase: "thinking" | "writing" | null = null;
  try {
    const stream = getClient().beta.messages.stream(
      {
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: cfg.effort },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserMessage(req) }],
        ...(betas.length ? { betas } : {}),
        ...(cfg.fallbacks ? { fallbacks: "default" as const } : {}),
        ...(cfg.fastMode ? { speed: "fast" as const } : {}),
      },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        const t = event.content_block.type;
        if (t === "thinking" && phase !== "thinking") { phase = "thinking"; yield { event: "status", data: { phase } }; }
        if (t === "text" && phase !== "writing") { phase = "writing"; yield { event: "status", data: { phase } }; }
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        yield { event: "delta", data: { text: event.delta.text } };
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") { yield { event: "error", data: { code: "refused", message: "模型拒绝了这个请求" } }; return; }
    if (final.stop_reason === "max_tokens") { yield { event: "error", data: { code: "truncated", message: "输出超过 max_tokens 被截断,请提高 IMAGEGEN_MAX_TOKENS 或简化描述" } }; return; }
    const parsed = parseModelOutput(text);
    if (!parsed.code) { yield { event: "error", data: { code: "parse_failed", message: "模型没有返回 TikZ 代码" } }; return; }
    yield {
      event: "done",
      data: {
        code: parsed.code,
        libraries: parsed.libraries,
        model: final.model,
        usage: { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens, cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0 },
        ms: Date.now() - started,
      },
    };
  } catch (err) {
    if (signal?.aborted) return;
    yield { event: "error", data: mapError(err) };
  }
}
