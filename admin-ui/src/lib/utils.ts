import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { KeyboardEvent } from "react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// 日本語入力(IME)中のEnterはかな漢字変換の確定であり、送信であってはならない。
// 4つの条件はそれぞれ別のブラウザ差異を塞いでいるため、1つも省略できない:
//   - e.nativeEvent.isComposing: 標準の変換中フラグ
//   - isComposing (React state): nativeEvent が遅れて false になるブラウザ向けの保険
//     (onCompositionStart/End で管理する)
//   - keyCode === 229: isComposing を立てない古い/モバイルIMEが送る変換中キーコード
//   - !e.shiftKey: Shift+Enter は改行として通す
export function shouldSubmitOnEnter(e: KeyboardEvent, isComposing: boolean): boolean {
  return (
    e.key === "Enter" &&
    !e.shiftKey &&
    !e.nativeEvent.isComposing &&
    !isComposing &&
    e.nativeEvent.keyCode !== 229
  );
}
