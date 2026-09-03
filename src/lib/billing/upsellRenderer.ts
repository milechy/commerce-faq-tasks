/**
 * upsellRenderer.ts — アップセル提案の文面を決定的コードで組み立てる。
 *
 * ■ LLM を1度も通さない
 * 文面はテンプレート文字列とシグナル別の定型句だけで作る。
 * Hermes が返すのは「提案の型(signal)とプラン名」だけで、金額は一切受け取らない
 * (src/api/admin/CLAUDE.md「金額・件数を LLM の生成文に通さない」)。
 *
 * ■ 金額を保存しない
 * 保存すると価格改定で保存済みの金額が嘘になる。tuning_rules.evidence には
 * シグナルと数量しか入れず、表示のたびにここが単価から組み立て直す。
 *
 * ■ 宛先を型で分ける（★extends しない★）
 * TenantUpsellFigures と SuperAdminUpsellFigures は継承関係を持たない。
 * 親を作って継承させると、親に足したフィールドが自動でテナント側へ流れ込む。
 * さらに __audience という判別子を持たせているため、構造的部分型で
 * SuperAdminUpsellFigures をテナント向け関数へ渡すこともできない
 * (TypeScript は構造的型付けなので、判別子が無いと上位集合が素通りする)。
 *
 * ■ 実行時にも列挙で守る
 * renderUpsellForTenant は figures を展開せず、必要なフィールドだけを読む。
 * 万一キャストで原価入りのオブジェクトが渡されても、出力文字列には現れない。
 */
import type { UpsellSignal } from './upsellSignals';

/** テナントに見せてよい数字だけを持つ。★cost/margin/profit を1つも足さないこと★ */
export interface TenantUpsellFigures {
  /** 宛先の判別子。これがあるおかげで super_admin 用の型を誤って渡せない。 */
  readonly __audience: 'tenant';
  signal: UpsellSignal;
  current_plan: string;
  recommended_plan: string;
  /** 現行プランの月額基本料(円)。算出不可は null。★0 にしない★ */
  current_base_monthly_jpy: number | null;
  recommended_base_monthly_jpy: number | null;
  /** 込み枠。プランに込み枠の概念が無ければ null(0 ではない)。 */
  text_included_now: number | null;
  text_included_after: number | null;
  avatar_included_minutes_now: number | null;
  avatar_included_minutes_after: number | null;
  /** 当月の超過。 */
  text_overage: number;
  avatar_overage_minutes: number;
  /** 集計時点(ISO)。いつの数字かを必ず添える。 */
  as_of: string;
}

/** 運営向け。粗利を含む。★この型をテナント向け関数に渡せないことを型で保証する★ */
export interface SuperAdminUpsellFigures {
  readonly __audience: 'super_admin';
  signal: UpsellSignal;
  tenant_id: string;
  tenant_name: string | null;
  current_plan: string;
  recommended_plan: string;
  current_base_monthly_jpy: number | null;
  recommended_base_monthly_jpy: number | null;
  text_overage: number;
  avatar_overage_minutes: number;
  /** 以下は運営専用。テナント向けの型には存在しない。 */
  revenue_estimate_jpy: number | null;
  cost_base_jpy: number | null;
  gross_profit_jpy: number | null;
  gross_margin_pct: number | null;
  as_of: string;
}

export interface RenderedUpsell {
  headline: string;
  lines: string[];
}

/**
 * 金額の整形。算出不可は「—」にして 0 円と区別する(禁止20)。
 *
 * `== null` で undefined も拾うのは意図的。この関数は保存済み evidence 由来の
 * 値も扱うため、フィールドが欠けた壊れたデータで例外を投げると通知経路ごと
 * 落ちる(承認は成功したのにテナントに何も届かない)。欠落は「—」に倒す。
 */
function jpy(v: number | null | undefined): string {
  return v == null ? '—' : `¥${v.toLocaleString('ja-JP')}`;
}

/** 数量の整形。undefined も「—」に倒す(理由は jpy と同じ)。 */
function num(v: number | null | undefined): string {
  return v == null ? '—' : v.toLocaleString('ja-JP');
}

/** プラン名の表示形。内部IDをそのまま画面に出さない。 */
const PLAN_LABELS: Record<string, string> = {
  free_ad: 'Free（広告表示）',
  starter: 'Starter',
  standard: 'Standard',
  growth: 'Growth',
  enterprise: 'Enterprise',
};
function planLabel(plan: string): string {
  return PLAN_LABELS[plan] ?? plan;
}

/** シグナル別の「なぜ今これを出しているか」。テナント向けは事実だけを述べる。 */
const TENANT_REASON: Record<UpsellSignal, string> = {
  text_overage: '今月のご利用が、プランに含まれる会話数を超えています。',
  avatar_overage: '今月のアバター利用が、プランに含まれる時間を超えています。',
  text_near_limit: '今月のご利用が、プランに含まれる会話数の8割に達しました。',
  starter_cap_reached: '今月のご利用が Starter の想定上限に達しました。',
  free_ad_limit_reached: '無料プランの月間上限に達しました。',
  enterprise_nudge: 'ご利用規模が大きくなっています。個別のご契約をご相談いただけます。',
};

/**
 * テナント向けの文面。
 *
 * ★原価・マージン・粗利を一切出さない★
 * 現行プランの金額と推奨プランの金額だけを出す。
 * 「推奨プランでの原価」も出さない — 現行の原価と並べると倍率が割れるため。
 */
export function renderUpsellForTenant(f: TenantUpsellFigures): RenderedUpsell {
  const lines: string[] = [];
  lines.push(TENANT_REASON[f.signal]);

  if (f.text_overage > 0) {
    lines.push(`超過分の会話: ${num(f.text_overage)} 件`);
  }
  if (f.avatar_overage_minutes > 0) {
    lines.push(`超過分のアバター利用: ${num(f.avatar_overage_minutes)} 分`);
  }

  if (f.recommended_plan === 'enterprise') {
    // enterprise は個別契約で自動見積りできない(computeBillingEstimateJpy が null)。
    // 金額を出さずに相談へ寄せる。推測した金額を出さない方が誠実。
    lines.push(`${planLabel(f.current_plan)} から ${planLabel(f.recommended_plan)} へのご変更をご検討いただけます。`);
    lines.push('料金は利用状況に応じた個別のご案内となります。');
  } else {
    lines.push(
      `${planLabel(f.current_plan)}（月額 ${jpy(f.current_base_monthly_jpy)}）から ` +
      `${planLabel(f.recommended_plan)}（月額 ${jpy(f.recommended_base_monthly_jpy)}）へのご変更をご検討いただけます。`,
    );
    // == null で undefined も除外する。欠落した値で「— 件 → — 件」という
    // 情報量ゼロの行を出さない。
    if (f.text_included_after != null) {
      lines.push(
        `含まれる会話数: ${num(f.text_included_now)} 件 → ${num(f.text_included_after)} 件`,
      );
    }
    if (f.avatar_included_minutes_after != null) {
      lines.push(
        `含まれるアバター利用: ${num(f.avatar_included_minutes_now)} 分 → ${num(f.avatar_included_minutes_after)} 分`,
      );
    }
  }

  lines.push(`（${f.as_of} 時点の集計）`);

  return { headline: 'プランのご提案', lines };
}

/**
 * 運営(super_admin)向けの文面。粗利を含む。
 * ★テナントに届く経路へ渡さないこと★ — 型の判別子でそれを防いでいる。
 */
export function renderUpsellForSuperAdmin(f: SuperAdminUpsellFigures): RenderedUpsell {
  const lines: string[] = [];
  lines.push(`${f.tenant_name ?? f.tenant_id}（${planLabel(f.current_plan)} → ${planLabel(f.recommended_plan)}）`);
  lines.push(TENANT_REASON[f.signal]);

  if (f.text_overage > 0) lines.push(`テキスト超過: ${num(f.text_overage)} 件`);
  if (f.avatar_overage_minutes > 0) lines.push(`アバター超過: ${num(f.avatar_overage_minutes)} 分`);

  lines.push(
    `現在: 売上(推計) ${jpy(f.revenue_estimate_jpy)} / API原価 ${jpy(f.cost_base_jpy)} / ` +
    `粗利 ${jpy(f.gross_profit_jpy)}` +
    (f.gross_margin_pct === null ? '（粗利率 —）' : `（粗利率 ${f.gross_margin_pct}%）`),
  );
  lines.push(
    `月額基本料: ${jpy(f.current_base_monthly_jpy)} → ${jpy(f.recommended_base_monthly_jpy)}`,
  );
  lines.push('※ 固定費（アバター基盤・VPS）の按分は含みません。');
  lines.push(`（${f.as_of} 時点の集計）`);

  return { headline: 'アップセル候補', lines };
}
