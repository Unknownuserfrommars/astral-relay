// Adapted from subscription-oauth 1.2.7 (MIT): repair missing terminal output for tool continuations.
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
const MAX_BUFFER = 8 * 1024 * 1024;

export function createResponsesRepair(onTerminal?: (response: Record<string, unknown>) => void): Transform {
  const decoder = new StringDecoder("utf8");
  const items = new Map<number, unknown>();
  let pending = "";
  let retainedBytes = 0;
  function frame(text: string): string {
    const lines = text.split(/\r?\n/);
    const indexes = lines.flatMap((line, index) => line.startsWith("data:") ? [index] : []);
    if (indexes.length !== 1) return text;
    const index = indexes[0];
    let event;
    try { event = JSON.parse(lines[index].slice(5).trim()); } catch { return text; }
    if (event?.type === "response.output_item.done" && event.item && typeof event.item === "object") {
      retainedBytes += Buffer.byteLength(JSON.stringify(event.item));
      if (retainedBytes > MAX_BUFFER) throw new Error("Responses output exceeds buffer limit");
      items.set(Number.isInteger(event.output_index) ? event.output_index : items.size, event.item);
    }
    if (["response.completed", "response.incomplete", "response.failed"].includes(event?.type) && event.response) {
      if ((!Array.isArray(event.response.output) || !event.response.output.length) && items.size) {
        event.response.output = [...items].sort(([a], [b]) => a - b).map(([, item]) => item);
        lines[index] = `data: ${JSON.stringify(event)}`;
      }
      onTerminal?.(event.response);
    }
    return lines.join(text.includes("\r\n") ? "\r\n" : "\n");
  }
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        pending += decoder.write(chunk);
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
          if (match.index > MAX_BUFFER) throw new Error("Responses frame exceeds buffer limit");
          this.push(frame(pending.slice(0, match.index)) + match[0]);
          pending = pending.slice(match.index + match[0].length);
        }
        if (Buffer.byteLength(pending) > MAX_BUFFER) throw new Error("Responses frame exceeds buffer limit");
        callback();
      } catch { callback(new Error("Codex response stream could not be processed")); }
    },
    flush(callback) {
      try { pending += decoder.end(); if (pending) this.push(frame(pending)); callback(); }
      catch { callback(new Error("Codex response stream could not be processed")); }
    },
  });
}
