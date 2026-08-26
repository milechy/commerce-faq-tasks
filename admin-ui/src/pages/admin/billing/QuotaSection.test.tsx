// UX-C(2026-08-26): 込み枠・無料枠の残量表示。
// ここで固定するのは見た目ではなく「読み違えないこと」:
//   - free_ad が上限に到達したら「新しい会話は開始できません」と明言すること
//   - テキストとアバターが別枠であること(片方の余りがもう片方の超過を隠さない)
//   - 込み枠を持たないプラン(starter/enterprise)に「あと◯件」を出さないこと
//   - 未取得(loading/error)を「0件」と混同しないこと
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuotaSection } from "./QuotaSection";
import type { BillingQuota } from "./types";

function makeQuota(overrides: Partial<BillingQuota> = {}): BillingQuota {
  return {
    tenantId: "tenant-a",
    plan: "standard",
    periodFrom: "2026-08-01T00:00:00.000Z",
    periodTo: "2026-09-01T00:00:00.000Z",
    text: { used: 0, included: 1000, overage: 0 },
    avatar: { usedMinutes: 0, includedMinutes: 30, overageMinutes: 0 },
    freeAd: null,
    ...overrides,
  };
}

describe("QuotaSection", () => {
  it("loading: 読み込み中と出し、0件や具体的な数値を先走って出さない", () => {
    render(<QuotaSection quota={null} status="loading" />);
    expect(screen.getByText(/集計しています/)).toBeTruthy();
  });

  it("error: 取得できなかったことを明示し、0件と混同しない", () => {
    render(<QuotaSection quota={null} status="error" />);
    expect(screen.getByText(/通信状況により表示できません/)).toBeTruthy();
    expect(screen.queryByText(/0 \//)).toBeNull();
  });

  it("quotaがnullでもstatus=readyでクラッシュしない(防御的な扱い)", () => {
    render(<QuotaSection quota={null} status="ready" />);
    expect(screen.getByText(/通信状況により表示できません/)).toBeTruthy();
  });

  describe("standard/growth(込み枠あり)", () => {
    it("テキスト会話・アバター利用の両方を表示する", () => {
      const quota = makeQuota({ text: { used: 300, included: 1000, overage: 0 } });
      render(<QuotaSection quota={quota} status="ready" />);

      expect(screen.getByText("テキスト会話")).toBeTruthy();
      expect(screen.getByText("アバター利用")).toBeTruthy();
      expect(screen.getByText(/300 \/ 1,000 会話/)).toBeTruthy();
    });

    // ★別枠であることの表示レベルでの確認★ テキストに余裕があっても
    // アバター超過の警告が独立して出ること。
    it("テキストに余裕があってもアバター超過は独立して警告される", () => {
      const quota = makeQuota({
        text: { used: 100, included: 1000, overage: 0 },
        avatar: { usedMinutes: 45, includedMinutes: 30, overageMinutes: 15 },
      });
      render(<QuotaSection quota={quota} status="ready" />);

      expect(screen.getByText(/込み枠を 15分 超過しています/)).toBeTruthy();
      expect(screen.queryByText(/込み枠を 0会話 超過/)).toBeNull();
    });

    it("超過0のときは超過警告を出さない", () => {
      const quota = makeQuota({ text: { used: 500, included: 1000, overage: 0 } });
      render(<QuotaSection quota={quota} status="ready" />);
      expect(screen.queryByText(/超過しています/)).toBeNull();
    });

    it("growthの込み枠(3,000/150)がstandardと違う数値として表示される", () => {
      const quota = makeQuota({
        plan: "growth",
        text: { used: 2000, included: 3000, overage: 0 },
        avatar: { usedMinutes: 80, includedMinutes: 150, overageMinutes: 0 },
      });
      render(<QuotaSection quota={quota} status="ready" />);
      expect(screen.getByText(/2,000 \/ 3,000 会話/)).toBeTruthy();
      expect(screen.getByText(/80 \/ 150 分/)).toBeTruthy();
    });

    it("月中のプラン変更で込み枠を日割りしない旨を明示する", () => {
      const quota = makeQuota();
      render(<QuotaSection quota={quota} status="ready" />);
      expect(screen.getByText(/日割りしません/)).toBeTruthy();
    });
  });

  describe("starter(込み枠という概念が無い)", () => {
    it("「あと◯件」のような残数表現を出さず、純従量であることを明示する", () => {
      const quota = makeQuota({
        plan: "starter",
        text: { used: 250, included: null, overage: 0 },
        avatar: { usedMinutes: 0, includedMinutes: null, overageMinutes: 0 },
      });
      render(<QuotaSection quota={quota} status="ready" />);

      expect(screen.getByText(/純従量プラン/)).toBeTruthy();
      expect(screen.getByText(/250会話/)).toBeTruthy();
      expect(screen.queryByText("テキスト会話")).toBeNull(); // バーは出さない
    });
  });

  describe("enterprise(無制限)", () => {
    it("上限が無いことを明示し、参考として当月の利用量を出す", () => {
      const quota = makeQuota({
        plan: "enterprise",
        text: { used: 5000, included: null, overage: 0 },
        avatar: { usedMinutes: 300, includedMinutes: null, overageMinutes: 0 },
      });
      render(<QuotaSection quota={quota} status="ready" />);

      expect(screen.getByText(/上限がありません/)).toBeTruthy();
      expect(screen.getByText(/5,000会話/)).toBeTruthy();
    });
  });

  describe("free_ad(月200会話の無料枠)", () => {
    it("通常時は警告なし", () => {
      const quota = makeQuota({
        plan: "free_ad",
        freeAd: { used: 50, limit: 200, remaining: 150 },
      });
      render(<QuotaSection quota={quota} status="ready" />);

      expect(screen.getByText(/50 \/ 200 会話/)).toBeTruthy();
      expect(screen.queryByText(/上限に到達/)).toBeNull();
      expect(screen.queryByText(/上限に近づいています/)).toBeNull();
    });

    // 80%閾値の境界: remaining <= limit*0.2 (=40) で警告に切り替わる
    it("残り20%以下(remaining=40)で「上限に近づいています」を出す", () => {
      const quota = makeQuota({
        plan: "free_ad",
        freeAd: { used: 160, limit: 200, remaining: 40 },
      });
      render(<QuotaSection quota={quota} status="ready" />);
      expect(screen.getByText(/残り40会話です。上限に近づいています/)).toBeTruthy();
    });

    it("残り21%(remaining=41)ではまだ警告を出さない(境界のもう一方)", () => {
      const quota = makeQuota({
        plan: "free_ad",
        freeAd: { used: 159, limit: 200, remaining: 41 },
      });
      render(<QuotaSection quota={quota} status="ready" />);
      expect(screen.queryByText(/上限に近づいています/)).toBeNull();
    });

    // ★最重要: 上限到達時の文言★ 「新しい会話は開始できません」と明言しないと、
    // テナントは何が起きているか分からないままウィジェットが応答しなくなる。
    it("上限到達(remaining=0)で新規会話が止まることを明言する", () => {
      const quota = makeQuota({
        plan: "free_ad",
        freeAd: { used: 200, limit: 200, remaining: 0 },
      });
      render(<QuotaSection quota={quota} status="ready" />);
      expect(screen.getByText(/今月の上限に到達しています。新しい会話は翌月まで開始できません。/)).toBeTruthy();
    });

    it("free_adではテキスト/アバターの込み枠バーを別途出さない(専用バーのみ)", () => {
      const quota = makeQuota({
        plan: "free_ad",
        freeAd: { used: 50, limit: 200, remaining: 150 },
      });
      render(<QuotaSection quota={quota} status="ready" />);
      expect(screen.queryByText("テキスト会話")).toBeNull();
      expect(screen.queryByText("アバター利用")).toBeNull();
    });
  });
});
