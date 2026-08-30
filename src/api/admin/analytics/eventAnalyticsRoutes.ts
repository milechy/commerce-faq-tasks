// src/api/admin/analytics/eventAnalyticsRoutes.ts
// Phase55: 行動イベント分析API
//
// GET /v1/admin/analytics/events
//   認可: super_admin → 全テナント / client_admin → 自テナントのみ
//   クエリ: ?tenant_id=xxx&period=7d&group_by=event_type
//
// GID 1217972514545047 [オーファンAPI調査, 2026-08-30]: admin-ui のどの画面からも
// 呼ばれていない(consumer無し)ことを確認済み。PR #1062([H-7])でこのルートに
// analytics(Standard〜)プランゲートを追加した際に発覚した。
//
// 調べた範囲(いずれもヒットなし): admin-ui/src 全体、public/(widget.js含む)、
// cloudflare-workers/、SCRIPTS/、avatar-agent/、convex/、front/、tools/、
// .claude/ 配下、src/api/hermes-mcp/(MCP経路)。admin-ui/src/pages/admin/analytics/index.tsx
// は summary・trends・evaluations・conversions・knowledge-attribution・metrics-history・
// flow-transitions 等の兄弟エンドポイントは軒並み呼んでいるが、この events だけが
// 呼ばれていない。
//
// 経緯: git log で Phase55 導入コミット(3a0b3ace, 2026-04-05)まで遡ると、
// このルートは widget側のイベント収集API(POST /api/events)・EventTracker と
// セットで「イベントストリーム集計 + Analytics API拡張」として計画的に実装された
// もの(PHASE_ROADMAP.md の Phase55 節に明記)。書き込み経路(behavioral_events
// テーブルへのINSERT)は temperatureScoring / ProactiveEngine 等の内部ロジックで
// 現役消費されているが、この読み取り専用の管理者向け集計APIだけは対応する
// admin-ui画面が最後まで作られなかった可能性が高い。偶発的な残骸ではなく、
// 「UI側の実装が積み残しになった」パターンと判断。
//
// ★このAPIは本番で200を返し続けている。「コード内に呼び出しが無い」だけでは
// 削除の根拠にならない(テナント独自ツール・運用スクリプト・手動叩き等の
// 外部利用はコードだけでは否定できない。同種の事例: public/widget.min.js が
// #871 以降更新されないまま本番で200を返し続けている件, GID 1217972648400209)。
// 削除を検討する場合は本番アクセスログでの外部利用有無の確認が前提条件。
// (本タスクでは自分でVPSにSSHしないルールのため未確認 → 人間作業として要対応)

import type { Express, Request, Response } from 'express';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { pool } from '../../../lib/db';
import { logger } from '../../../lib/logger';
import { isAllowedAdminRole } from "../../middleware/roleAuth";
import { planHasFeature, queryTenantPlanOrThrow } from "../../../lib/billing/planFeatures";

// whitelist: SQL injection防止のため group_by は固定列名のみ許可
const ALLOWED_GROUP_BY = new Set(['event_type', 'page_url', 'visitor_id']);

// period → 日数のマッピング
const PERIOD_DAYS: Record<string, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

interface EventAnalyticsRow {
  group_key: string;
  date: string;
  count: string;
}

interface DayBucket {
  count: number;
}

interface GroupBuckets {
  [groupKey: string]: { [date: string]: DayBucket };
}

function formatEventAnalytics(
  rows: EventAnalyticsRow[],
  groupBy: string,
): object[] {
  const grouped: GroupBuckets = {};

  for (const row of rows) {
    const key = row.group_key ?? '(unknown)';
    if (!grouped[key]) grouped[key] = {};
    const date = row.date?.slice(0, 10) ?? '';
    grouped[key][date] = { count: Number(row.count) };
  }

  return Object.entries(grouped).map(([groupKey, days]) => ({
    [groupBy]: groupKey,
    daily: Object.entries(days)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, { count }]) => ({ date, count })),
    total: Object.values(days).reduce((sum, d) => sum + d.count, 0),
  }));
}


export function registerEventAnalyticsRoutes(app: Express): void {
  app.use('/v1/admin/analytics/events', supabaseAuthMiddleware);

  app.get(
    '/v1/admin/analytics/events',
    async (req: Request, res: Response) => {
      const su = (req as any).supabaseUser as Record<string, any> | undefined;
      const actorRole = su?.app_metadata?.role;
      if (!isAllowedAdminRole(actorRole)) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'invalid_role',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataRole: !!su?.app_metadata?.role,
          hasUserMetadataRole: !!su?.user_metadata?.role,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_ROLE_INVALID',
        }, "Admin analytics access denied: invalid actor role");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_ROLE_INVALID' });
      }
      // セキュリティ要件: テナントスコープも app_metadata.tenant_id のみを信頼する
      const rawTenantId = su?.app_metadata?.tenant_id;
      const jwtTenantId: string = typeof rawTenantId === "string" ? rawTenantId : "";
      const isSuperAdmin: boolean = actorRole === "super_admin";
      if (!isSuperAdmin && (!jwtTenantId || jwtTenantId.trim() === "")) {
        logger.warn({
          event: 'analytics_access_denied',
          reason: 'tenant_id_missing',
          actorEmail: su?.email ? String(su.email).slice(0, 3) + '***' : 'unknown',
          hasAppMetadataTenantId: !!su?.app_metadata?.tenant_id,
          hasUserMetadataTenantId: !!su?.user_metadata?.tenant_id,
          tokenIssuedAt: su?.iat,
          errorCode: 'AUTH_TENANT_INVALID',
        }, "Admin analytics access denied: tenant_id missing for non-super-admin");
        return res.status(403).json({ error: "この操作を実行する権限がありません", code: 'AUTH_TENANT_INVALID' });
      }

      const queryTenantId = (req.query['tenant_id'] as string | undefined) ?? '';
      const tenantId = isSuperAdmin ? (queryTenantId || null) : jwtTenantId;

      // client_admin が他テナントにアクセスしようとした場合
      if (!isSuperAdmin && queryTenantId && queryTenantId !== jwtTenantId) {
        return res.status(403).json({ error: '他テナントのデータは閲覧できません' });
      }

      const period = (req.query['period'] as string | undefined) ?? '7d';
      const days = PERIOD_DAYS[period] ?? 7;

      const groupByRaw = (req.query['group_by'] as string | undefined) ?? 'event_type';
      if (!ALLOWED_GROUP_BY.has(groupByRaw)) {
        return res.status(400).json({
          error: 'invalid_group_by',
          allowed: [...ALLOWED_GROUP_BY],
        });
      }
      // 安全: whitelist検証済みの列名のみ使用
      const groupByCol = groupByRaw;

      if (!pool) {
        return res.status(503).json({ error: 'database_unavailable' });
      }

      // GID 1217969364194602 [H-7]: 行動イベント分析(event_type/page_url/visitor_id別)は
      // 「基本の会話分析」(analytics)の一部。routes.ts の summary/trends/evaluations と
      // 同じくStandard〜で開放する(成果分析=conversionとは別ゲート。
      // src/lib/billing/planFeatures.ts 参照)。super_adminはバイパス。
      //
      // queryTenantPlanOrThrow を使う(queryTenantPlanではない): DB問い合わせ自体が
      // 例外を投げた場合にfree_adへ丸め込まれると、DB障害が「plan_upgrade_required」
      // (403)に化けてしまい、実際に起きているDB障害を隠してしまうため。
      if (!isSuperAdmin) {
        let plan: string;
        try {
          plan = await queryTenantPlanOrThrow(pool, jwtTenantId);
        } catch (err) {
          logger.warn({ err }, '[GET /v1/admin/analytics/events] plan lookup failed');
          return res.status(500).json({ error: 'internal_error' });
        }
        if (!planHasFeature(plan, "analytics")) {
          return res.status(403).json({
            error: "plan_upgrade_required",
            message: "会話分析はStandardプラン以上でご利用いただけます",
          });
        }
      }

      try {
        const params: unknown[] = [days];
        const tenantClause = tenantId ? `AND tenant_id = $${params.push(tenantId)}` : '';

        const result = await pool.query<EventAnalyticsRow>(
          `SELECT ${groupByCol} AS group_key,
                  DATE(created_at)::TEXT AS date,
                  COUNT(*)::TEXT AS count
           FROM behavioral_events
           WHERE created_at >= NOW() - INTERVAL '1 day' * $1
             ${tenantClause}
           GROUP BY ${groupByCol}, DATE(created_at)
           ORDER BY date DESC, count DESC`,
          params,
        );

        return res.json({
          period,
          group_by: groupByCol,
          tenant_id: tenantId,
          events: formatEventAnalytics(result.rows, groupByCol),
        });
      } catch (err) {
        return res.status(500).json({ error: 'internal_error' });
      }
    },
  );
}
