import { describe, expect, test } from "bun:test";
import {
  applyV2Retention,
  collectV2Images,
  countV2Images,
  injectObservations,
  stripV2Images,
  type V2Message,
} from "../../src/v2/transform.js";

function img(data: string, mime = "image/png"): string {
  return `data:${mime};base64,${data}`;
}

function toolResultMessage(parts: unknown[]): V2Message {
  return {
    role: "tool",
    parts: [{ type: "tool-result", name: "read", result: { type: "content", value: parts } }],
  };
}

describe("V2 transform: strip", () => {
  test("replaces nested tool-result image parts with text notes", () => {
    const messages: V2Message[] = [
      toolResultMessage([
        { type: "text", text: "Image read successfully" },
        { type: "file", uri: img("QUFBQQ=="), mime: "image/png", name: "a.png" },
      ]),
    ];
    expect(countV2Images(messages)).toBe(1);
    const removed = stripV2Images(messages);
    expect(removed).toBe(1);
    expect(countV2Images(messages)).toBe(0);
    const value = (messages[0]!.parts![0]!.result as { value: Array<Record<string, unknown>> }).value;
    expect(value[1]!.type).toBe("text");
    expect(String(value[1]!.text)).toContain("[image omitted:");
    expect(value[1]!.uri).toBeUndefined();
  });

  test("replaces a stray top-level file image part", () => {
    const messages: V2Message[] = [{ role: "user", parts: [{ type: "file", uri: img("QUFBQQ=="), mime: "image/png" }] }];
    expect(stripV2Images(messages)).toBe(1);
    expect(messages[0]!.parts![0]!.type).toBe("text");
  });
});

describe("V2 transform: collect/retention", () => {
  test("collects images oldest-first with byte sizes", () => {
    const messages: V2Message[] = [
      toolResultMessage([{ type: "file", uri: img("QUFB"), mime: "image/png" }]),
      toolResultMessage([{ type: "file", uri: img("QUFBQkJC"), mime: "image/png" }]),
    ];
    const items = collectV2Images(messages);
    expect(items.length).toBe(2);
    expect(items[0]!.bytes).toBe(3);
    expect(items[1]!.bytes).toBe(6);
  });

  test("evicts planned images and swaps them for the placeholder", () => {
    const placeholder = img("iVBORw0KGgo=");
    const messages: V2Message[] = [
      toolResultMessage([{ type: "file", uri: img("QUFBQQ=="), mime: "image/png" }]),
      toolResultMessage([{ type: "file", uri: img("QUFBQkJC"), mime: "image/png" }]),
    ];
    const firstHash = collectV2Images(messages)[0]!.sha256;
    const outcome = applyV2Retention(
      messages,
      (items) => ({ evict: items.filter((i) => i.id.startsWith(`${firstHash}:`)).map((i) => i.id) }),
      placeholder,
    );
    expect(outcome.evicted).toBe(1);
    expect(outcome.kept).toBe(1);
    const value = (messages[0]!.parts![0]!.result as { value: Array<{ uri?: string }> }).value;
    expect(value[0]!.uri).toBe(placeholder);
  });
});

describe("V2 transform: inject", () => {
  test("appends observations into the last tool-result value", () => {
    const messages: V2Message[] = [toolResultMessage([{ type: "text", text: "Image read successfully" }])];
    const ok = injectObservations(messages, ["[vision] analysis of 1 image(s): red"]);
    expect(ok).toBe(true);
    const value = (messages[0]!.parts![0]!.result as { value: Array<Record<string, unknown>> }).value;
    expect(value.at(-1)!.text).toContain("[vision] analysis");
  });
});
