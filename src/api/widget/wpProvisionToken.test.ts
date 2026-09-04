// src/api/widget/wpProvisionToken.test.ts
//
// 要件書 docs/WORDPRESS_PLUGIN_REQUIREMENTS.md の以下を固定する:
//   X-2  確認メールのトークン期限切れ("存在しない"と区別する → 禁止20)
//   I-6  確認リンクを2回クリックしても壊れない(値の生成は毎回別物)
//   I-7  何日も放置してからクリックする

import { createHash } from "node:crypto";
import {
  WP_CHALLENGE_PREFIX,
  WP_POLL_TOKEN_PREFIX,
  WP_CHALLENGE_TTL_MINUTES,
  WP_PROVISION_TTL_HOURS,
  generateWpChallenge,
  generateWpPollToken,
  hashWpSecret,
  maskWpSecret,
  hasWpSecretPrefix,
  isWpSecretExpired,
} from "./wpProvisionToken";

describe("秘密値の生成", () => {
  it("チャレンジは wpc_ + 64桁hex", () => {
    expect(generateWpChallenge()).toMatch(/^wpc_[0-9a-f]{64}$/);
  });

  it("ポーリングトークンは wpp_ + 64桁hex", () => {
    expect(generateWpPollToken()).toMatch(/^wpp_[0-9a-f]{64}$/);
  });

  // 生成が毎回異なることは、この機能の安全性そのもの。定数を返す実装に
  // 退行しても型は通るため、テストで固定する。
  it("呼ぶたびに異なる値を返す", () => {
    const values = new Set(Array.from({ length: 200 }, () => generateWpChallenge()));
    expect(values.size).toBe(200);
  });

  it("チャレンジとポーリングトークンはプレフィックスで区別できる", () => {
    expect(hasWpSecretPrefix(generateWpChallenge(), WP_CHALLENGE_PREFIX)).toBe(true);
    expect(hasWpSecretPrefix(generateWpChallenge(), WP_POLL_TOKEN_PREFIX)).toBe(false);
    expect(hasWpSecretPrefix(generateWpPollToken(), WP_POLL_TOKEN_PREFIX)).toBe(true);
    expect(hasWpSecretPrefix(generateWpPollToken(), WP_CHALLENGE_PREFIX)).toBe(false);
  });

  it.each([[null], [undefined], [123], [{}]])("非文字列 %p でも throw しない", (input) => {
    expect(hasWpSecretPrefix(input as unknown as string, WP_CHALLENGE_PREFIX)).toBe(false);
  });
});

describe("ハッシュとマスク", () => {
  // 方式が apiKeyUtils と割れると、保存済みハッシュと照合できなくなる。
  it("SHA-256 の16進表現であり、apiKeyUtils と同じ方式である", () => {
    const secret = generateWpPollToken();
    const expected = createHash("sha256").update(secret).digest("hex");
    expect(hashWpSecret(secret)).toBe(expected);
    expect(hashWpSecret(secret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("同じ入力からは同じハッシュ、異なる入力からは異なるハッシュ", () => {
    const a = generateWpPollToken();
    const b = generateWpPollToken();
    expect(hashWpSecret(a)).toBe(hashWpSecret(a));
    expect(hashWpSecret(a)).not.toBe(hashWpSecret(b));
  });

  it("マスクは先頭12文字までしか出さない", () => {
    const secret = generateWpPollToken();
    const masked = maskWpSecret(secret);
    expect(masked).toBe(secret.slice(0, 12) + "****");
    expect(masked).toHaveLength(16);
    // 秘密の本体(13文字目以降)が漏れていないこと
    expect(masked).not.toContain(secret.slice(12));
  });
});

describe("有効期限の判定", () => {
  const base = new Date("2026-09-04T00:00:00.000Z");
  const at = (ms: number) => new Date(base.getTime() + ms);

  it("TTL 未満は期限内", () => {
    expect(isWpSecretExpired(base, at(14 * 60_000), WP_CHALLENGE_TTL_MINUTES)).toBe(false);
  });

  // 境界はちょうどで期限切れ(">=")。片側だけずれると、1分の窓が残る。
  it("TTL ちょうどは期限切れ", () => {
    expect(isWpSecretExpired(base, at(15 * 60_000), WP_CHALLENGE_TTL_MINUTES)).toBe(true);
  });

  it("TTL 超過は期限切れ", () => {
    expect(isWpSecretExpired(base, at(16 * 60_000), WP_CHALLENGE_TTL_MINUTES)).toBe(true);
  });

  // I-7: 何日も放置してからクリックする
  it("24時間の窓は境界の前後で切り替わる", () => {
    const ttl = WP_PROVISION_TTL_HOURS * 60;
    expect(isWpSecretExpired(base, at(23 * 3600_000), ttl)).toBe(false);
    expect(isWpSecretExpired(base, at(24 * 3600_000), ttl)).toBe(true);
    expect(isWpSecretExpired(base, at(72 * 3600_000), ttl)).toBe(true);
  });

  // process TZ に依存しないこと(→ 禁止16)。同じ瞬間を表す Date なら
  // ローカル時刻の見え方に関わらず同じ判定になる。
  it("タイムゾーン表記が違っても同じ瞬間なら同じ判定になる", () => {
    const utc = new Date("2026-09-04T00:00:00.000Z");
    const jst = new Date("2026-09-04T09:00:00.000+09:00");
    expect(utc.getTime()).toBe(jst.getTime());
    expect(isWpSecretExpired(utc, at(10 * 60_000), 15)).toBe(
      isWpSecretExpired(jst, at(10 * 60_000), 15)
    );
  });

  // fail-closed: 判定できないものを「期限内」に倒すと、壊れた行で発行が通る。
  it.each([
    ["issuedAt が Invalid Date", new Date("nope"), base, 15],
    ["now が Invalid Date", base, new Date("nope"), 15],
    ["TTL が NaN", base, base, Number.NaN],
    ["TTL が負", base, base, -1],
  ])("%s は期限切れに倒す", (_label, issued, now, ttl) => {
    expect(isWpSecretExpired(issued as Date, now as Date, ttl as number)).toBe(true);
  });

  it("未来に発行された値(時刻ずれ)は期限内として扱う", () => {
    expect(isWpSecretExpired(at(60_000), base, 15)).toBe(false);
  });
});
