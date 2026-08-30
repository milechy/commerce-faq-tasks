// src/api/admin/analytics/ignitionStatus.ts
// 学習・会話系機能の「点火状態」をテナント×機能で可視化する。
//
// なぜ必要か (2026-08-24 の実例):
//   本番の .env には LEARNED_MEMORY_ENABLED=true / LEARNED_MEMORY_TENANTS=carnation が
//   入っており、読込みは未設定時の既定 true。つまり読み書きとも有効だった。
//   それでも learned_memory は 0 件で、原因はフラグではなく上流(Judge が評価しない)だった。
//   **この切り分けに VPS への SSH が必要だったこと自体が問題**(CLAUDE.md 禁止41)。
//
// なぜ独立したファイルか:
//   入力が env と DB の2系統で、出力は表示専用。measurementHealth の集計クエリ群とは形が違う。
//   目的は「分散しているフラグ解釈を1箇所に集めること」で、
//   featureFlag.ts / judgeSweepRunner.ts の判定は **import して使う。再実装しない**
//   (2箇所目を作ると解釈が割れる)。
//
// 画面はR2C運用者(super_admin)専用。したがって label/reason は平易な日本語にしつつ、
// 「どこを変えれば切り替わるか」は configKey で明示する(運用者にはこれが必要な情報)。

import type { Pool } from "pg";
import { logger } from "../../../lib/logger";
import {
  isLearnedMemoryWriteEnabled,
  isLearnedMemoryReadEnabled,
  getLearnedMemoryThreshold,
} from "../../../agent/memory/featureFlag";
import { resolveSweepTenants } from "../../../agent/judge/judgeSweepRunner";
import { DEFAULT_MIN_MESSAGE_COUNT } from "../../../agent/judge/sweepCandidates";
import { userSourceClause, userSourceExistsForTable } from "./summaryQueries";
import { resolveLearningConsentFromFeatures } from "../../../lib/hermesConsent";

type Db = Pick<Pool, "query">;

/** 点火状態を判定する対象テナント1件分の入力。 */
export interface TenantIgnitionInput {
  id: string;
  features: Record<string, unknown> | null;
}

export interface IgnitionCell {
  feature: string;
  /** 画面表示用。内部語(env名・列名)をここに出さない。 */
  label: string;
  enabled: boolean;
  /** 有効/無効の根拠を1文で。 */
  reason: string;
  /** どこを変えると切り替わるか。運用者向けなので内部名でよい。 */
  configKey: string;
  /** env で決まるものは画面から開閉できない(禁止41)。 */
  controlledBy: "env" | "tenants.features";
}

export interface IgnitionRow {
  tenantId: string;
  cells: IgnitionCell[];
}

export interface IgnitionStatusResponse {
  rows: IgnitionRow[];
  /** env だけで決まる機能(画面から開閉できない=禁止41 の是正対象)。 */
  envControlledFeatures: string[];
  /** 1つでも有効な機能があるか。全て false なら「有効な機能はありません」を描く。 */
  anyEnabled: boolean;
  /**
   * ナレッジ配線是正P15: 交差(judge_x_memory_intersection)が有効なテナントでも、
   * learned_memory に届くまでには直列の4ゲートがある(score>=閾値、
   * message_count>=最低件数、messages.length>=最低発話数、CV/outcomeを伴う)。
   * DBアクセスが要るため buildIgnitionStatus(純関数)には含めず、
   * fetchIgnitionStatus 経由でのみ埋まる(buildIgnitionStatus単体呼び出しでは省略可)。
   */
  seriesGates?: SeriesGateInfo[];
}

export interface SeriesGateInfo {
  gate: string;
  /** 画面表示用。内部語(env名・列名)をここに出さない。 */
  label: string;
  /** この条件を満たす件数。禁止34: 母数が小さくても率ではなく生の件数で出す。 */
  currentCount: number;
  /** 母集団件数(このゲートが対象とする候補の総数)。 */
  ofTotal: number;
  /** どこで判定しているか。運用者向けなので内部名でよい。 */
  configKey: string;
}

/** テスト差し替え用。既定は実装の唯一の情報源をそのまま使う。 */
export interface SeriesGateDeps {
  learnedMemoryThreshold: () => number;
  hasConvertingOutcome: (tenantId: string, sessionId: string) => Promise<boolean>;
}

/** 直近この期間のセッション/評価だけを対象にする(measurementHealth.ts の既定期間と揃える)。 */
const SERIES_GATE_LOOKBACK = "30 days";
/** hasConvertingOutcome はセッション毎にDB問い合わせが要るため、対象を上限で区切る。 */
const CONVERTING_OUTCOME_SAMPLE_LIMIT = 100;

/** テスト差し替え用。既定は実装の唯一の情報源をそのまま使う。 */
export interface IgnitionDeps {
  learnedMemoryWrite: (tenantId: string) => boolean;
  learnedMemoryRead: (tenantId: string) => boolean;
  sweepTenants: () => string[];
}

const DEFAULT_DEPS: IgnitionDeps = {
  learnedMemoryWrite: isLearnedMemoryWriteEnabled,
  learnedMemoryRead: isLearnedMemoryReadEnabled,
  sweepTenants: resolveSweepTenants,
};

function featureFlagOn(features: Record<string, unknown> | null, key: string): boolean {
  // dialogAgent.ts は features->>'key' === "true" で判定する(JSONBのbooleanが "true" になる)。
  // JSON として読む本経路でも、boolean true と文字列 "true" の両方を有効として扱い挙動を揃える。
  const v = features?.[key];
  return v === true || v === "true";
}

/**
 * テナント一覧から点火行列を組む純関数。DB アクセスは呼び出し側が行う。
 */
export function buildIgnitionStatus(
  tenants: TenantIgnitionInput[],
  deps: IgnitionDeps = DEFAULT_DEPS,
): IgnitionStatusResponse {
  const sweep = deps.sweepTenants();

  const rows: IgnitionRow[] = tenants.map((t) => {
    const inSweep = sweep.includes(t.id) || sweep.includes("*");
    const write = deps.learnedMemoryWrite(t.id);
    const read = deps.learnedMemoryRead(t.id);
    const stage = featureFlagOn(t.features, "sales_stage_continuity");
    // ignitionStatus2: 旧フラグ直読みは resolveLearningConsentFromFeatures(share)と判定が
    // 割れる(このファイルの誤りが判明した実例)。同意判定のロジックはここに書かず、
    // hermesConsent.ts の唯一の実装をそのまま使う。
    const consent = resolveLearningConsentFromFeatures(t.features, { tenantId: t.id }).share;
    // reason 表示専用の分岐(判定根拠の説明であり、同意可否そのものの判定には使わない。
    // 可否の判定は上の consent 一本で、ここでは既に出た結果を平易な日本語にするだけ)。
    const usesNewLearningFormat = t.features?.["learning"] !== undefined;
    // ナレッジ配線是正P15: judge_sweep と learned_memory_write は独立したセルとして
    // 両方 ON でも、対象テナントの集合(JUDGE_SWEEP_TENANTS ∩ LEARNED_MEMORY_TENANTS)が
    // 交差していなければ実際には1件も学習データが生まれない(2026-08-25の実例:
    // sweep={r2c_default}, memory={carnation} で交差ゼロ)。この交差を1セルとして出す。
    const intersects = inSweep && write;

    const cells: IgnitionCell[] = [
      {
        feature: "judge_sweep",
        label: "会話の自動評価（定期）",
        enabled: inSweep,
        reason: inSweep
          ? "定期評価の対象になっています"
          : "定期評価の対象外です。対象に入れないと評価が生まれず、後続の学習も起動しません",
        configKey: "JUDGE_SWEEP_TENANTS",
        controlledBy: "env",
      },
      {
        feature: "learned_memory_write",
        label: "会話から覚える（記録）",
        enabled: write,
        reason: write
          ? "高評価の会話を記録します。ただし記録は自動評価が動いていることが前提です"
          : "記録しません",
        configKey: "LEARNED_MEMORY_ENABLED / LEARNED_MEMORY_TENANTS",
        controlledBy: "env",
      },
      {
        feature: "learned_memory_read",
        label: "覚えたことを回答に使う",
        enabled: read,
        reason: read
          ? "回答時に参照します（読込みは未設定なら有効が既定）"
          : "参照しません",
        configKey: "LEARNED_MEMORY_READ_ENABLED",
        controlledBy: "env",
      },
      {
        feature: "sales_stage_continuity",
        label: "会話の流れを引き継ぐ",
        enabled: stage,
        reason: stage
          ? "前のやり取りを踏まえて会話が進みます"
          : "毎回ふりだしに戻ります。会話が1往復で終わる原因になります",
        configKey: "tenants.features.sales_stage_continuity",
        controlledBy: "tenants.features",
      },
      {
        feature: "hermes_raw_data_consent",
        label: "外部への学習データ提供の同意",
        enabled: consent,
        reason: consent
          ? usesNewLearningFormat
            ? "同意済みです（新形式 features.learning.share で判定）"
            : "同意済みです（旧フラグ hermes_raw_data_consent で判定。後方互換）"
          : usesNewLearningFormat
            ? "未同意です（新形式 features.learning.share で判定。提供しません）"
            : "未同意です（旧フラグまたは未設定で判定。提供しません）",
        configKey: "tenants.features.learning.share",
        controlledBy: "tenants.features",
      },
      {
        feature: "judge_x_memory_intersection",
        label: "評価される かつ 記録される（実際に学習データが増える条件）",
        enabled: intersects,
        reason: intersects
          ? "定期評価の対象、かつ記録対象のどちらにも入っているため、学習データが増え得ます"
          : inSweep && !write
            ? "定期評価はされますが、記録対象テナントに入っていないため学習データは増えません"
            : !inSweep && write
              ? "記録対象テナントですが、定期評価の対象に入っていないため評価自体が生まれず、記録も起きません"
              : "定期評価・記録のどちらの対象にも入っていません",
        configKey: "JUDGE_SWEEP_TENANTS ∩ LEARNED_MEMORY_TENANTS",
        controlledBy: "env",
      },
    ];

    return { tenantId: t.id, cells };
  });

  const envControlled = new Set<string>();
  for (const r of rows) {
    for (const c of r.cells) if (c.controlledBy === "env") envControlled.add(c.feature);
  }

  return {
    rows,
    envControlledFeatures: [...envControlled].sort(),
    anyEnabled: rows.some((r) => r.cells.some((c) => c.enabled)),
  };
}

/**
 * learned_memory に届くまでの直列4ゲートの到達件数を計算する。
 * 交差テナントが1件も無ければ(2026-08-25時点の本番の実値)DBに問い合わせず全て0を返す
 * (無駄なクエリを避ける。交差が空なら候補も必然的に0件のため)。
 *
 * ゲートごとの母集団は互いに独立(同一の絞り込み済み母集団を順番にふるうstrictな
 * ファネルではない): message_count/messages.lengthはchat_sessionsのスナップショット、
 * judgeScoreはconversation_evaluationsに記録済みの評価、hasConvertingOutcomeは
 * judgeScore通過分のサンプルに対する実判定。各ゲートの定義そのものを正確に示すことを
 * 優先する(第2の判定ロジックを作らない。既存のhasConvertingOutcome/
 * getLearnedMemoryThresholdをそのままimportして使う)。
 */
export async function computeSeriesGates(
  db: Db,
  intersectionTenantIds: string[],
  deps: SeriesGateDeps = {
    learnedMemoryThreshold: getLearnedMemoryThreshold,
    hasConvertingOutcome: async (tenantId: string, sessionId: string) => {
      const { hasConvertingOutcome } = await import("../../../agent/memory/memoryDistiller");
      return hasConvertingOutcome(tenantId, sessionId);
    },
  },
): Promise<SeriesGateInfo[]> {
  const threshold = deps.learnedMemoryThreshold();
  const { MIN_MESSAGES_FOR_DISTILL } = await import("../../../agent/memory/memoryDistiller");

  if (intersectionTenantIds.length === 0) {
    return [
      {
        gate: "message_count",
        label: `離脱評価の対象になる(メッセージ${DEFAULT_MIN_MESSAGE_COUNT}件以上)`,
        currentCount: 0,
        ofTotal: 0,
        configKey: "sweepCandidates.DEFAULT_MIN_MESSAGE_COUNT",
      },
      {
        gate: "judge_score",
        label: `Judgeスコアが${threshold}点以上`,
        currentCount: 0,
        ofTotal: 0,
        configKey: "LEARNED_MEMORY_THRESHOLD",
      },
      {
        gate: "messages_length",
        label: `蒸留時点で発話が${MIN_MESSAGES_FOR_DISTILL}件以上`,
        currentCount: 0,
        ofTotal: 0,
        configKey: "memoryDistiller.MIN_MESSAGES_FOR_DISTILL",
      },
      {
        gate: "converting_outcome",
        label: "CV・成約outcomeを伴う会話",
        currentCount: 0,
        ofTotal: 0,
        configKey: "memoryDistiller.hasConvertingOutcome",
      },
    ];
  }

  const sessionResult = await db.query<{ total: string; ge_msg: string; ge_len: string }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE cs.message_count >= $2) AS ge_msg,
       COUNT(*) FILTER (WHERE cs.message_count >= $3) AS ge_len
     FROM chat_sessions cs
     WHERE cs.tenant_id = ANY($1)
       AND cs.started_at >= NOW() - $4::interval
       AND cs.is_escalated = false
       ${userSourceClause("cs")}`,
    [intersectionTenantIds, DEFAULT_MIN_MESSAGE_COUNT, MIN_MESSAGES_FOR_DISTILL, SERIES_GATE_LOOKBACK],
  );
  const sessionRow = sessionResult.rows[0];
  const sessionTotal = parseInt(sessionRow?.total ?? "0", 10);
  const geMsg = parseInt(sessionRow?.ge_msg ?? "0", 10);
  const geLen = parseInt(sessionRow?.ge_len ?? "0", 10);

  const evalResult = await db.query<{ total: string; ge_score: string }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ce.score >= $2) AS ge_score
     FROM conversation_evaluations ce
     WHERE ce.tenant_id = ANY($1)
       AND ce.created_at >= NOW() - $3::interval
       ${userSourceExistsForTable("conversation_evaluations", "ce")}`,
    [intersectionTenantIds, threshold, SERIES_GATE_LOOKBACK],
  );
  const evalRow = evalResult.rows[0];
  const evalTotal = parseInt(evalRow?.total ?? "0", 10);
  const geScore = parseInt(evalRow?.ge_score ?? "0", 10);

  const candidatesResult = await db.query<{ tenant_id: string; session_id: string }>(
    `SELECT ce.tenant_id, ce.session_id
     FROM conversation_evaluations ce
     WHERE ce.tenant_id = ANY($1)
       AND ce.score >= $2
       AND ce.created_at >= NOW() - $3::interval
       ${userSourceExistsForTable("conversation_evaluations", "ce")}
     LIMIT $4`,
    [intersectionTenantIds, threshold, SERIES_GATE_LOOKBACK, CONVERTING_OUTCOME_SAMPLE_LIMIT],
  );
  // hasConvertingOutcome は1件ごとにDB問い合わせを伴う(内部でgetNonConvertingOutcomesも
  // 呼ぶ)。1件の例外(接続エラー等)で /measurement-health エンドポイント全体が
  // 500になるのを避けるため、失敗した行は分母からも除外する(母数を偽らない。禁止34)。
  let convertingCount = 0;
  let convertingEvaluated = 0;
  for (const row of candidatesResult.rows) {
    try {
      if (await deps.hasConvertingOutcome(row.tenant_id, row.session_id)) convertingCount++;
      convertingEvaluated++;
    } catch (err) {
      logger.warn(
        { err, tenantId: row.tenant_id, sessionId: row.session_id },
        "[ignitionStatus] hasConvertingOutcome failed for one candidate; excluding from gate",
      );
    }
  }
  const convertingOfTotal = convertingEvaluated;
  const capped = candidatesResult.rows.length === CONVERTING_OUTCOME_SAMPLE_LIMIT;

  return [
    {
      gate: "message_count",
      label: `離脱評価の対象になる(メッセージ${DEFAULT_MIN_MESSAGE_COUNT}件以上)`,
      currentCount: geMsg,
      ofTotal: sessionTotal,
      configKey: "sweepCandidates.DEFAULT_MIN_MESSAGE_COUNT",
    },
    {
      gate: "judge_score",
      label: `Judgeスコアが${threshold}点以上`,
      currentCount: geScore,
      ofTotal: evalTotal,
      configKey: "LEARNED_MEMORY_THRESHOLD",
    },
    {
      gate: "messages_length",
      label: `蒸留時点で発話が${MIN_MESSAGES_FOR_DISTILL}件以上`,
      currentCount: geLen,
      ofTotal: sessionTotal,
      configKey: "memoryDistiller.MIN_MESSAGES_FOR_DISTILL",
    },
    {
      gate: "converting_outcome",
      label: capped
        ? `CV・成約outcomeを伴う会話(直近${CONVERTING_OUTCOME_SAMPLE_LIMIT}件のサンプルのみ)`
        : "CV・成約outcomeを伴う会話",
      currentCount: convertingCount,
      ofTotal: convertingOfTotal,
      configKey: "memoryDistiller.hasConvertingOutcome",
    },
  ];
}

/** tenants を1回引いて点火行列を返す。 */
export async function fetchIgnitionStatus(db: Db): Promise<IgnitionStatusResponse> {
  const rows = await db.query<{ id: string; features: Record<string, unknown> | null }>(
    `SELECT id, features FROM tenants ORDER BY id`,
  );
  const status = buildIgnitionStatus(rows.rows);
  const intersectionTenantIds = status.rows
    .filter((r) => r.cells.find((c) => c.feature === "judge_x_memory_intersection")?.enabled)
    .map((r) => r.tenantId);
  const seriesGates = await computeSeriesGates(db, intersectionTenantIds);
  return { ...status, seriesGates };
}
