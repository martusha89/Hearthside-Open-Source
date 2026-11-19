import { expect, it } from "vitest";
import { validChatIcon } from "./chat-icon";

it("accepts a single symbol, not a title or a run of symbols", () => {
  expect(validChatIcon("\u2605")).toBe(true);
  for (const value of ["", "Example", "\u2605\u2605", "\u2605\n"]) {
    expect(validChatIcon(value)).toBe(false);
  }
});
