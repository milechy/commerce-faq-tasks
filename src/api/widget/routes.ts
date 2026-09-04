// src/api/widget/routes.ts
// GET /widget/:tenantSlug.js — serve per-tenant dynamically generated widget JS.
//
// - Looks up tenant by ID (slug = tenant ID).
// - Injects tenant config + 24h session token.
// - Returns obfuscated JS with Cache-Control: public, max-age=300
//   (短縮理由: excluded_page_patterns 等のテナント設定変更をほぼ即時に反映するため)。
// - 404 if tenant not found or inactive.

import type { Express, Request, Response } from "express";
import { Pool } from "pg";
import { generateWidgetJs } from "./widgetGenerator";
import { resolveAvatarAssignment } from "../conversion/avatarAbExperiment";
import { planHasFeature, planShowsAdPromo } from "../../lib/billing/planFeatures";

const API_BASE_URL =
  process.env.API_BASE_URL ?? "https://api.r2c.biz";

// ウィジェットの「Powered by R2C」バッジの遷移先（LPトップではなく専用着地ページ）。
//
// 2026-09-04 実測（2026-08-24 の記述を訂正）: apex の r2c.biz は **解決する**
// （65.108.159.161）。ただし解決先は api.r2c.biz と同じ Express アプリであり、
// 独立したマーケティングサイトではない。実測値は以下のとおり。
//   https://r2c.biz/lp/from-chat/      → 200（api.r2c.biz と同一コンテンツ）
//   https://api.r2c.biz/lp/from-chat/  → 200
//   https://r2c.biz/  と  https://api.r2c.biz/  → どちらも 404
//
// つまり既定値を apex へ変えても到達先は同じで、本番のリンク先を変える risk に
// 見合う利益がない。よって既定値は API_BASE_URL のままとする。apex に独立した
// LP を立てたときに、その作業とセットで env（LP_BASE_URL）で切り替える。
// buildBadgeUrl / buildAdPromoUrl の遷移先は /lp/from-chat/ のみで、
// 404 になる apex の `/` へは行かない。
const LP_BASE_URL = process.env.LP_BASE_URL ?? API_BASE_URL;

/**
 * バッジのリンクURL（UTM + テナント識別子付き）を組み立てる。
 * rel="nofollow sponsored" はリンク自体（widget.js側）に付与する。ここではURLのみ。
 */
function buildBadgeUrl(tenantId: string): string {
  const params = new URLSearchParams({
    utm_source: "widget",
    utm_medium: "badge",
    utm_campaign: "powered_by",
    r2c_ref: tenantId,
  });
  return `${LP_BASE_URL}/lp/from-chat/?${params.toString()}`;
}

/**
 * free_ad プラン向け広告帯のリンクURL（UTM + テナント識別子付き）を組み立てる。
 * utm_medium を badge(powered_by)と分けるのは流入計測を混ぜないため。
 * rel="nofollow sponsored" はリンク自体（widget.js側）に付与する。ここではURLのみ。
 */
function buildAdPromoUrl(tenantId: string): string {
  const params = new URLSearchParams({
    utm_source: "widget",
    utm_medium: "ad_promo",
    utm_campaign: "free_ad",
    r2c_ref: tenantId,
  });
  return `${LP_BASE_URL}/lp/from-chat/?${params.toString()}`;
}

export function registerWidgetRoutes(app: Express, db: Pool | null): void {
  app.get("/widget/:tenantSlug.js", async (req: Request, res: Response) => {
    const { tenantSlug } = req.params;

    if (!db) {
      // No DB — fall back to static widget.js redirect
      // CLAUDE.md 絶対にやってはいけないこと 38 の③経路。リダイレクト先は
      // プラン判定を経由しない静的配布物(②)のため、excluded_page_patterns を含む
      // window.__RAJIUCE_TENANT_CFG__ 由来の設定は一切注入されない(fail-open、
      // 既知の制限。tests/widget/pageExclusion.test.ts で固定)。
      return res.redirect("/widget.js");
    }

    try {
      const result = await db.query(
        `SELECT id, is_active, features, plan, excluded_page_patterns
         FROM tenants
         WHERE id = $1`,
        [tenantSlug]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ error: "tenant_not_found" });
      }

      const tenant = result.rows[0];
      if (!tenant.is_active) {
        return res.status(404).json({ error: "tenant_inactive" });
      }

      const features = tenant.features ?? {};
      const defaultAvatarEnabled: boolean = features.avatar ?? false;

      // GID 1216978855735482: 「アバターあり vs テキストのみ」A/Bテスト。
      // 生成時点ではまだ chat_session の session_id が存在しない（ページ読み込み時に
      // 1回だけ呼ばれる）ため、厳密なsession単位ではなく、visitor近似のsticky key
      // （IP+テナントID）で決定的に割り当てる。IPが同じ限り何度呼び出しても同じ結果に
      // なるためキャッシュ期間の長さそのものには依存しないが、Cache-Controlを
      // 5分（旧24h）に短縮したことで、IPが変わる訪問（モバイル⇄Wi-Fi切替等）が
      // 従来より短い間隔でブラウザキャッシュを経由せず再割当されうる点は変わった。
      // features.avatar=false のテナントでは実験を一切参照しない（ガード）。
      const stickyKey = `${req.ip ?? "unknown"}:${tenant.id}`;
      const assignment = await resolveAvatarAssignment(db, tenant.id, stickyKey, defaultAvatarEnabled);

      // planHasFeature は plan が null/未知/未設定のとき starter 相当に倒れる（fail-safe）ため、
      // hide_branding を満たさない = true となりバッジは「表示する」側に自然に倒れる。
      const showBrandingBadge = !planHasFeature(tenant.plan, "hide_branding");

      // planShowsAdPromo は plan が null/未知/未設定のとき false に倒れる（fail-safe）ため、
      // hide_branding とは逆に「掲出しない」側が判定不能時の既定になる。
      // 有料テナントのサイトに誤って広告が出る事故を、無料テナントの掲出漏れより重く見る。
      const showAdPromo = planShowsAdPromo(tenant.plan);

      const js = await generateWidgetJs({
        tenantId: tenant.id,
        apiBaseUrl: API_BASE_URL,
        avatarEnabled: assignment.avatarEnabled,
        themeColor: "#22c55e",
        abExperimentId: assignment.experimentId,
        abVariant: assignment.variant,
        showBrandingBadge,
        badgeUrl: buildBadgeUrl(tenant.id),
        showAdPromo,
        adPromoUrl: buildAdPromoUrl(tenant.id),
        excludedPagePatterns: tenant.excluded_page_patterns ?? [],
      });

      res.set("Content-Type", "application/javascript; charset=utf-8");
      // ページ除外設定(excluded_page_patterns)の変更をほぼ即時に反映させるため、
      // 24h(旧 max-age=86400)から5分に短縮。A/Bアバター割当はIP+テナントIDの
      // 決定的sticky keyのため、キャッシュが切れて再生成されても結果は変わらない。
      res.set("Cache-Control", "public, max-age=300");
      res.set("X-Content-Type-Options", "nosniff");
      return res.send(js);
    } catch (err) {
      return res.status(500).json({ error: "widget_generation_failed" });
    }
  });
}
