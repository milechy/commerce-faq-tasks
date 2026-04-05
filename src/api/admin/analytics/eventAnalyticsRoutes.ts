// src/api/admin/analytics/eventAnalyticsRoutes.ts
// Phase55: 行動イベント分析API
//
// GET /v1/admin/analytics/events
//   認可: super_admin → 全テナント / client_admin → 自テナントのみ
//   クエリ: ?tenant_id=xxx&period=7d&group_by=event_type

import type { Express, Request, Response } from 'express';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { pool } from '../../../lib/db';

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
      const jwtTenantId: string =
        su?.app_metadata?.tenant_id ?? su?.user_metadata?.tenant_id ?? su?.tenant_id ?? '';
      const isSuperAdmin: boolean =
        (su?.app_metadata?.role ?? su?.user_metadata?.role ?? '') === 'super_admin';

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
