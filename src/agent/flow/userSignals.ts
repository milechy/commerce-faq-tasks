// src/agent/flow/userSignals.ts

export type YesNo = "yes" | "no" | "unknown";

const YES_PATTERNS: RegExp[] = [
  /^はい$/i,
  /^うん$/i,
  /^ok$/i,
  /^okay$/i,
  /^yes$/i,
  /^y$/i,
  /^承知$/i,
  /^了解$/i,
  /^お願いします$/i,
];

const NO_PATTERNS: RegExp[] = [
  /^いいえ$/i,
  /^いや$/i,
  /^no$/i,
  /^n$/i,
  /^不要$/i,
  /^やめる$/i,
  /^やめます$/i,
];

const STOP_PATTERNS: RegExp[] = [
  /^(終了|終わり|やめる|中止|ストップ)$/i,
  /^stop$/i,
  /^quit$/i,
  /^cancel$/i,
];

export function detectUserStop(message: string): boolean {
  const m = message.trim();
  return STOP_PATTERNS.some((re) => re.test(m));
}

export function detectYesNo(message: string): YesNo {
  const m = message.trim();
  if (YES_PATTERNS.some((re) => re.test(m))) return "yes";
  if (NO_PATTERNS.some((re) => re.test(m))) return "no";
  return "unknown";
}
