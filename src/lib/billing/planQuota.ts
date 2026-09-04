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
// 単位は「会話(chat_sessionsの1セッション、message_count>=2)」。
//
// ★UX-D(2026-08-26)で単位をリクエスト数から会話数へ修正した★
// 導入時(Asana 1217759064329998 item(7))は「usage_logsの行数(=リクエスト数)」を
// 単位にしていた。当時は「1会話≒5ターン」という原価モデル(costCalculator.ts、
// 1会話(5ターン)約0.55円)を根拠に、200リクエストを「約200会話分」として安全側に
// 見積もったつもりだった。しかし #1012 で課金単位を会話に切り替えた際に実測した
// ところ、message_count の中央値・p90 とも 2(=1往復)で、この「1会話≒5ターン」の
// 前提自体が誤りだったと判明した(.claude/rules/billing.md §7)。結果、当時の
// 「200リクエスト」は実質 100 会話前後で新規会話を止めていた——LP/UIの
// 「月200会話まで」という表記より不利な挙動になっていた。
//
// 是正後の原価上限: 実測 ¥0.11/会話 なので、月200会話 × ¥0.11 ≈ ¥22/テナント。
// R2C負担として引き続き十分小さい(是正前と同じ結論だが、根拠の数字を実測値に
// 差し替えた)。集計本体(会話の判定ロジック)は src/api/chat/route.ts の
// isFreeAdQuotaExceededForTenant にあり、computeExpectedBilling(stripeSync.ts)の
// conversation_units と同じ判定(session_idごとにDISTINCT、message_count>=2)を
// 使う。このファイル自体は依然としてDBに触れない(数値比較の純関数のみ)。
import { JST_OFFSET_MS, shiftToJstWallClock } from "../date/jstOffset";

export const FREE_AD_MONTHLY_CONVERSATION_LIMIT = 200;

// ---------------------------------------------------------------------------
// P0-4バックストップ(2026-08-26 レビュー): 生リクエスト数の絶対上限。
//
// sessionId はクライアントが完全に制御できる値(Phase38、src/api/chat/route.ts
// の `body.sessionId?.trim() || body.conversationId || randomUUID()`)。
// 上の会話数ベースの上限(FREE_AD_MONTHLY_CONVERSATION_LIMIT)は
// chat_sessions.message_count>=2 の session のみを「会話」として数えるため、
// 常に新規のランダムsessionId + 単発メッセージを送り続けるクライアントは、
// 実際にはLLM呼び出しのコストを発生させ続けながら conversation_units に
// 一切乗らず、会話ベースの上限を無期限にすり抜けられる(本筋の対応=
// session_idのサーバー側発行は別タスクとして先送り中)。
//
// この上限は、session_id によるグルーピングを一切信用しない生の
// usage_logs行数に対する絶対的な安全弁。会話ベースの上限(200)より十分
// 大きく取り、正規の多ターン利用(1会話あたり数メッセージ)を誤って
// 止めないようにしつつ、上記の無期限すり抜けにだけ有限の天井を課す。
export const FREE_AD_MONTHLY_REQUEST_LIMIT = 1000;

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
 * 当月の既存会話数（このリクエストを記録する「前」の会話数）が上限に達しているかを
 * 判定する。会話の定義・集計方法は呼び出し元(src/api/chat/route.ts)が担う——
 * このファイルは数値比較のみの純関数。
 *
 * @throws currentMonthConversationCount / limit が負の場合
 */
export function isFreeAdMonthlyQuotaExceeded(
  currentMonthConversationCount: number,
  limit: number = FREE_AD_MONTHLY_CONVERSATION_LIMIT,
): boolean {
  if (currentMonthConversationCount < 0) {
    throw new Error(`Invalid currentMonthConversationCount: ${currentMonthConversationCount}`);
  }
  if (limit < 0) {
    throw new Error(`Invalid limit: ${limit}`);
  }
  return currentMonthConversationCount >= limit;
}

// ---------------------------------------------------------------------------
// free_ad の管理AI(Copilot UI)月次上限。
//
// D3(2026-09-04, docs/ADMIN_AGENT_COST_REQUIREMENTS.md)により free_ad でも
// 管理AIをゲートで塞がず開放する(アップグレード動線)が、原価はR2C負担のため
// 禁止39(原価が当社負担に反転する経路の上限)により天井が要る。
// 原価¥2〜3/相談 × 30件 = 月¥60〜90のR2C負担。上のFREE_AD_MONTHLY_CONVERSATION_LIMIT
// と同じ作法(サーバ側で保持、超えたら止める・従量請求はしない)。
// ---------------------------------------------------------------------------

export const FREE_AD_MONTHLY_ADMIN_CONSULT_LIMIT = 30;

/**
 * 当月の既存管理AI相談件数(このリクエストを記録する「前」の件数)が上限に達しているかを
 * 判定する。相談の数え方(session_id, JST暦日のDISTINCT)は呼び出し元が担う——
 * このファイルは数値比較のみの純関数。
 *
 * @throws currentMonthAdminConsultCount / limit が負の場合
 */
export function isFreeAdAdminConsultQuotaExceeded(
  currentMonthAdminConsultCount: number,
  limit: number = FREE_AD_MONTHLY_ADMIN_CONSULT_LIMIT,
): boolean {
  if (currentMonthAdminConsultCount < 0) {
    throw new Error(`Invalid currentMonthAdminConsultCount: ${currentMonthAdminConsultCount}`);
  }
  if (limit < 0) {
    throw new Error(`Invalid limit: ${limit}`);
  }
  return currentMonthAdminConsultCount >= limit;
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

/** 1プラン分の込み枠。単位はテキスト=会話数、アバター=分、管理AI=相談件数。 */
export interface PlanIncludedQuota {
  /** 基本料に含まれるテキスト会話数(/月)。 */
  textConversations: number;
  /** 基本料に含まれるアバター利用分数(/月)。 */
  avatarMinutes: number;
  /** 基本料に含まれる管理AIへの相談件数(/月)。 */
  adminConsults: number;
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
 *
 * ★adminConsults(管理AIへの相談)は docs/ADMIN_AGENT_COST_REQUIREMENTS.md §4-2 の推奨値★
 * 原価¥2〜3/相談を基準に、基本料に対する原価比率を約2.5%に揃えた暫定値であり、
 * Stripe price 作成時に人間(hkobayashi)が確定させる。
 */
export const PLAN_INCLUDED_QUOTAS: Record<string, PlanIncludedQuota> = {
  standard: { textConversations: 1000, avatarMinutes: 30, adminConsults: 100 },
  growth:   { textConversations: 3000, avatarMinutes: 150, adminConsults: 300 },
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
  /** 込み枠超過のテキスト会話数(表示用)。 */
  textConversations: number;
  /** 込み枠超過のアバター分数。 */
  avatarMinutes: number;
  /** 込み枠超過の管理AI相談件数(表示用)。 */
  adminConsults: number;
  /**
   * Stripe のテキストpriceへ送る唯一の数量 = textConversations + adminConsults。
   *
   * ★管理AIの相談はテキスト会話と同じ Stripe price を流用する(単価テーブルを新設しない)★
   * (docs/ADMIN_AGENT_COST_REQUIREMENTS.md §4-1)。込み枠は別々に持つが、超過は同じ
   * price へ合算して送るため、送信側(stripeSync.ts)と突合側(billingReconciliation.ts)が
   * 別々にこの足し算をすると必ずズレる。だから足し算はここ1箇所だけで行う。
   */
  textPriceQuantity: number;
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
 *
 * @param adminConsults 当月の管理AI相談件数(生。込み枠差し引き前)。
 *   ★既定値を持たせない(必須引数)★ 呼び忘れを 0 に静かに丸めると、
 *   管理AIの超過が永久に請求されない経路になり得るため、呼び出し元に明示させる。
 */
export function computeQuotaOverage(
  plan: string | null | undefined,
  textConversations: number,
  avatarMinutes: number,
  adminConsults: number,
): QuotaOverage | null {
  const quota = includedQuotaForPlan(plan);
  if (!quota) return null;
  const textOverage = Math.max(0, textConversations - quota.textConversations);
  const adminOverage = Math.max(0, adminConsults - quota.adminConsults);
  return {
    textConversations: textOverage,
    avatarMinutes:      Math.max(0, avatarMinutes - quota.avatarMinutes),
    adminConsults:       adminOverage,
    textPriceQuantity:   textOverage + adminOverage,
  };
}
