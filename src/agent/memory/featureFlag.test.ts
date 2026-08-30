// src/agent/memory/featureFlag.test.ts
// Phase71-A: Learned Memory Feature Flag テスト

import {
  isLearnedMemoryWriteEnabled,
  isLearnedMemoryReadEnabled,
  isLearnedMemoryMasterEnabled,
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

describe("isLearnedMemoryMasterEnabled", () => {
  // GID 1217972798328871 (H-6): 手動昇格はallowlistを経由しないため、
  // マスタースイッチ単体の判定関数が独立に必要(isLearnedMemoryWriteEnabledはallowlistも見る)。
  it("LEARNED_MEMORY_ENABLED=trueのみでtrue(テナントallowlistは無関係)", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    // allowlist未設定でも、マスタースイッチ単体はtrue
    expect(isLearnedMemoryMasterEnabled()).toBe(true);
  });

  it("未設定ならfalse", () => {
    expect(isLearnedMemoryMasterEnabled()).toBe(false);
  });

  it("'true'以外の値(例: '1')ならfalse", () => {
    process.env.LEARNED_MEMORY_ENABLED = "1";
    expect(isLearnedMemoryMasterEnabled()).toBe(false);
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

  // H-6欠陥修正 (GID 1217972798328871): 読込みは書込み側 allowlist を見ない。
  // 手動昇格 (allowlist をバイパスする) で保存された行を読めるようにするための挙動変化。
  it("allowlist に無いテナントでも、マスタースイッチ ON なら true (手動昇格した内容を読めるようにするため)", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    process.env.LEARNED_MEMORY_TENANTS = "carnation"; // "not-in-allowlist" を含まない
    expect(isLearnedMemoryReadEnabled("not-in-allowlist")).toBe(true);
  });

  // allowlist 自体が未設定 (空) でも、マスタースイッチ ON なら読込みは開く。
  it("LEARNED_MEMORY_TENANTS 未設定でも、マスタースイッチ ON なら true", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    expect(isLearnedMemoryReadEnabled("anyone")).toBe(true);
  });

  it("マスタースイッチ OFF なら allowlist に関わらず false", () => {
    process.env.LEARNED_MEMORY_TENANTS = "*";
    expect(isLearnedMemoryReadEnabled("anyone")).toBe(false);
  });

  it("write は従来どおり allowlist を見る (read だけを変えたことの固定)", () => {
    process.env.LEARNED_MEMORY_ENABLED = "true";
    process.env.LEARNED_MEMORY_TENANTS = "carnation";
    expect(isLearnedMemoryWriteEnabled("not-in-allowlist")).toBe(false);
    expect(isLearnedMemoryWriteEnabled("carnation")).toBe(true);
    // 同条件で read は allowlist に関わらず true (write との非対称を並べて固定)
    expect(isLearnedMemoryReadEnabled("not-in-allowlist")).toBe(true);
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
