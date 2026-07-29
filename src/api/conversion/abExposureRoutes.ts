// src/api/conversion/abExposureRoutes.ts
// GID 1216978855735482: アバター効果A/Bテスト基盤 — 露出記録エンドポイント
//
// widget側で決定したアバターA/B実験の割当(experiment_id + variant)を、実際の
// session_idと紐付けてab_resultsに記録する。 /api/events(Phase55の行動イベント)は
// features.event_tracking(Growth+)が有効なテナントでしか動かないため使えない
// （アバター実験はStarterでも参加しうるため、プラン非依存の専用経路が必要）。
//
// NOTE: このPRでは widget/routes.ts 側での実験割当ロジック(resolveAvatarAssignment)
// までを実装しており、このエンドポイントを実際に呼び出す public/widget.js 側の配線は
// 含めていない（本番稼働中の配信スクリプトへの変更は影響範囲が大きく、別途レビュー・
// E2E確認のうえで追随PRとして行うのが安全と判断した。PR本文に明記）。

import type { Express, Request, Response, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { recordAvatarExposure } from './avatarAbExperiment';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ExposureSchema = z.object({
  experiment_id: z.number().int().positive(),
  variant: z.enum(['a', 'b']),
  session_id: z.string().regex(UUID_PATTERN, 'session_id must be a UUID'),
});

export function registerAbExposureRoutes(
  app: Express,
  apiStack: RequestHandler[],
  db: Pool | null,
): void {
  app.post('/v1/ab/avatar-exposure', ...apiStack, async (req: Request, res: Response) => {
    const tenantId: string = (req as any).tenantId ?? '';
    if (!tenantId) {
      return res.status(401).json({ error: 'tenant_not_found' });
    }
    if (!db) {
      return res.status(503).json({ error: 'database_unavailable' });
    }

    const parsed = ExposureSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_request',
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }
    const { experiment_id, variant, session_id } = parsed.data;

    try {
      // クロステナント汚染防止: experiment_id が本当にこのテナントの running 実験かを確認する
      const check = await db.query(
        `SELECT 1 FROM ab_experiments WHERE id = $1 AND tenant_id = $2 AND status = 'running'`,
        [experiment_id, tenantId],
      );
      if (check.rowCount === 0) {
        return res.status(404).json({ error: 'experiment_not_found' });
      }

      await recordAvatarExposure(db, experiment_id, variant, session_id);
      return res.status(202).json({ accepted: true });
    } catch {
      return res.status(500).json({ error: 'internal_error' });
    }
  });
}
