/**
 * upsellSignals.ts — 利用状況から「アップセルの余地があるか」を決定的に判定する。
 *
 * ■ 金額を一切扱わない
 * ここが返すのは無次元のシグナルと数量・率だけ。円もセントもマージンも出てこない。
 * このモジュールの出力は Hermes(外部VPS の LLM エージェント)へ渡るため、
 * 金額を含めるとテナント向けの生成文に混ざり、原価やマージン倍率が漏れうる
 * (src/api/admin/CLAUDE.md「金額・件数を LLM の生成文に通さない」)。
 * 金額は承認後に upsellRenderer が決定的コードでレンダリングする。
 *
 * ■ 第2の閾値表を作らない
 * 閾値は全て planQuota.ts / planPricing.ts の既存定数から引く。
 * ここに数値を焼き付けると、価格改定でどちらかだけ直された瞬間に
 * 「画面上は超過なのに提案が出ない」状態が静かに生まれる。
 */
import {
  includedQuotaForPlan,
  computeQuotaOverage,
  FREE_AD_MONTHLY_CONVERSATION_LIMIT,
} from './planQuota';
import {
  STARTER_MONTHLY_BILLED_QUANTITY_CAP,
  GROWTH_TEXT_UNITS_ENTERPRISE_NUDGE_THRESHOLD,
  nextPlanUp,
} from './planPricing';

/**
 * アップセルのきっかけ。
 * ★増やすときは migration_proposal_type.sql の allowlist ではなくここと
 *   hermes-mcp の検証を同じ PR で直すこと(受け口が2箇所ある)★
 */
export type UpsellSignal =
  /** 込み枠のテキスト会話を超過している */
  | 'text_overage'
  /** 込み枠のアバター分数を超過している */
  | 'avatar_overage'
  /** 込み枠の8割以上を消化しており、超過が見えている */
  | 'text_near_limit'
  /** Starter の月間請求数量の上限に達した(価格表の見え方として上位プランが自然) */
  | 'starter_cap_reached'
  /** free_ad の月間会話上限に達した */
  | 'free_ad_limit_reached'
  /** Growth でも規模が大きく、個別契約(enterprise)の相談が妥当 */
  | 'enterprise_nudge';

/** 込み枠の何割から「上限が近い」とみなすか。 */
const NEAR_LIMIT_RATIO = 0.8;

export interface UpsellSignalInput {
  plan: string | null;
  /** 課金単位のテキスト会話数(computeExpectedBilling 由来)。 */
  textUnits: number;
  avatarMinutes: number;
}

export interface UpsellSignalResult {
  signals: UpsellSignal[];
  /** 込み枠に対する消化率(%)。込み枠の無いプランは null。★0 にしない★ */
  utilizationPct: { text: number | null; avatar: number | null };
  overage: { textConversations: number; avatarMinutes: number };
  /** 1つ上のプラン。最上位・未知なら null。 */
  nextPlanCandidate: string | null;
  /**
   * 1つ上のプランに変えた場合の消化率(%)。
   * 上位プランに込み枠が無い(= enterprise)場合は null。
   * 「上げれば収まるのか」を金額抜きで判断できるようにするための値。
   */
  utilizationPctOnNextPlan: { text: number | null; avatar: number | null };
}

function pct(used: number, included: number | null | undefined): number | null {
  // included が null(込み枠の概念が無いプラン)を 0% と混同しない。
  if (included === null || included === undefined || included <= 0) return null;
  return Math.round((used / included) * 1000) / 10;
}

/**
 * 利用状況からアップセルのシグナルを決定的に導く。
 * 同じ入力からは常に同じ出力になる(LLM を通さない)。
 */
export function computeUpsellSignals(input: UpsellSignalInput): UpsellSignalResult {
  const { plan, textUnits, avatarMinutes } = input;
  const signals: UpsellSignal[] = [];

  const included = includedQuotaForPlan(plan ?? '');
  const overage = computeQuotaOverage(plan ?? '', textUnits, avatarMinutes);
  const overText = overage?.textConversations ?? 0;
  const overAvatar = overage?.avatarMinutes ?? 0;

  if (overText > 0) signals.push('text_overage');
  if (overAvatar > 0) signals.push('avatar_overage');

  const textPct = pct(textUnits, included?.textConversations);
  const avatarPct = pct(avatarMinutes, included?.avatarMinutes);

  // 超過していないが上限が近い。超過してから気づくと「後出しの請求」に見える。
  if (overText === 0 && textPct !== null && textPct >= NEAR_LIMIT_RATIO * 100) {
    signals.push('text_near_limit');
  }

  if (plan === 'starter' && textUnits >= STARTER_MONTHLY_BILLED_QUANTITY_CAP) {
    signals.push('starter_cap_reached');
  }
  if (plan === 'free_ad' && textUnits >= FREE_AD_MONTHLY_CONVERSATION_LIMIT) {
    signals.push('free_ad_limit_reached');
  }
  if (plan === 'growth' && textUnits >= GROWTH_TEXT_UNITS_ENTERPRISE_NUDGE_THRESHOLD) {
    signals.push('enterprise_nudge');
  }

  const nextPlan = nextPlanUp(plan);
  const nextIncluded = nextPlan ? includedQuotaForPlan(nextPlan) : null;

  return {
    signals,
    utilizationPct: { text: textPct, avatar: avatarPct },
    overage: { textConversations: overText, avatarMinutes: overAvatar },
    nextPlanCandidate: nextPlan,
    utilizationPctOnNextPlan: {
      text: pct(textUnits, nextIncluded?.textConversations),
      avatar: pct(avatarMinutes, nextIncluded?.avatarMinutes),
    },
  };
}

/** Hermes から受け取った signal 文字列が既知のものか検証する(allowlist)。 */
const VALID_SIGNALS: ReadonlySet<string> = new Set<UpsellSignal>([
  'text_overage', 'avatar_overage', 'text_near_limit',
  'starter_cap_reached', 'free_ad_limit_reached', 'enterprise_nudge',
]);
export function isValidUpsellSignal(v: unknown): v is UpsellSignal {
  return typeof v === 'string' && VALID_SIGNALS.has(v);
}
