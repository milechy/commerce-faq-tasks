// src/lib/billing/changeTenantPlan.ts
//
// CP-3(GID 1218086647623729): PUT /v1/admin/my-tenant/plan
// (src/api/admin/tenants/routes.ts)と change_my_plan ツール
// (src/api/admin/agent/actionExecutor.ts)の両方が同じプラン変更処理を通るように
// 切り出した共通関数。元実装は routes.ts の PUT ハンドラ本体(#933等)。
//
// ★このファイルにある手順を呼び出し元に書き写さないこと★
// BEGIN → SET LOCAL lock_timeout → SELECT...FOR UPDATE → no-op判定 →
// features降格計算 → UPDATE → COMMIT → キャッシュ無効化 → 監査INSERT
// (トランザクション外・fire-and-forget) → Stripe同期(await) という手順を
// 2箇所に持つと、片方だけ直る事故になる(実際に一度、テナント自己申告経路が
// features降格計算を持たないまま追加された)。
//
// 認可(tenantAuth/requireAdminRole)・Zodパース・free_ad/enterprise の
// 拒否(blockFreeAdTransition/blockEnterpriseSelfUpgrade、routes.ts)は
// この関数の外(呼び出し元)の責務のまま据え置く。呼び出し元によって
// 許可範囲が違いうる(super_adminのPATCHはenterpriseへの変更を許す)ため。

import type { Pool, PoolClient } from 'pg';
import { planHasFeature, invalidateTenantPlanCache, type TenantPlan } from './planFeatures';
import { invalidateBillingPlanCache } from './usageTracker';
import { syncSubscriptionForTenant, needsBillingAttention, type SubscriptionSyncResult } from './subscriptionSync';

// PUT /v1/admin/my-tenant/plan(tenants/routes.ts)は lib/logger.ts のAppLoggerラッパーを
// 渡す。生pino.Loggerを要求すると型が合わないため、subscriptionSync.ts の
// MinimalLogger と同じ最小形の構造的型にする(pino.Logger/AppLoggerのどちらも満たす)。
interface MinimalLogger {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

// tenants.features のフラグと、それを許可する最小プラン(planFeatures の GatedFeature)の対応。
// プラン降格時にどのフラグを落とすかの唯一の出どころ。
// (元 src/api/admin/tenants/routes.ts から移設。routes.ts の PATCH /v1/admin/tenants/:id も
//  この関数を re-import して使うため、ここが両経路にとって唯一の定義になる。)
// 新しいプラン依存フラグを features に足すときは、ここにも足すこと
// (足し忘れると、降格しても権能が残り原価だけ当社負担になる)。
const FEATURE_FLAG_GATES: ReadonlyArray<[string, "avatar" | "deep_research" | "pre_dispatch"]> = [
  ["avatar", "avatar"],
  // voice は PATCH /my-tenant の既存ゲートと揃えて avatar と同じ段(growth)で判定する。
  ["voice", "avatar"],
  ["deep_research", "deep_research"],
  ["pre_dispatch", "pre_dispatch"],
];

/**
 * プラン降格時に落とすべき features フラグを計算する。
 *
 * ★この関数を経由しない plan 更新経路を作らないこと★
 * アバターのランタイム認可は plan ではなく features.avatar だけを見ている
 * (anamRoutes.ts / livekitTokenRoutes.ts / api/widget/routes.ts)。plan だけ下げると
 * 最も原価の重い Anam/LiveKit が動いたまま倍率だけ下がる。
 *
 * 落とすだけで、昇格時に勝手に有効化はしない(権能の自動付与をしない)。
 */
export function computeFeatureRevocationOnDowngrade(
  beforeFeatures: Record<string, unknown> | null | undefined,
  nextPlan: string
): Record<string, false> {
  const features = beforeFeatures ?? {};
  const revoked: Record<string, false> = {};
  for (const [flag, gate] of FEATURE_FLAG_GATES) {
    if (features[flag] === true && !planHasFeature(nextPlan, gate)) {
      revoked[flag] = false;
    }
  }
  return revoked;
}

export type ChangeTenantPlanResult =
  | {
      kind: 'no_change';
      status: 200;
      body: { plan: TenantPlan; previous_plan: TenantPlan | null; changed: false };
    }
  | {
      kind: 'changed';
      status: 200;
      body: {
        id: string;
        name: string;
        plan: TenantPlan;
        features: Record<string, unknown> | null;
        previous_plan: TenantPlan | null;
        changed: true;
        billing_sync: SubscriptionSyncResult['status'];
        billing_sync_needs_attention: boolean;
      };
    }
  | {
      kind: 'error';
      status: 404 | 403 | 409 | 500;
      body: { error: string; message?: string };
    };

/**
 * テナントのプランを変更する(自己申告 / super_admin 代行の両方から呼べる)。
 *
 * ★呼び出し前提★ nextPlan が free_ad/enterprise の場合にそれを許すかどうかは
 * 呼び出し元が既に判断済みであること(このファイルは判定しない)。
 *
 * @param changedBy tenant_settings_history.changed_by に残す実行者(email)。
 */
export async function changeTenantPlan(
  db: Pool,
  logger: MinimalLogger,
  tenantId: string,
  nextPlan: TenantPlan,
  changedBy: string
): Promise<ChangeTenantPlanResult> {
  // ★SELECT→計算→UPDATEをトランザクション化する★
  // 同一テナントへの並行プラン変更(連打・複数タブ・チャットと旧UIの同時操作)で、
  // 両リクエストが同じ beforeFeatures を読んで別々のUPDATEを投げると、
  // tenant_settings_history には両方の遷移が記録されるのにDBの最終状態は
  // 後勝ちの1本だけ、という監査ログとDB遷移の不整合が起きる。
  // SELECT ... FOR UPDATE でテナント行をロックし、2件目のリクエストは
  // 1件目のCOMMITを待ってから自分の previousPlan を読むようにする
  // (結果、2件目が同一プランへの変更なら no-op分岐で安全に吸収される)。
  const client: PoolClient = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '3s'");

    const beforeResult = await client.query<{ plan: TenantPlan | null; features: Record<string, unknown> | null; is_active: boolean | null }>(
      `SELECT plan, features, is_active FROM tenants WHERE id = $1 FOR UPDATE`,
      [tenantId]
    );
    if (beforeResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { kind: 'error', status: 404, body: { error: 'not_found', message: 'テナントが見つかりません' } };
    }
    const previousPlan = beforeResult.rows[0].plan;

    // 停止中のテナントにプラン変更を許さない。★null は停止扱いにしない★
    // 列が無い/未設定の環境で全テナントのプラン変更が止まる方が損害が大きいため、
    // 明示的な false のときだけ弾く。
    if (beforeResult.rows[0].is_active === false) {
      await client.query('ROLLBACK');
      return {
        kind: 'error',
        status: 403,
        body: {
          error: 'tenant_inactive',
          message: '停止中のテナントではプランを変更できません。担当までお問い合わせください',
        },
      };
    }

    // 同一プランへの変更は no-op（連打・再送を成功として返す。監査行も増やさない）。
    if (previousPlan === nextPlan) {
      await client.query('ROLLBACK'); // 書き込みは無いのでCOMMITと等価。ロック解放のみ。
      return { kind: 'no_change', status: 200, body: { plan: nextPlan, previous_plan: previousPlan, changed: false } };
    }

    // ★降格時は新プランで許されない features を落とす★
    const revoked = computeFeatureRevocationOnDowngrade(beforeResult.rows[0].features, nextPlan);
    const hasRevocation = Object.keys(revoked).length > 0;

    const result = hasRevocation
      ? await client.query(
          `UPDATE tenants
             SET plan = $1,
                 features = COALESCE(features, '{}'::jsonb) || $3::jsonb,
                 updated_at = NOW()
           WHERE id = $2
           RETURNING id, name, plan, features`,
          [nextPlan, tenantId, JSON.stringify(revoked)]
        )
      : await client.query(
          `UPDATE tenants SET plan = $1, updated_at = NOW() WHERE id = $2
           RETURNING id, name, plan, features`,
          [nextPlan, tenantId]
        );
    // SELECT ... FOR UPDATE で対象行のロックをCOMMITまで保持し続けているため、
    // 同一トランザクション内のこのUPDATEが0行になることはない。

    await client.query('COMMIT');

    // プラン判定のキャッシュは2系統ある（機能ゲート用・請求焼き付け用）。両方消す。
    invalidateTenantPlanCache(tenantId);
    invalidateBillingPlanCache(tenantId);

    // 監査記録。super_admin の PATCH /v1/admin/tenants/:id と同じテーブル・同じ形式で
    // 残す（fire-and-forget）。★意図的にトランザクションの外・元のプール経由
    // (client ではなく db)で行う★ プラン変更は既にCOMMIT済みなので、監査は
    // その事実を後から記録するだけの副次的な処理として切り離す。
    void db.query(
      `INSERT INTO tenant_settings_history (tenant_id, changed_by, field_name, old_value, new_value)
       VALUES ($1, $2, 'plan', $3::jsonb, $4::jsonb)`,
      [tenantId, changedBy, JSON.stringify(previousPlan), JSON.stringify(nextPlan)]
    ).catch((e: unknown) => logger.warn('[tenant_settings_history] insert failed', e));

    logger.info(
      { tenantId, previousPlan, nextPlan, changedBy },
      '[changeTenantPlan] tenant plan changed'
    );

    // ★Stripe の item 構成をプランに追随させる★ ★await する(fire-and-forget にしない)★
    // 失敗を握り潰すと「変更しました」とだけ表示され、請求が動いていないことを
    // 誰も知らないまま月が終わる。プラン自体は COMMIT 済みなので、同期の失敗で
    // 500 にはせず、billing_sync として呼び出し元に返し、UI/チャットに出させる。
    const billingSync = await syncSubscriptionForTenant(db, logger, tenantId, nextPlan);
    if (needsBillingAttention(billingSync)) {
      logger.warn(
        { tenantId, nextPlan, billingSyncStatus: billingSync.status },
        '[changeTenantPlan] プランは変更したが請求構成が追随していない'
      );
    }

    return {
      kind: 'changed',
      status: 200,
      body: {
        id: result.rows[0].id,
        name: result.rows[0].name,
        plan: result.rows[0].plan,
        features: result.rows[0].features,
        previous_plan: previousPlan,
        changed: true,
        billing_sync: billingSync.status,
        billing_sync_needs_attention: needsBillingAttention(billingSync),
      },
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // ロックタイムアウト = 同一テナントへの別のプラン変更が進行中。
    if (err instanceof Error && /lock timeout|canceling statement/i.test(err.message)) {
      return {
        kind: 'error',
        status: 409,
        body: { error: 'conflict', message: '他のプラン変更処理と競合しました。少し待ってからもう一度お試しください' },
      };
    }
    logger.warn('[changeTenantPlan]', err);
    return { kind: 'error', status: 500, body: { error: '更新に失敗しました' } };
  } finally {
    client.release();
  }
}
