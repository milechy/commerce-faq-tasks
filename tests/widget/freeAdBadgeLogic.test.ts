// tests/widget/freeAdBadgeLogic.test.ts
// widget.js の「Powered by R2C」バッジ描画判定 と
// free_adプラン月次上限到達メッセージの表示判定 のユニットテスト。
//
// 方針: 他の tests/widget/*.test.ts と同様、実際の widget.js を eval せず、
// 同一ロジックを抽出して検証する（public/widget.js の該当箇所と完全同一に保つこと）。
// ロジックの乖離は tests/widget/widgetSourceInvariants.test.ts が実ファイル側の
// 実装をこの契約から外れていないか正規表現で機械的にチェックする。

// public/widget.js: if (showBrandingBadge && badgeUrl) { ... } の描画判定
function shouldRenderBadge(showBrandingBadge: unknown, badgeUrl: unknown): boolean {
  return Boolean(showBrandingBadge && badgeUrl);
}

// public/widget.js: catch (err) 内の plan_upgrade_required 分岐。
// 「表示すべきか」と「以降のフラグの値」を分離して返す(widget.js側は
// freeAdQuotaMessageShown を直接書き換えるが、ここではロジックのみ抽出する)。
function shouldShowFreeAdQuotaMessage(
  errCode: unknown,
  alreadyShown: boolean,
): { isQuotaError: boolean; shouldDisplay: boolean; nextShownFlag: boolean } {
  const isQuotaError = errCode === "plan_upgrade_required";
  if (!isQuotaError) {
    return { isQuotaError: false, shouldDisplay: false, nextShownFlag: alreadyShown };
  }
  if (alreadyShown) {
    return { isQuotaError: true, shouldDisplay: false, nextShownFlag: true };
  }
  return { isQuotaError: true, shouldDisplay: true, nextShownFlag: true };
}

describe("widget.js shouldRenderBadge", () => {
  describe("正常系", () => {
    it("showBrandingBadge=true かつ badgeUrl あり → 描画する", () => {
      expect(shouldRenderBadge(true, "https://api.r2c.biz/lp/from-chat/?r2c_ref=t")).toBe(true);
    });

    it("showBrandingBadge=false → badgeUrlがあっても描画しない(Growth以上)", () => {
      expect(shouldRenderBadge(false, "https://api.r2c.biz/lp/from-chat/?r2c_ref=t")).toBe(false);
    });
  });

  describe("境界値・異常系", () => {
    it("badgeUrl=null → showBrandingBadge=trueでも描画しない(静的埋め込み等でconfig欠落時)", () => {
      expect(shouldRenderBadge(true, null)).toBe(false);
    });

    it("badgeUrl=undefined → 描画しない", () => {
      expect(shouldRenderBadge(true, undefined)).toBe(false);
    });

    it("badgeUrl=空文字 → falsyのため描画しない", () => {
      expect(shouldRenderBadge(true, "")).toBe(false);
    });

    it("showBrandingBadge=undefined(_rajiuceTenantCfgが空オブジェクトの静的埋め込み経路)かつbadgeUrlありでも描画しない — ただしwidget.js側の変数宣言自体はfail-safeでtrueに倒れるため、この組み合わせは実際には発生しない想定。念のため境界を固定する", () => {
      expect(shouldRenderBadge(undefined, "https://api.r2c.biz/lp/from-chat/")).toBe(false);
    });

    it("両方falsy → 描画しない", () => {
      expect(shouldRenderBadge(false, null)).toBe(false);
      expect(shouldRenderBadge(undefined, undefined)).toBe(false);
    });
  });
});

describe("widget.js shouldShowFreeAdQuotaMessage", () => {
  describe("正常系", () => {
    it("plan_upgrade_required かつ未表示 → 表示し、フラグをtrueにする", () => {
      const r = shouldShowFreeAdQuotaMessage("plan_upgrade_required", false);
      expect(r.isQuotaError).toBe(true);
      expect(r.shouldDisplay).toBe(true);
      expect(r.nextShownFlag).toBe(true);
    });
  });

  describe("イレギュラー: 同一会話で何度もリクエストが失敗する", () => {
    it("plan_upgrade_required かつ既に表示済み → 表示しない(1会話1回。CLAUDE.md 禁止11)", () => {
      const r = shouldShowFreeAdQuotaMessage("plan_upgrade_required", true);
      expect(r.shouldDisplay).toBe(false);
      expect(r.nextShownFlag).toBe(true); // 表示済みのまま維持
    });

    it("3回連続でエラーになっても表示されるのは最初の1回だけ(状態遷移をシミュレート)", () => {
      let shown = false;
      const results: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        const r = shouldShowFreeAdQuotaMessage("plan_upgrade_required", shown);
        results.push(r.shouldDisplay);
        shown = r.nextShownFlag;
      }
      expect(results).toEqual([true, false, false]);
    });
  });

  describe("境界値・異常系: plan_upgrade_required以外のエラー", () => {
    it("通信エラー(コード無し)は quota メッセージ扱いにしない(通常のshowErrorへ流す)", () => {
      const r = shouldShowFreeAdQuotaMessage(undefined, false);
      expect(r.isQuotaError).toBe(false);
      expect(r.shouldDisplay).toBe(false);
    });

    it("別のエラーコード(例: 'unauthorized')は quota メッセージ扱いにしない", () => {
      const r = shouldShowFreeAdQuotaMessage("unauthorized", false);
      expect(r.isQuotaError).toBe(false);
      expect(r.shouldDisplay).toBe(false);
    });

    it("別のエラーが起きても、既にquotaメッセージを表示済みのフラグ自体は書き換わらない", () => {
      const r = shouldShowFreeAdQuotaMessage("server_error", true);
      expect(r.nextShownFlag).toBe(true);
    });

    it("空文字のerrCodeはquotaエラー扱いにしない", () => {
      const r = shouldShowFreeAdQuotaMessage("", false);
      expect(r.isQuotaError).toBe(false);
    });
  });
});
