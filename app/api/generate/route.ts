import { z } from "zod";
import { getEnv } from "@/lib/env";
import { streamTikz } from "@/lib/llm/generate";
import { streamTikzMock } from "@/lib/llm/mock";
import { formatSse, type GenerateEvent } from "@/lib/llm/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  prompt: z.string().trim().min(1).max(4000),
  theme: z.enum(["light", "dark"]).optional(),
  repair: z
    .object({
      code: z.string().max(60_000),
      libraries: z.array(z.string().regex(/^[a-zA-Z0-9.]+$/)).max(50),
      errors: z.array(z.object({ line: z.number().int().nullable(), message: z.string().max(500) })).max(10),
    })
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return Response.json({ error: { code: "invalid_request", message: "请求体不是合法 JSON" } }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: { code: "invalid_request", message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") } }, { status: 400 });
  }

  const env = getEnv();
  const source: AsyncGenerator<GenerateEvent> = env.mockLlm
    ? streamTikzMock(parsed.data, request.signal)
    : streamTikz(parsed.data, { model: env.model, effort: env.effort, fastMode: env.fastMode, fallbacks: env.fallbacks, maxTokens: env.maxTokens }, request.signal);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of source) controller.enqueue(encoder.encode(formatSse(ev)));
      } catch (err) {
        controller.enqueue(encoder.encode(formatSse({ event: "error", data: { code: "upstream", message: err instanceof Error ? err.message : String(err) } })));
      } finally {
        controller.close();
      }
    },
    cancel() {
      void source.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
