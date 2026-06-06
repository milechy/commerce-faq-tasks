// src/agent/memory/featureFlag.test.ts
// Phase71-A: Learned Memory Feature Flag テスト

import {
  isLearnedMemoryWriteEnabled,
  isLearnedMemoryReadEnabled,
  getLearnedMemoryThreshold,
  getLearnedMemoryWeight,
} from "./featureFlag";

const ENV_KEYS = [
  "LEARNED_MEMORY_ENABLED",
  "LEARNED_MEMORY_TENANTS",
  "LEARNED_MEMORY_READ_ENABLED",
  "LEARNED_MEMORY_THRESHOLD",
  "LEARNED_MEMORY_WEIGHT",
] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("isLearnedMemoryWriteEnabled", () => {
  it("マスタースイッチ未設定なら false", () => {
    process.env.LEARNED_MEMORY_TENANTS = "carnation";
    expect(isLearnedMemoryWriteEnabled("carnation")).toBe(false);
  });

  it("対象テナントのみ true", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    process.env.LEARNED_MEMORY_TENANTS = "carnation";
    expect(isLearnedMemoryWriteEnabled("carnation")).toBe(true);
    expect(isLearnedMemoryWriteEnabled("other")).toBe(false);
  });

  it("'*' で全テナント true", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    process.env.LEARNED_MEMORY_TENANTS = "*";
    expect(isLearnedMemoryWriteEnabled("anyone")).toBe(true);
  });
});

describe("isLearnedMemoryReadEnabled", () => {
  it("マスタースイッチ ON + 対象テナントで true", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    process.env.LEARNED_MEMORY_TENANTS = "carnation";
    expect(isLearnedMemoryReadEnabled("carnation")).toBe(true);
  });

  it("READ 明示 OFF なら false (write だけ先行可能)", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    process.env.LEARNED_MEMORY_TENANTS = "carnation";
    process.env.LEARNED_MEMORY_READ_ENABLED = "false";
    expect(isLearnedMemoryReadEnabled("carnation")).toBe(false);
    // write 側は引き続き有効
    expect(isLearnedMemoryWriteEnabled("carnation")).toBe(true);
  });
});

describe("getLearnedMemoryThreshold", () => {
  it("既定 80", () => {
    expect(getLearnedMemoryThreshold()).toBe(80);
  });

  it("env で上書き、0-100 にクランプ", () => {
    process.env.LEARNED_MEMORY_THRESHOLD = "70";
    expect(getLearnedMemoryThreshold()).toBe(70);
    process.env.LEARNED_MEMORY_THRESHOLD = "150";
    expect(getLearnedMemoryThreshold()).toBe(100);
  });

  it("不正値は既定 80", () => {
    process.env.LEARNED_MEMORY_THRESHOLD = "abc";
    expect(getLearnedMemoryThreshold()).toBe(80);
  });
});

describe("getLearnedMemoryWeight", () => {
  it("既定 0.9", () => {
    expect(getLearnedMemoryWeight()).toBe(0.9);
  });

  it("env で上書き、0-1 にクランプ", () => {
    process.env.LEARNED_MEMORY_WEIGHT = "0.5";
    expect(getLearnedMemoryWeight()).toBe(0.5);
    process.env.LEARNED_MEMORY_WEIGHT = "2";
    expect(getLearnedMemoryWeight()).toBe(1);
  });
});
