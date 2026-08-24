// src/lib/hermesConsent.ts
//
// ファイル名(hermesConsent)と中身のズレに関する注記:
// このファイルは元々「Hermes Agentへの生データ公開同意(1フラグ)」だけを扱っていたが、
// 共有学習プールの参加モデル S2 で「自社内学習(learn)」と「共有プール参加(share)」の
// 2軸に拡張した。学習(learning)全般を扱うファイルになっており、hermesConsent という
// ファイル名は実態とややズレている。将来のリネーム候補として残すが、このタスクでは
// リネームしない(呼び出し元を広く変更するスコープ外の作業になるため)。
//
// Phase75由来のfail-safe設計を踏襲する: DB障害・データ破損時は必ず安全側(=共有プール
// には出さない)に倒す。
//
// ■ 2軸の定義
// - learn : 自社内学習。自テナントの会話から自テナント用に学習する。データは外に出ない。
// - share : 共有プール参加。R2C共有プールに「出し、かつ読む」。外部Hermes VPSへ出る。
//
// ■ 既定値(向きが逆になる点に注意)
// - learn 未設定 → true  (外に出ないため、既定で有効にしてよい)
// - share 未設定 → false (外に出るため、fail-safeで既定は無効)
//
// ■ 禁止の組み合わせ
// - learn=false かつ share=true (自社が学ばないのに他社へ出すのは不整合。zodスキーマ側
//   でも拒否する。src/api/admin/tenants/routes.ts 参照)

import { getPool } from "./db";
import { logger } from "./logger";

export interface LearningConsent {
  learn: boolean;
  share: boolean;
}

// DB障害・パース失敗時の既定値。learnは「外に出ない」ため安全側でtrue、
// shareは「外に出る」ため安全側でfalse。
const FAILSAFE_CONSENT: LearningConsent = { learn: true, share: false };

interface TenantFeaturesRow {
  learning?: unknown;
  hermes_raw_data_consent?: boolean;
}

function isValidLearningShape(value: unknown): value is LearningConsent {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).learn === "boolean" &&
    typeof (value as Record<string, unknown>).share === "boolean"
  );
}

/**
 * 既に取得済みの features オブジェクトから同期的に解決する純関数。
 * resolveLearningConsent() と同じ優先順位(新形式優先→旧フラグ→fail-safe)だが、
 * 呼び出し元が既に tenants 行を持っている場合(例: /api/widget/features のように
 * 高頻度に呼ばれ、余分なDBラウンドトリップを避けたい経路)向けに、DBアクセスを
 * 行わない形で切り出す。ロジック本体はここに集約し、resolveLearningConsent() は
 * このラッパーとして実装する(優先順位のドリフトを防ぐため実装を2箇所に持たない)。
 */
export function resolveLearningConsentFromFeatures(
  features: TenantFeaturesRow | null | undefined,
  context?: { tenantId?: string },
): LearningConsent {
  const learning = features?.learning;

  if (learning === undefined) {
    // 新形式が未設定 → 後方互換で旧フラグから解決する。
    return {
      learn: true,
      share: features?.hermes_raw_data_consent === true,
    };
  }

  if (isValidLearningShape(learning)) {
    return { learn: learning.learn, share: learning.share };
  }

  // features.learning が存在するが壊れた形(文字列/配列/null/不完全なオブジェクト等)。
  // 黙って後方互換にフォールバックすると壊れたデータに気付けないため、fail-safeへ倒しつつ
  // warnログを残す。
  logger.warn("[resolveLearningConsent] features.learning が不正な形式です。fail-safeへ倒します。", {
    tenantId: context?.tenantId,
    learning,
  });
  return { ...FAILSAFE_CONSENT };
}

/**
 * テナントの学習同意(2軸: learn / share)を解決する。
 *
 * features.learning が新形式({learn, share})で設定されていればそれを使う。
 * 未設定の場合は旧フラグ features.hermes_raw_data_consent から後方互換で解決する
 * (learn=true固定、share=旧フラグの値)。
 *
 * features.learning が壊れた形(文字列・配列・null・learn/shareの型不正等)の場合は
 * fail-safeとして {learn:true, share:false} に倒し、原因調査のためwarnログを残す。
 * DB障害時も同様にfail-safeへ倒す。
 */
export async function resolveLearningConsent(tenantId: string): Promise<LearningConsent> {
  const pool = getPool();
  try {
    const result = await pool.query<{ features: TenantFeaturesRow | null }>(
      `SELECT features FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return resolveLearningConsentFromFeatures(result.rows[0]?.features, { tenantId });
  } catch (err) {
    // DB障害時は fail-safe で {learn:true, share:false} 扱い(データ露出よりも可用性低下を優先)
    logger.warn("[resolveLearningConsent] DB障害のためfail-safeへ倒します。", { tenantId, err });
    return { ...FAILSAFE_CONSENT };
  }
}

export async function isHermesDataConsentGranted(tenantId: string): Promise<boolean> {
  return (await resolveLearningConsent(tenantId)).share;
}

/**
 * 共有プール参加(share)に同意済みのテナントIDを全件取得する。
 * MCPサーバーが公開してよいテナント一覧を返す用途。
 *
 * features.learning(新形式)・features.hermes_raw_data_consent(旧形式)の
 * 両方を拾う。片方だけ拾うと export 対象が黙って欠けるため、
 * resolveLearningConsent と同じ優先順位(新形式があればそちらを優先、
 * 新形式が壊れた形の場合は対象外)をSQLでも再現する。
 */
export async function listHermesConsentingTenantIds(): Promise<string[]> {
  const pool = getPool();
  try {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM tenants
       WHERE (features->'learning'->>'share') = 'true'
          OR (
               (features->'learning') IS NULL
               AND (features->>'hermes_raw_data_consent') = 'true'
             )`,
    );
    return result.rows.map((r) => r.id);
  } catch {
    return [];
  }
}
