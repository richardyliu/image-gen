export interface SseMessage {
  event: string;
  data: string;
}

function parseFrame(frame: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : null;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const msg = parseFrame(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (msg) yield msg;
        sep = buffer.indexOf("\n\n");
      }
      if (done) {
        const tail = parseFrame(buffer);
        if (tail) yield tail;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
