import { AnthropicError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { mapError } from "@/lib/llm/generate";

describe("mapError", () => {
  it("maps the SDK's missing-credentials error to auth with the .env hint", () => {
    const e = mapError(new AnthropicError("Could not resolve authentication method. Expected either apiKey or authToken to be set."));
    expect(e.code).toBe("auth");
    expect(e.message).toContain("ANTHROPIC_API_KEY");
  });
  it("maps unknown errors to upstream", () => {
    expect(mapError(new Error("boom")).code).toBe("upstream");
  });
});
