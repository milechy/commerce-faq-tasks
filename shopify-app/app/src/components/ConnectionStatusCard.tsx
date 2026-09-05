// shopify-app/app/src/components/ConnectionStatusCard.tsx
//
// 接続状態表示画面(FR-09)。テナントID・現在のプラン・稼働可否を表示するだけ。
// 「稼働可否」の判定ロジック(Shopify Billing の承認状態→is_active)はサーバ側
// (suspensionGate.ts 等)が唯一の真実であり、ここでは settings.is_active を
// そのまま表示するだけで独自に判定しない。

import type { ShopifySettings } from "../types";

// 画面に出す語彙は内部語(プラン文字列)と分ける(CLAUDE.md「命名」節)。
const PLAN_LABELS: Record<string, string> = {
  free_ad: "無料(広告表示あり)",
  starter: "Starter",
  standard: "Standard",
  growth: "Growth",
  enterprise: "Enterprise",
};

function planLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}

export function ConnectionStatusCard({ settings }: { settings: ShopifySettings }) {
  return (
    <section className="r2c-card" aria-label="接続状態">
      <h2 className="r2c-card__title">接続状態</h2>
      <dl className="r2c-status-list">
        <div className="r2c-status-list__row">
          <dt>テナントID</dt>
          <dd>{settings.tenant_id}</dd>
        </div>
        <div className="r2c-status-list__row">
          <dt>現在のプラン</dt>
          <dd>{planLabel(settings.plan)}</dd>
        </div>
        <div className="r2c-status-list__row">
          <dt>稼働状況</dt>
          <dd>
            <span
              className={
                settings.is_active
                  ? "r2c-badge r2c-badge--active"
                  : "r2c-badge r2c-badge--inactive"
              }
            >
              {settings.is_active ? "稼働中" : "停止中"}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
