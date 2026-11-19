import { expect, it } from "vitest";
import { parseRequestArgs } from "./index";

it("bounds recent-conversation previews to five unique ids", () => {
  expect(parseRequestArgs("listConversationPreviews", ["agent-one", ["main:agent-one", "chat-two"]]))
    .toEqual(["agent-one", ["main:agent-one", "chat-two"]]);

  expect(() => parseRequestArgs("listConversationPreviews", ["agent-one", []])).toThrow();
  expect(() => parseRequestArgs("listConversationPreviews", ["agent-one", ["chat", "chat"]])).toThrow();
  expect(() => parseRequestArgs("listConversationPreviews", ["agent-one", ["1", "2", "3", "4", "5", "6"]])).toThrow();
});

it("bounds the access-checked Presence calendar window", () => {
  const from = Date.now();
  expect(parseRequestArgs("getPresenceCalendar", ["agent-one", from, from + 60 * 86_400_000]))
    .toEqual(["agent-one", from, from + 60 * 86_400_000]);

  expect(() => parseRequestArgs("getPresenceCalendar", ["agent-one", from, from])).toThrow();
  expect(() => parseRequestArgs("getPresenceCalendar", ["agent-one", from, from + 91 * 86_400_000])).toThrow();
});
