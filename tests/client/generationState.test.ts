import { describe, expect, it } from "vitest";
import { initialState, reducer } from "@/lib/client/generationState";

describe("generation reducer", () => {
  it("keeps the repairing flag through the repair stream's phases and resets it on start", () => {
    let s = reducer(initialState, { type: "start", prompt: "p" });
    s = reducer(s, { type: "repairStart" });
    s = reducer(s, { type: "phase", phase: "thinking" });
    expect(s.repairing).toBe(true);
    expect(s.phase).toBe("thinking");
    s = reducer(s, { type: "phase", phase: "writing" });
    expect(s.repairing).toBe(true);
    s = reducer(s, { type: "start", prompt: "q" });
    expect(s.repairing).toBe(false);
  });
  it("clears streamed code when writing begins and appends deltas", () => {
    let s = reducer({ ...initialState, code: "old" }, { type: "phase", phase: "writing" });
    expect(s.code).toBe("");
    s = reducer(s, { type: "delta", text: "\\draw" });
    expect(s.code).toBe("\\draw");
  });
});
