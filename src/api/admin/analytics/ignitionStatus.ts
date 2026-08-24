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
import {
  isLearnedMemoryWriteEnabled,
  isLearnedMemoryReadEnabled,
} from "../../../agent/memory/featureFlag";
import { resolveSweepTenants } from "../../../agent/judge/judgeSweepRunner";

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
}

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
    const consent = featureFlagOn(t.features, "hermes_raw_data_consent");

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
        reason: consent ? "同意済みです" : "未同意です（提供しません）",
        configKey: "tenants.features.hermes_raw_data_consent",
        controlledBy: "tenants.features",
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

/** tenants を1回引いて点火行列を返す。 */
export async function fetchIgnitionStatus(db: Db): Promise<IgnitionStatusResponse> {
  const rows = await db.query<{ id: string; features: Record<string, unknown> | null }>(
    `SELECT id, features FROM tenants ORDER BY id`,
  );
  return buildIgnitionStatus(rows.rows);
}
