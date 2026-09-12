import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { createResponsesRepair } from "../src/proxy/responses";

it("repairs fragmented CRLF UTF-8 events without losing tool calls or text", async () => {
  const item = { type: "function_call", call_id: "c", arguments: "中文" };
  const body = `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\r\n\r\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\r\n\r\n`;
  let terminal;
  const source = Readable.from([...Buffer.from(body)].map((byte) => Buffer.from([byte])));
  const repaired = source.pipe(createResponsesRepair((value) => { terminal = value; }));
  let result = "";
  for await (const chunk of repaired) result += chunk.toString();
  expect(result).toContain("中文");
  expect(terminal).toEqual({ output: [item] });
});
