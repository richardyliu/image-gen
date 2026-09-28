import { parseTikzSource } from "@/lib/tikz/document";

export interface ParsedModelOutput {
  code: string;
  libraries: string[];
}

export function parseModelOutput(text: string): ParsedModelOutput {
  const blocks = [...text.matchAll(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  let code: string;
  if (blocks.length) {
    code = blocks.find((b) => b.includes("tikzpicture") || b.includes("tikzcd") || b.includes("circuitikz")) ?? blocks[0];
  } else {
    const open = text.indexOf("```");
    if (open >= 0) {
      const nl = text.indexOf("\n", open);
      code = nl >= 0 ? text.slice(nl + 1) : "";
    } else {
      code = text;
    }
  }
  code = code.replace(/\r\n?/g, "\n").trim();
  return { code, libraries: parseTikzSource(code).libraries };
}
