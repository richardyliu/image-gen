import { z } from "zod";
import { getEnv } from "@/lib/env";
import { compileTikz, MAX_TIKZ_LENGTH } from "@/lib/tikz/compile";
import type { TikzErrorBody } from "@/lib/tikz/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  tikz: z.string().min(1).max(MAX_TIKZ_LENGTH),
  libraries: z.array(z.string().regex(/^[a-zA-Z0-9.]+$/)).max(50).optional(),
  theme: z.enum(["light", "dark"]).optional(),
});

const bad = (message: string): Response =>
  Response.json({ error: { stage: "request", code: "invalid_request", message } satisfies TikzErrorBody }, { status: 400 });

export async function POST(request: Request): Promise<Response> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return bad("请求体不是合法 JSON");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return bad(parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));

  const env = getEnv();
  const result = await compileTikz(parsed.data, {
    latexBin: env.latexBin,
    xelatexBin: env.xelatexBin,
    dvisvgmBin: env.dvisvgmBin,
    latexTimeoutMs: env.latexTimeoutMs,
    dvisvgmTimeoutMs: env.dvisvgmTimeoutMs,
    maxConcurrency: env.maxConcurrency,
    cjkFont: env.cjkFont,
  });
  return result.ok ? Response.json(result.value) : Response.json({ error: result.error }, { status: result.status });
}
