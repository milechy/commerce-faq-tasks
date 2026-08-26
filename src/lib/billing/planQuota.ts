// src/lib/billing/planQuota.ts
// free_ad プランの月次上限判定。
//
// なぜ分離したか: 月次境界の計算は CLAUDE.md 絶対にやってはいけないこと16
// 「AT TIME ZONE を片側だけ書く」の典型的な事故箇所（本番でのみズレ、数値は
// もっともらしく出るため気づけない）。src/lib/date/weekRange.ts の getWeekRange と
// 同じ理由・同じ手法（process TZ に一切依存しない UTC 算術）でテスト容易性のため
// 純粋関数として切り出す。呼び出し元は src/api/chat/route.ts（createChatHandler）で、
// このファイル自体は DB に触れない。
//
// 単位は「usage_logs の行数(= /api/chat 1回のリクエスト)」。Asana 1217759064329998
// item(7)の指示どおり既存 usage_logs の集計から出し、新しいDB列・新しい集計対象
// (chat_sessions の distinct 数など)を作らない。1会話あたり平均5ターンという
// costCalculator.ts の原価モデル（1会話(5ターン)約0.55円）を踏まえると、上限200は
// 「約200会話分のリクエスト」を安全側(実際の会話数換算では下回る方向)に見積もった
// 値になる——1セッションが200ターンを超える極端な単一会話がある場合、その月の
// 残り新規会話が止まる可能性はあるが、原価上限(月あたり最大 200 × 約0.11円
// ≈ 22円/テナント)を超えることはなく、R2C負担としては安全側に倒れている。
import { JST_OFFSET_MS, shiftToJstWallClock } from "../date/jstOffset";

export const FREE_AD_MONTHLY_REQUEST_LIMIT = 200;

export interface MonthRangeJst {
  /** 当月の開始（1日 00:00:00 JST）をUTC Dateで表したもの */
  monthStart: Date;
  /** 翌月の開始（= 当月の終端、比較は半開区間 [monthStart, monthEnd) で行う） */
  monthEnd: Date;
}

/**
 * now が属する JST 暦月の範囲を返す。
 *
 * weekRange.ts の getWeekRange と同じ手法: now を +9h シフトしてから UTC ゲッター
 * (getUTCFullYear / getUTCMonth) で読むと process TZ に依存せず JST の壁時計表現の
 * 年月が得られる。月初日を Date.UTC で作ってから -9h 戻すことで、SQL 側の
 * `created_at >= $1 AND created_at < $2`（timestamptz 列との比較）にそのまま渡せる
 * UTC Date を返す。SQL 側で `AT TIME ZONE` を書く必要はない。
 */
export function getMonthRangeJst(now: Date): MonthRangeJst {
  const shifted = shiftToJstWallClock(now);
  const shiftedMonthStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    1,
    0,
    0,
    0,
    0,
  );
  const shiftedNextMonthStart = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    1,
    0,
    0,
    0,
    0,
  );

  return {
    monthStart: new Date(shiftedMonthStart - JST_OFFSET_MS),
    monthEnd: new Date(shiftedNextMonthStart - JST_OFFSET_MS),
  };
}

/**
 * 当月の既存リクエスト数（このリクエストを記録する「前」の usage_logs 件数）が
 * 上限に達しているかを判定する。
 *
 * @throws currentMonthRequestCount / limit が負の場合
 */
export function isFreeAdMonthlyQuotaExceeded(
  currentMonthRequestCount: number,
  limit: number = FREE_AD_MONTHLY_REQUEST_LIMIT,
): boolean {
  if (currentMonthRequestCount < 0) {
    throw new Error(`Invalid currentMonthRequestCount: ${currentMonthRequestCount}`);
  }
  if (limit < 0) {
    throw new Error(`Invalid limit: ${limit}`);
  }
  return currentMonthRequestCount >= limit;
}

// ---------------------------------------------------------------------------
// 有料プランの「込み枠」(基本料に含まれる利用量)。
//
// 上の FREE_AD_MONTHLY_REQUEST_LIMIT が「超えたら止める上限」なのに対し、
// こちらは「超えたら従量で請求する境界」であり、止めない。同じファイルに置くのは
// どちらも『プランごとの月次数量の定義』という同一の関心事で、2箇所に分けると
// 片方だけ直す事故(CLAUDE.md 禁止6)を招くため。
//
// ★テキストとアバターを別枠で持つ(合算しない)★
// .claude/rules/billing.md §7 の必須要件。合算すると、アバターに偏ったテナント
// 1社で月額が丸ごと飛ぶ(アバターは原価 ¥25.9/分で、30分セッション1件が ¥799)。
//
// ★ここには「単価」を置かない★
// 超過単価(Standard ¥25/会話・¥100/分、Growth ¥30/会話・¥80/分)は Stripe の
// price オブジェクト側が唯一の出どころで、コードは数量だけを送る
// (planPricing.ts の getSubscriptionItemPrices が price ID を引く)。
// 単価をここに複製すると、Stripe 側を変えたときに黙ってドリフトする。
// ---------------------------------------------------------------------------

/** 1プラン分の込み枠。単位はテキスト=会話数、アバター=分。 */
export interface PlanIncludedQuota {
  /** 基本料に含まれるテキスト会話数(/月)。 */
  textConversations: number;
  /** 基本料に含まれるアバター利用分数(/月)。 */
  avatarMinutes: number;
}

/**
 * 基本料 + 込み枠 + 超過従量 で請求するプランの込み枠(.claude/rules/billing.md §7)。
 *
 * ここに載っていないプランは「込み枠という概念を持たない」:
 *   - free_ad   … 倍率0で請求自体が発生しない。上限は FREE_AD_MONTHLY_REQUEST_LIMIT で止める別の仕組み。
 *   - starter   … 基本料0円の純従量(1単位目から課金)。込み枠を持たせると無料枠を新設することになる。
 *   - enterprise… 個別交渉。自動化しない。
 * したがって未知プランを starter へ倒す planMultiplier とは違い、
 * ここは「無い」を null で返す(勝手に枠を与えると請求漏れになる)。
 */
export const PLAN_INCLUDED_QUOTAS: Record<string, PlanIncludedQuota> = {
  standard: { textConversations: 1000, avatarMinutes: 30 },
  growth:   { textConversations: 3000, avatarMinutes: 150 },
};

/** プラン名から込み枠を引く。込み枠を持たないプラン(starter/free_ad/enterprise/未知)は null。 */
export function includedQuotaForPlan(plan: string | null | undefined): PlanIncludedQuota | null {
  if (plan == null) return null;
  // planMultiplier と同じ理由で自前プロパティに限定する
  // (tenants.plan の CHECK 制約が未適用の環境では任意の文字列が入りうる)。
  return Object.prototype.hasOwnProperty.call(PLAN_INCLUDED_QUOTAS, plan)
    ? PLAN_INCLUDED_QUOTAS[plan]
    : null;
}

/** 込み枠を超えた分の数量。Stripe の従量 price へ送る絶対値そのもの。 */
export interface QuotaOverage {
  /** 込み枠超過のテキスト会話数。 */
  textConversations: number;
  /** 込み枠超過のアバター分数。 */
  avatarMinutes: number;
}

/**
 * 込み枠を差し引いた超過数量を返す。込み枠を持たないプランは null
 * (=呼び出し側は従来どおりの純従量経路へ倒す)。
 *
 * ★プラン倍率(PLAN_MULTIPLIERS)を掛けてはいけない★
 * 超過単価はプランごとに別の Stripe price として実在する
 * (テキスト Standard ¥25 / Growth ¥30、アバター Standard ¥100 / Growth ¥80)。
 * 倍率は既にその単価に織り込まれているため、数量側にも掛けると二重適用になり、
 * テキストは Standard で +25% / Growth で +50% の過剰請求になる。
 * アバターに至っては単価が倍率と逆向き(上位ほど安い)なので、掛けると向きごと壊れる
 * (CLAUDE.md 禁止56 / .claude/rules/billing.md §7)。
 * 単価を持つのは Stripe、数量を持つのはこのコード、という分担を崩さないこと。
 */
export function computeQuotaOverage(
  plan: string | null | undefined,
  textConversations: number,
  avatarMinutes: number,
): QuotaOverage | null {
  const quota = includedQuotaForPlan(plan);
  if (!quota) return null;
  return {
    textConversations: Math.max(0, textConversations - quota.textConversations),
    avatarMinutes:     Math.max(0, avatarMinutes - quota.avatarMinutes),
  };
}
