import { describe, it, expect } from "vitest";
import type { KeyboardEvent } from "react";
import { shouldSubmitOnEnter } from "./utils";

// KeyboardEvent の実体を作らず、判定に使うプロパティだけを持つ最小のモックで検証する
// (IMEの変換中状態は happy-dom では忠実に再現できないため、条件そのものを直接叩く)。
function keyEvent(
  key: string,
  opts: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {},
): KeyboardEvent {
  return {
    key,
    shiftKey: opts.shiftKey ?? false,
    nativeEvent: {
      isComposing: opts.isComposing ?? false,
      keyCode: opts.keyCode ?? 13,
    },
  } as unknown as KeyboardEvent;
}

describe("shouldSubmitOnEnter (IMEガード)", () => {
  it("素のEnterは送信する", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter"), false)).toBe(true);
  });

  it("nativeEvent.isComposing が true(変換中)なら送信しない", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter", { isComposing: true }), false)).toBe(false);
  });

  it("nativeEvent.isComposing が false でも isComposing 引数が true なら送信しない(冗長な保険)", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter", { isComposing: false }), true)).toBe(false);
  });

  it("keyCode === 229(isComposingを立てない旧/モバイルIME)なら送信しない", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter", { keyCode: 229 }), false)).toBe(false);
  });

  it("Shift+Enterは送信しない(改行として通す)", () => {
    expect(shouldSubmitOnEnter(keyEvent("Enter", { shiftKey: true }), false)).toBe(false);
  });

  it("Enter以外のキーは送信しない", () => {
    expect(shouldSubmitOnEnter(keyEvent("a"), false)).toBe(false);
  });
});
