// src/api/admin/agent/actionExecutor.ts
// Phase B-Admin: 10ツールのアクション実行（tenantId は引数固定 — body禁止）

import { Pool, PoolClient } from 'pg';
import { logger } from '../../../lib/logger';
import { getWeekRange } from '../../../lib/date/weekRange';
import {
  insertEmbeddingAsync,
  upsertToEsAsync,
} from '../knowledge/faqCrudRoutes';
import { deleteFaqFromEs } from '../../../lib/knowledge/faqIndexSync';
import { isValidOriginPattern } from '../../middleware/originCheck';
import { FAQ_CATEGORY_IDS } from '../../../lib/knowledge/faqCategories';
import { callGroq8bSuggestFromText, callGroq8bSuggest } from '../tuning/routes';
import { listRules, createRule, updateRule, deleteRule, type ApprovedResponse, type RuleEvidence } from '../tuning/tuningRulesRepository';
import { splitTriggerKeywords } from '../tuning/triggerMatching';
import { routeCorrection } from "../../../agent/knowledge/correctionRouter";
import { generateTestResponses } from '../tuning/testResponseRoutes';
import { searchKnowledgeForSuggestion, formatKnowledgeContext } from '../../../lib/knowledgeSearchUtil';
import { getGaps, updateGapStatus } from '../knowledge/knowledgeGapRepository';
import { textToFaqs } from '../knowledge/routes';
import {
  generateTextFaqPreview,
  generateScrapeFaqPreview,
  commitTextFaqs,
  commitScrapeFaqs,
  fetchExistingQuestions,
  bigramSimilarity,
  DUPLICATE_THRESHOLD,
} from '../../../lib/knowledge/faqImport';
import {
  setStagedFaqImport,
  getStagedFaqImport,
  clearStagedFaqImport,
  recordPlanLimitMention,
} from './knowledgeImportStaging';
import { suggestEngagementRuleFromText } from './engagementSuggest';
import { getSessions, getActiveEscalations, getMessages, saveMessage, resolveEscalation, normalizeSessionListParams, getConversionTypes, recordOutcome, getSessionOutcome } from '../chat-history/chatHistoryRepository';
import { deleteSession } from '../chat-history/deleteSessionRepository';
import { getEvaluationsBySession } from '../evaluations/evaluationsRepository';
import { computeKpis } from '../monitoring/routes';
import { userSourceClause, userSourceExists } from '../analytics/summaryQueries';
import { checkSaiMonthlyCostCeiling } from '../options/routes';
import { submitSaiTask, getSaiTask } from '../../../lib/sai/saiClient';
import { recordSaiTask, resolveSaiTaskTenant } from '../../../lib/sai/saiTaskRegistry';
import { trackUsage } from '../../../lib/billing/usageTracker';
import { queryTenantPlan, planHasFeature, resolveShareForTenantPlan } from '../../../lib/billing/planFeatures';
import { fetchAnalyticsSummary, fetchConversionSummary } from '../analytics/summaryQueries';
import { getRuleEffect } from '../analytics/ruleEffect';
import { isOnboardingIndustry, ONBOARDING_INDUSTRY_LABELS, INDUSTRY_FAQ_TEMPLATES } from './industryFaqTemplates';
import { buildPlacementAttributes, validateWidgetPlacement } from './widgetPlacement';

// チャットでの一括インポートで一度に生成・コミットできるFAQ数の上限。
// POST /v1/admin/knowledge/text/commit・/scrape/commit の zod スキーマ(max 20)と揃える。
const MAX_IMPORT_FAQS = 20;

// 有人返信1件の最大文字数。POST /v1/admin/chat-history/sessions/:id/reply の
// zod スキーマ(z.string().min(1).max(2000))と揃える。
const MAX_OPERATOR_REPLY_LENGTH = 2000;

// get_escalations がチャットに載せる最大件数。1行あたり約110字で、閲覧系予算
// (truncateRead の 4000字)に収まる範囲に余裕を持って収める。get_chat_sessions の
// 上限(20)と揃えてあり、超過分は「全N件中M件」の見出しで存在が分かるようにする。
const ESCALATION_LIST_LIMIT = 20;

// ツールの limit 引数を [1, max] の整数にクランプする。"abc" のような非数値は Number() で
// NaN になり、Math.min/max を素通りして NaN のまま残ってしまう(NaN との比較は常に false)。
// NaN が SQL の LIMIT パラメータに渡ると実DBではエラーになるため、既定値にフォールバックする。
// また limit は toolDefinitions.ts 上 integer だが、LLMが 1.5 のような小数を返す可能性があり、
// 小数のまま SQL の LIMIT に渡ると実DBでエラーになる。クランプ後に整数化して防ぐ
// (クランプ→整数化の順にするのは「範囲に収めてから丸める」意図を読み取れるようにするため)。
function clampToolLimit(raw: unknown, defaultValue: number, max: number): number {
  const n = Number(raw ?? defaultValue);
  return Math.floor(Math.min(Math.max(Number.isFinite(n) ? n : defaultValue, 1), max));
}

// 書き込み系ツールの確認フラグ(confirmed)を読む唯一の入口。
//
// かつては Boolean() による判定と厳密等価(=== true)による判定が混在していた。
// 前者は Boolean('false') === true という JS の仕様により、文字列 'false' を
// 「確認済み」と誤判定する。本リポジトリでは Groq が引数を文字列化して送ってくる
// 事象が実測されている(agentRoutes.ts の parseToolArgs のコメント: 無引数ツールに
// 対し文字列 "null" が送られてくるケース)ため、この誤判定は机上のものではない。
//
// 逆に === true だけに統一すると、Groq が文字列 "true" を送ってきた場合に
// ユーザーが同意し続けても永久に実行されないループに陥る。両方向に対応するため、
// boolean の true と文字列 "true" のみを受理し、それ以外は未確認として扱う
// (未知の型は安全側=未確認に倒す)。
function isConfirmed(raw: unknown): boolean {
  if (raw === true) return true;
  return typeof raw === 'string' && raw.trim().toLowerCase() === 'true';
}

// set_faq_published / set_avatar_feature の真偽値引数を解析する。isConfirmed と同じ理由
// (Groqがbooleanを文字列化して送ってくることがある)で、真偽値そのものに加え "true"/"false"
// 文字列も受理する。confirmed と違い true/false 両方を区別する必要があるため、どちらでも
// なければ undefined(未指定/不正値)を返す。agentRoutes.ts の監査ログ(readNewValue)も
// このパーサ経由で正規化した値を記録する(生のargsをそのまま使うと、Groqが文字列化した
// ケースで tenant_settings_history に文字列"true"がbooleanのつもりで残ってしまう)。
export function parseBooleanArg(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

// suggest_tuning_rule がトリガー未決定時に案内していたプレースホルダ文字列。
// save_tuning_rule にそのまま渡ってきた場合、文字列としてtrigger_patternに
// 保存させない(D4: 保存は成功するが質問文に一致せず永久に発火しない)。
const ALWAYS_APPLY_PLACEHOLDER = new Set(['（常時適用）']);

// D5: 優先度の3段階語彙(低/普通/高)→数値変換。単一の情報源は
// admin-ui/src/lib/tuningPriority.ts の PRIORITY_TIER_VALUE。サーバ/フロントの
// 境界を跨ぐため型は共有できず、値を変える場合は両方を手動で同期させること。
const PRIORITY_TIER_VALUE: Record<'low' | 'normal' | 'high', number> = {
  low: 2,
  normal: 5,
  high: 8,
};

const PRIORITY_TIER_LABEL_JA: Record<'low' | 'normal' | 'high', string> = {
  low: '低',
  normal: '普通',
  high: '高',
};

function parsePriorityTier(raw: unknown): 'low' | 'normal' | 'high' | undefined {
  return raw === 'low' || raw === 'normal' || raw === 'high' ? raw : undefined;
}

// add_faq / update_faq が共有するcategory引数の解析。空文字列は「未指定」として扱う
// (LLMのfunction callingで省略時に''が渡ってくることがあるため、nullと区別せず
// 「不明なカテゴリです」で弾いてしまうと正当なquestion/answerの更新まで失敗する)。
function parseFaqCategoryArg(raw: unknown): { ok: true; category: string | null } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: true, category: null };
  if (!FAQ_CATEGORY_IDS.includes(raw)) return { ok: false, error: `不明なカテゴリです: ${raw}` };
  return { ok: true, category: raw };
}

// update_avatar_profile の任意テキスト引数(name / personality_prompt / behavior_description)の解析。
// 空文字列・空白のみは「未指定」として扱う。
// 理由: Groq の function calling は省略した任意引数に '' を入れて送ってくることがある
// (parseFaqCategoryArg の #771、parseBooleanArg の #774 と同型の実測済み挙動)。
// typeof raw === 'string' だけで判定すると '' が「値の指定あり」となり、
// UPDATE ... SET name = '' が走ってアバター名が空になる破壊的更新になる。
// 「意図的に空へ戻す」手段は失われるが、名前や性格を空にする正当な用途は無く、
// 既定に戻したい場合は reset_avatar_to_default がある。
function parseOptionalTextArg(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

// get_faq_list の published 引数。旧UI KnowledgeListTab の状態フィルタ3種(all/published/draft)
// に合わせる。allowlist外・未指定はすべて 'all' に倒す(get_chat_sessions の LLM由来値検証と
// 同じ安全側フォールバック)。
function parseFaqPublishedFilter(raw: unknown): 'all' | 'published' | 'draft' {
  return raw === 'published' || raw === 'draft' ? raw : 'all';
}

// get_faq_list の sort_by 引数。旧UI KnowledgeListTab の並び順4種(SORT_PARAMS)に合わせる。
// SQLへ渡す列名・方向は固定マッピングのみを使い、LLM由来の生値をSQLへ直接補間しない
// (faqCrudRoutes.ts の SORT_COLUMN_MAP と同じ二重保護)。
const FAQ_SORT_OPTIONS = {
  newest: { column: 'created_at', direction: 'DESC' },
  oldest: { column: 'created_at', direction: 'ASC' },
  updated: { column: 'updated_at', direction: 'DESC' },
  category: { column: 'category', direction: 'ASC' },
} as const;
type FaqSortBy = keyof typeof FAQ_SORT_OPTIONS;
function parseFaqSortBy(raw: unknown): FaqSortBy {
  // `in` 演算子はプロトタイプチェーンを辿るため、raw="hasOwnProperty"等の値が
  // 誤って許可されてしまう(/code-review high 指摘)。Object.hasOwn相当のown-property
  // チェックに限定する。
  return typeof raw === 'string' && Object.prototype.hasOwnProperty.call(FAQ_SORT_OPTIONS, raw)
    ? (raw as FaqSortBy)
    : 'newest';
}

// ---------------------------------------------------------------------------
// プラン制限の案内文
// ---------------------------------------------------------------------------
//
// full は他のAPI(analytics/routes.ts, tenants/routes.ts 等)と同じ文言。変更しないこと。
// 同じ会話の中で同じ機能について何度も full を返すと同じ売り込みの繰り返しになるため、
// 2回目以降は short に切り替える(制限そのものは変わらない)。判定は
// knowledgeImportStaging.ts の recordPlanLimitMention((tenantId, sessionId, feature)単位)。
type PlanLimitedFeature = 'avatar' | 'premium_avatar' | 'analytics' | 'conversion' | 'sai_task';

const PLAN_LIMIT_NOTICES: Record<PlanLimitedFeature, { full: string; short: string }> = {
  avatar: {
    full: 'AIアバター機能はGrowthプラン以上でご利用いただけます',
    short: 'AIアバター機能はプラン対象外のままです',
  },
  premium_avatar: {
    full: '高品質なアバター画像の生成はGrowthプラン以上でご利用いただけます',
    short: '高品質なアバター画像の生成はプラン対象外のままです',
  },
  analytics: {
    full: 'この機能はGrowthプラン以上でご利用いただけます',
    short: 'この機能はプラン対象外のままです',
  },
  conversion: {
    full: 'この機能はGrowthプラン以上でご利用いただけます',
    short: 'この機能はプラン対象外のままです',
  },
  sai_task: {
    full: 'Saiへの代行依頼はEnterpriseプラン以上でご利用いただけます',
    short: 'Saiへの代行依頼はプラン対象外のままです',
  },
};

function planLimitNotice(tenantId: string, sessionId: string, feature: PlanLimitedFeature): string {
  const notice = PLAN_LIMIT_NOTICES[feature];
  return recordPlanLimitMention(tenantId, sessionId, feature) ? notice.short : notice.full;
}

// ---------------------------------------------------------------------------
// Avatar activate（avatar/routes.ts は無改変、ここで再実装）
// ---------------------------------------------------------------------------

export async function activateAvatarConfig(
  client: PoolClient,
  id: string,
  tenantId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await client.query('BEGIN');

    // 全て deactivate
    await client.query(
      'UPDATE avatar_configs SET is_active = false WHERE tenant_id = $1',
      [tenantId]
    );

    // 対象を activate
    const result = await client.query(
      'UPDATE avatar_configs SET is_active = true WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: '設定が見つかりません' };
    }

    // tenants.features.avatar を true に同期
    await client.query(
      "UPDATE tenants SET features = jsonb_set(COALESCE(features, '{}'), '{avatar}', 'true') WHERE id = $1",
      [tenantId]
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 会話セッションの短縮ID解決（get_chat_sessions が表示する [xxxxxxxx] を受け取る）
// ---------------------------------------------------------------------------

export type ResolveSessionResult =
  | { ok: true; session: { id: string; session_id: string } }
  | { ok: false; message: string };

/** 短縮IDの前方一致でセッションを解決する。tenant_id 条件は省略不可（越境参照防止）。 */
export async function resolveSessionByShortId(
  db: Pool,
  tenantId: string,
  input: string
): Promise<ResolveSessionResult> {
  const shortId = input.trim();
  if (!shortId) {
    return { ok: false, message: 'セッションIDを指定してください' };
  }
  // session_id は生成時から常に小文字（ウィジェット側の crypto.randomUUID() と
  // 手動フォールバック(toString(16))、サーバ側の randomUUID() のいずれも小文字を返す）。
  // 一方 Postgres の LIKE は大文字小文字を区別するため、ユーザーがコピペ時に
  // 大文字化されたIDや、LLMが整形し直したIDを渡すと、実在するセッションが
  // 「見つかりません」になり存在しないIDと区別が付かなかった。照合用だけ小文字に
  // 正規化する（SQL を ILIKE に変えないのは、インデックスを効かせたままにするため）。
  // 表示用の shortId は入力のまま残し、エラー文にはユーザーが打った文字列を返す。
  //
  // LIKE のワイルドカードを無効化し、意図しない広域一致を防ぐ（Postgres の既定エスケープ文字は \）
  const prefix = shortId.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);

  const result = await db.query<{ id: string; session_id: string }>(
    `SELECT id, session_id FROM chat_sessions
     WHERE tenant_id = $1 AND session_id LIKE $2 || '%'
     ORDER BY last_message_at DESC
     LIMIT 6`,
    [tenantId, prefix]
  );

  if (result.rows.length === 0) {
    return { ok: false, message: `セッション[${shortId}]は見つかりません。get_chat_sessions で表示されたIDをご確認ください` };
  }
  if (result.rows.length > 1) {
    // 8文字だと候補同士が同じ表示になりうるため、区別できるよう長めのIDを提示する
    const candidates = result.rows.map((r) => `[${r.session_id.slice(0, 16)}]`).join(' ');
    return {
      ok: false,
      message: `セッション[${shortId}]に一致する会話が${result.rows.length}件あります: ${candidates}\nどれか1つのIDをそのまま指定してください`,
    };
  }
  return { ok: true, session: result.rows[0] };
}

const CHAT_ROLE_LABELS: Record<string, string> = {
  user: 'お客様',
  assistant: 'AI',
  operator: '担当者',
};

// ---------------------------------------------------------------------------
// ツール実行結果
// ---------------------------------------------------------------------------

// フィールド名は copilot-preview の Card union の link バリアントに揃えてあり、
// フロントは自然文を正規表現で読み直さずそのまま描画できる。
export type LegacyLinkCardPayload = {
  kind: 'legacy_link';
  label: string;
  url: string;
  description: string;
};

// suggest_avatar_preset が返す、既定アバター見本1件の提示カード。
// presetId は adopt_avatar_preset にそのまま渡す r2c_default 側の avatar_configs.id。
export type AvatarPresetCardPayload = {
  kind: 'avatar_preset';
  presetId: string;
  name: string;
  imageUrl: string | null;
  description: string;
};

// adopt_avatar_preset が返す、採用直後のカード。configId は自テナント側の
// avatar_configs.id（presetId とは別物）で、フロントはこの id を画像候補生成
// （POST /v1/admin/avatar/fal/generate は本カードとは無関係にフロントから直接叩く）と
// 採用確定（PATCH /v1/admin/avatar/configs/:id）にそのまま使う。
export type AvatarAdoptedCardPayload = {
  kind: 'avatar_adopted';
  configId: string;
  name: string;
  imageUrl: string | null;
  description: string;
};

// get_tuning_rules の全件データ。text(自然文・500字)は件数の要約のみとし、
// 一覧の欠落(D3: 15件に切ってさらに1行60/100字に切っていたため実質3〜4件しか
// 出ていなかった)を、件数によらず全件をここに載せることで解消する。
export type TuningRulesListCardPayload = {
  kind: 'tuning_rules_list';
  rules: Array<{
    id: number;
    triggerPattern: string;
    expectedBehavior: string;
    priority: number;
    isActive: boolean;
    // AI提案(judge)か店主が作ったもの(manual)かの出所。無いと承認判断ができない。
    source: string | null;
    // pending(既定) / active(承認済み) / rejected(却下済み)。is_active だけでは
    // pending と rejected が区別できない(どちらも is_active=false)ため必要。
    status: string | null;
    evidence: RuleEvidence | null;
  }>;
  totalCount: number;
};

// suggest_tuning_rule の下書き提案。D6: フロントは自然文を正規表現で
// (トリガー:(.+) / 対応方針:(.+))読み直しており、①優先度を拾えない
// ②対応方針が複数行だと1行目以降が失われる、という2つの欠落があった。
// この card は truncate されない生の提案値を運ぶため、save_tuning_rule に
// そのまま渡される内容(trigger_pattern/expected_behavior/priority)と
// カードの表示内容が一致する。
export type TuningRuleDraftCardPayload = {
  kind: 'tuning_rule_draft';
  triggerPattern: string;
  expectedBehavior: string;
  priority: number;
};

// get_weekly_briefing 用。数値はLLMの生成文を経由せず、この構造化データを
// そのままカードとして描画する(数値=サーバ、解釈=LLMの文、という権威分離の実体)。
// 各グループは対応するクエリが失敗した場合に null になる(Promise.allSettledでの
// 部分失敗時、text側で行ごと省略するのと同じ意味)。card はUIが「取得できなかった」を
// 判別するための情報であり、0埋めしてはならない。
//
// フィールドを変更したら、サーバ/フロントの境界を跨いで手動同期が必要な箇所が2つある:
//   - admin-ui/src/lib/useAgentChatTransport.ts の WeeklySummaryAgentActionCard
//   - admin-ui/src/pages/copilot-preview/index.tsx の Card union(weeklySummary variant)
//     は上記から Omit<..., "kind"> で再利用しているため、そちらを直せば自動的に追随する。
export type WeeklySummaryCardPayload = {
  kind: 'weekly_summary';
  /** この応答を生成した瞬間(ISO)。会話復元時に古いまとめだと判別するために使う */
  asOf: string;
  sessions: { total: number; changePct: number | null; prevTotal: number } | null;
  avgScore: number | null;
  conversions: { count: number; total: number } | null;
  faq: { total: number; published: number; lastUpdated: string | null } | null;
  pendingTuningRules: number | null;
  gaps: { total: number; top: Array<{ id: number; question: string }> } | null;
  /** 今週AIが覚えたこと。faqAdded=今週追加されたFAQ、memorized=会話から自動で覚えた件数。
   *  **0 は「動きが無かった」という正しい情報**なので、取得失敗(null)と区別して 0 のまま出す。 */
  learned: { faqAdded: number; memorized: number } | null;
};

// 会話一覧カード。短縮ID(shortId)をそのまま次のツール呼び出しに使える形で持たせ、
// フロント側が短縮IDの手打ちなしで次の1件を選べるようにする(チップの action に使う)。
// outcome は getSessions() が既にSELECTしているため、ここで持たせることで
// 「どの会話が成約したか」を知るために get_session_outcome をセッション数だけ
// 往復する必要が無くなる。
export type ChatSessionListCardPayload = {
  kind: 'chat_session_list';
  total: number;
  sessions: Array<{
    shortId: string;
    startedAt: string;
    messageCount: number;
    preview: string;
    outcome: string | null;
  }>;
};

// 会話本文カード。role のラベル化はサーバ側の CHAT_ROLE_LABELS を単一の情報源とし、
// フロント側に同じ辞書を二重に持たせない(値が面によって違って見える事故を避ける)。
export type ChatSessionMessagesCardPayload = {
  kind: 'chat_session_messages';
  shortId: string;
  totalMessages: number;
  // role は 'user' | 'assistant' | 'operator' 等の生の値。P5-1で
  // 「この会話からルールを作る」チップをAI応答直後にのみ出すために必要
  // (roleLabelは表示用の日本語ラベルで判定に使うと言語非依存性が崩れる)。
  messages: Array<{ role: string; roleLabel: string; content: string }>;
};

// AI品質評価(Judge)カード。4軸ラベルは旧UI(admin-ui の JudgeEvaluationSection.tsx)と
// 同一の語彙をここで確定させ、フロント側に同じ辞書を二重に持たせない。
export type ConversationEvaluationCardPayload = {
  kind: 'conversation_evaluation';
  shortId: string;
  overallScore: number;
  axes: Array<{ label: string; score: number | null }>;
  notes: string | null;
};

// P5-1: 知識ギャップ一覧カード。各行から「このギャップからルールを作る」チップに
// 繋げるため、質問文とヒット件数を店主が読める形で持たせる。
export type KnowledgeGapsListCardPayload = {
  kind: 'knowledge_gaps_list';
  gaps: Array<{ id: number; userQuestion: string; ragHitCount: number }>;
  totalCount: number;
};

// GID 1217752900578379 (R4): ルール効果(DiD推定)カード。
// ruleEffect.ts のAPIレスポンスはトップレベルsnake_case・comparison内camelCaseが
// 混在しているが(既存の歪みでスコープ外)、カードはここで一貫したcamelCaseに吸収する。
// comparison/progress は互いに排他(母数充足時はcomparisonのみ、不足時はprogressのみ)。
// 母数不足時は数値を0埋めせずnullにする(WeeklySummaryCardPayloadと同じ規約)。
// 3層同期(useAgentChatTransport.ts の RuleEffectAgentActionCard /
// copilot-preview/index.tsx の Card union)はこのフィールド形状と一致させること。
export type RuleEffectCardPayload = {
  kind: 'rule_effect';
  ruleId: number;
  approvedAt: string;
  truncated: boolean;
  analyzedSessions: number;
  comparison: {
    didEstimate: number;
    ci95Low: number;
    ci95High: number;
    naiveTreatmentDelta: number;
  } | null;
  progress: Array<{
    group: string;
    /** 店主向けの日本語ラベル。旧UIに同等表示が無いためここが唯一の語彙(フロントに辞書を二重持ちしない)。 */
    groupLabel: string;
    currentN: number;
    requiredN: number;
    etaDays: number | null;
  }> | null;
};

export type ActionCardPayload =
  | LegacyLinkCardPayload
  | AvatarPresetCardPayload
  | AvatarAdoptedCardPayload
  | TuningRulesListCardPayload
  | TuningRuleDraftCardPayload
  | WeeklySummaryCardPayload
  | ChatSessionListCardPayload
  | ChatSessionMessagesCardPayload
  | ConversationEvaluationCardPayload
  | KnowledgeGapsListCardPayload
  | RuleEffectCardPayload;

// ツール結果は既定では素の文字列で、構造化データを添えるツールだけが
// { text, card } 形を返す。card は text の置き換えではなく追加である
// （text 側の自然文は既存の正規表現パーサのフォールバック契約として残す。
// また text は LLM へ tool 結果として差し戻され、応答文の材料になるため、
// 件数に依存しない要約であることが必須）。
export type ActionResult = string | { text: string; card?: ActionCardPayload };

// ---------------------------------------------------------------------------
// メインエントリ
// ---------------------------------------------------------------------------

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  tenantId: string,
  db: Pool,
  sessionId: string,
  isSuperAdmin: boolean = false,
  // delete_chat_session が audit_logs (actor_role/actor_email) に記録するために必要。
  // 他のcaseはこれまで通り未使用のままでよいが、必須引数にすることで唯一の呼び出し元
  // (executeHopToolCalls)が渡し忘れることをtypecheckで検出できるようにする。
  actor: { role: string; email: string }
): Promise<ActionResult> {
  // 結果は500字以内日本語(書き込み系はこちらのまま)
  const truncate = (s: string) => s.slice(0, 500);
  // 閲覧系(一覧・本文)の出力予算。書き込み系の500字とは別枠にする — 一覧・本文は
  // 量そのものが本質的な機能であり、500字では「全N件中M件」の見出しを付けても
  // 実際には数件しか読めないまま黙って切れていた。打ち切った場合は見出し(先頭)は
  // そのまま残り、末尾に打ち切りが起きたこと自体が分かる注記を必ず付ける(黙って切らない)。
  const READ_RESULT_MAX_CHARS = 4000;
  const truncateRead = (s: string): string => {
    if (s.length <= READ_RESULT_MAX_CHARS) return s;
    return s.slice(0, READ_RESULT_MAX_CHARS) + '\n…(文字数上限のため以降省略。絞り込み条件やページを変えて再度お尋ねください)';
  };

  switch (toolName) {
    // -----------------------------------------------------------------------
    case 'get_tenant_settings': {
      try {
        const result = await db.query(
          'SELECT ga4_measurement_id, posthog_host, widget_theme, allowed_origins, faq_question_hint, faq_answer_hint FROM tenants WHERE id = $1',
          [tenantId]
        );
        if (result.rows.length === 0) {
          return truncate('テナント設定が見つかりません');
        }
        const row = result.rows[0] as {
          ga4_measurement_id: string | null;
          posthog_host: string | null;
          widget_theme: Record<string, unknown> | null;
          allowed_origins: string[] | null;
          faq_question_hint: string | null;
          faq_answer_hint: string | null;
        };
        const origins = row.allowed_origins ?? [];
        return truncate(
          `現在の設定:\n` +
          `• GA4 Measurement ID: ${row.ga4_measurement_id ?? '未設定'}\n` +
          `• PostHog ホスト: ${row.posthog_host ?? '未設定'}\n` +
          `• ウィジェットテーマ: ${JSON.stringify(row.widget_theme ?? {})}\n` +
          `• Widget埋め込み許可ドメイン: ${origins.length > 0 ? origins.join(', ') : '未登録（全ドメインから埋め込み可能）'}\n` +
          `• FAQ質問欄の入力例: ${row.faq_question_hint ?? '未設定（既定の例文を表示）'}\n` +
          `• FAQ回答欄の入力例: ${row.faq_answer_hint ?? '未設定（既定の例文を表示）'}`
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_tenant_settings failed', err);
        return truncate('設定の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'set_ga4_id': {
      const measurementId = String(args['measurement_id'] ?? '');
      if (!/^G-[A-Z0-9]+$/.test(measurementId)) {
        return truncate(`GA4 Measurement ID の形式が不正です。G-XXXX形式で指定してください（例: G-ABC123）`);
      }
      try {
        await db.query(
          'UPDATE tenants SET ga4_measurement_id = $1 WHERE id = $2',
          [measurementId, tenantId]
        );
        return truncate(`GA4 Measurement ID を ${measurementId} に設定しました`);
      } catch (err) {
        logger.warn('[actionExecutor] set_ga4_id failed', err);
        return truncate('GA4 ID の設定に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'set_posthog': {
      const host = String(args['host'] ?? '');
      if (!host.startsWith('http')) {
        return truncate('PostHog ホスト URL は http:// または https:// で始まる必要があります');
      }
      try {
        await db.query(
          'UPDATE tenants SET posthog_host = $1 WHERE id = $2',
          [host, tenantId]
        );
        return truncate(`PostHog ホストを ${host} に設定しました`);
      } catch (err) {
        logger.warn('[actionExecutor] set_posthog failed', err);
        return truncate('PostHog ホストの設定に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // set_faq_published と同じ理由(reversibleだが顧客への露出・セキュリティ境界に
    // 直接影響する)で confirmed を要求する。add_faq のような単純な設定値追加より
    // 一段重い扱い。
    case 'update_allowed_origins': {
      const action = args['action'];
      const origin = typeof args['origin'] === 'string' ? args['origin'].trim() : '';
      const confirmed = isConfirmed(args['confirmed']);

      if (action !== 'add' && action !== 'remove') {
        return truncate('action には add または remove を指定してください');
      }
      if (!origin) {
        return truncate('origin を指定してください');
      }
      if (!confirmed) {
        return truncate(
          `この変更には確認が必要です。「${origin}」を${action === 'add' ? '追加' : '削除'}してよいか、` +
          '変更後にどうなるかを含めてユーザーに提示し、同意を得てから実行してください'
        );
      }
      if (action === 'add' && !isValidOriginPattern(origin)) {
        return truncate(
          `「${origin}」は登録できない形式です。https:// で始まり、ワイルドカードを使う場合は ` +
          'https://*.example.com の形式(サブドメイン全体)のみ使用できます'
        );
      }

      try {
        const result = await db.query<{ allowed_origins: string[] | null }>(
          'SELECT allowed_origins FROM tenants WHERE id = $1',
          [tenantId]
        );
        if (result.rows.length === 0) {
          return truncate('テナントが見つかりません');
        }
        const existing = result.rows[0]!.allowed_origins ?? [];

        if (action === 'add') {
          if (existing.includes(origin)) {
            return truncate(
              `「${origin}」は既に登録されています。現在の登録(${existing.length}件): ${existing.join(', ')}`
            );
          }
          if (existing.length >= 20) {
            return truncate('登録できるドメインは最大20件です。不要なものを削除してから追加してください');
          }
          const next = [...existing, origin];
          await db.query('UPDATE tenants SET allowed_origins = $1, updated_at = NOW() WHERE id = $2', [next, tenantId]);
          return truncate(`「${origin}」を追加しました。現在の登録(${next.length}件): ${next.join(', ')}`);
        }

        // action === 'remove'
        if (!existing.includes(origin)) {
          return truncate(
            `「${origin}」は登録されていません。現在の登録: ${existing.length > 0 ? existing.join(', ') : '(登録なし)'}`
          );
        }
        const next = existing.filter((o) => o !== origin);
        await db.query('UPDATE tenants SET allowed_origins = $1, updated_at = NOW() WHERE id = $2', [next, tenantId]);
        if (next.length === 0) {
          // R3: 空配列は fail-open(全ドメイン許可)。実行結果として必ずこの文言を返す
          // (モデルが事前に警告し忘れても、結果としては必ず伝わるようにする)。
          return truncate(
            `「${origin}」を削除しました。登録が0件になったため、現在は全ドメインからの埋め込みが許可されています(制限なし)`
          );
        }
        return truncate(`「${origin}」を削除しました。現在の登録(${next.length}件): ${next.join(', ')}`);
      } catch (err) {
        logger.warn('[actionExecutor] update_allowed_origins failed', err);
        return truncate('許可ドメインの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // set_ga4_id/set_posthogと同じ低リスクの純粋な設定値(顧客には見えない、店主自身の
    // 入力支援のみ)のためconfirmedは要求しない。ただしparseOptionalTextArgは再利用しない —
    // あちらは空文字列を「未指定」に丸めるため(名前/性格を空にする正当な用途が無いとの
    // 理由)、この機能で必要な「空文字列を渡して入力例を解除する」が表現できない。
    // 「キーが存在し値が文字列」なら明示指定(空文字列も含む)、キー自体が無ければ
    // 未指定として扱う。未指定/指定済みの2状態はCOALESCEで表現できない(COALESCEの
    // NULLは「未指定」と「明示的にクリア」を区別できない)ため、admin/tenants/routes.ts の
    // PATCH /v1/admin/my-tenant と同じ動的SET句構築パターンを踏襲する。
    case 'set_faq_hints': {
      const hasQuestionHint = typeof args['question_hint'] === 'string';
      const hasAnswerHint = typeof args['answer_hint'] === 'string';
      if (!hasQuestionHint && !hasAnswerHint) {
        return truncate('question_hint か answer_hint のどちらかを指定してください');
      }
      const questionHint = hasQuestionHint
        ? (String(args['question_hint']).trim().slice(0, 200) || null)
        : undefined;
      const answerHint = hasAnswerHint
        ? (String(args['answer_hint']).trim().slice(0, 200) || null)
        : undefined;

      const setClauses: string[] = [];
      const params: unknown[] = [];
      if (questionHint !== undefined) {
        params.push(questionHint);
        setClauses.push(`faq_question_hint = $${params.length}`);
      }
      if (answerHint !== undefined) {
        params.push(answerHint);
        setClauses.push(`faq_answer_hint = $${params.length}`);
      }
      setClauses.push('updated_at = NOW()');
      params.push(tenantId);

      try {
        const result = await db.query(
          `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $${params.length}
           RETURNING faq_question_hint, faq_answer_hint`,
          params
        );
        if (result.rows.length === 0) {
          return truncate('テナントが見つかりません');
        }
        const row = result.rows[0] as { faq_question_hint: string | null; faq_answer_hint: string | null };
        return truncate(
          `FAQ入力例を更新しました。\n` +
          `• 質問欄の入力例: ${row.faq_question_hint ?? '未設定（既定の例文を表示）'}\n` +
          `• 回答欄の入力例: ${row.faq_answer_hint ?? '未設定（既定の例文を表示）'}`
        );
      } catch (err) {
        logger.warn('[actionExecutor] set_faq_hints failed', err);
        return truncate('FAQ入力例の更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_faq_list': {
      try {
        // GID 1217534700543996(D3): get_chat_sessions と同じ引数設計(limit/offset の
        // 扱い・LLM由来値のallowlist検証)を踏襲する。
        const limit = clampToolLimit(args['limit'], 10, 20);
        const rawOffset = Number(args['offset'] ?? 0);
        const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
        const search = typeof args['search'] === 'string' ? args['search'] : undefined;
        const published = parseFaqPublishedFilter(args['published']);
        const sortBy = parseFaqSortBy(args['sort_by']);
        const { column, direction } = FAQ_SORT_OPTIONS[sortBy];
        // W2-2: add_faq/update_faqと同じ検証(parseFaqCategoryArg)を再利用し、
        // カテゴリ語彙のenumを二重に持たない。
        const categoryResult = parseFaqCategoryArg(args['category']);
        if (!categoryResult.ok) {
          return truncate(categoryResult.error);
        }
        const category = categoryResult.category;

        const whereParams: unknown[] = [tenantId];
        let whereClause = 'WHERE tenant_id = $1';

        if (search) {
          // LIKE のワイルドカードを無効化し、意図しない広域一致を防ぐ（Postgres の既定エスケープ文字は \）。
          // resolveSessionByShortId と同じ規約(この関数固有。呼び出しは1箇所に限る)。
          // 例: 「50%オフ」で検索すると、エスケープ無しでは「50」+任意文字列+「オフ」に広域一致していた。
          const escapedSearch = search.replace(/[\\%_]/g, (c) => `\\${c}`);
          whereParams.push(`%${escapedSearch}%`);
          whereClause += ` AND (question ILIKE $${whereParams.length} OR answer ILIKE $${whereParams.length})`;
        }
        if (published === 'published') {
          whereClause += ' AND is_published = true';
        } else if (published === 'draft') {
          whereClause += ' AND is_published = false';
        }
        if (category) {
          whereParams.push(category);
          whereClause += ` AND category = $${whereParams.length}`;
        }

        const listParams = [...whereParams, limit, offset];
        // 表示件数(上限20)と総数(COUNT)を分けて取得する。以前は result.rows.length を
        // 「N件」として返しており、LIMIT 20 が総数の頭打ちに見えていた(#実測: 21件以上の
        // テナントで常に「20件」と誤答していた)。総数は絞り込み(search/published)適用後の値。
        const [countRes, listRes] = await Promise.all([
          db.query(
            `SELECT COUNT(*)::int AS n FROM faq_docs ${whereClause}`,
            whereParams,
          ),
          db.query(
            `SELECT id, question, answer FROM faq_docs ${whereClause} ORDER BY ${column} ${direction} ` +
            `LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
            listParams,
          ),
        ]);

        const total = Number(countRes.rows[0]?.n ?? 0);

        if (listRes.rows.length === 0) {
          if (total === 0) {
            // search 指定時のヒット0件は「FAQが登録されていない」わけではない(FAQ自体は
            // 大量にある可能性がある)。検索条件に一致するものが無いだけなので文言を分ける。
            if (search) {
              return truncate(`「${search.slice(0, 100)}」に一致する FAQ は見つかりませんでした`);
            }
            return truncate('FAQ が登録されていません');
          }
          // offset が総件数を超えている(FAQ自体は存在する)。次にどう頼めばよいかを示す。
          return truncate(
            `指定した位置には表示できるFAQがありません（全${total}件）。` +
            `offset を0から${Math.max(total - 1, 0)}の間で指定し直してください`,
          );
        }

        // anti-slop: answer は .slice(0,200) 必須 / console.log で内容出力禁止
        const lines = (listRes.rows as { id: number; question: string; answer: string }[])
          .map((r) => `[${r.id}] ${r.question} — ${r.answer.slice(0, 200)}`);
        const header = total > listRes.rows.length
          ? `FAQ 一覧（全${total}件中${listRes.rows.length}件を表示）:`
          : `FAQ 一覧（${total}件）:`;
        const hasMore = offset + listRes.rows.length < total;
        const nextHint = hasMore
          ? `\n続きを見るには offset=${offset + listRes.rows.length} で再度お尋ねください。`
          : '';
        return truncateRead(`${header}\n` + lines.join('\n') + nextHint);
      } catch (err) {
        logger.warn('[actionExecutor] get_faq_list failed', err);
        return truncate('FAQ 一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'add_faq': {
      const question = String(args['question'] ?? '').slice(0, 500);
      const answer = String(args['answer'] ?? '').slice(0, 2000);

      if (!question || !answer) {
        return truncate('question と answer は必須です');
      }
      const categoryResult = parseFaqCategoryArg(args['category']);
      if (!categoryResult.ok) {
        return truncate(categoryResult.error);
      }
      const category = categoryResult.category;

      try {
        const result = await db.query(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id, question, answer, is_published`,
          [tenantId, question, answer, category]
        );
        const row = result.rows[0] as { id: number; question: string; answer: string; is_published: boolean };

        // embedding / ES 同期（fire-and-forget）
        insertEmbeddingAsync(db, tenantId, `${row.question}\n${row.answer}`, row.id, {
          source: 'admin_agent',
          faq_id: row.id,
        });
        upsertToEsAsync(tenantId, row.id, row.question, row.answer, row.is_published);

        return truncate(`FAQ を追加しました（ID: ${row.id}）: ${row.question}`);
      } catch (err) {
        logger.warn('[actionExecutor] add_faq failed', err);
        return truncate('FAQ の追加に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'update_faq': {
      const id = Number(args['id']);
      const question = String(args['question'] ?? '').slice(0, 500);
      const answer = String(args['answer'] ?? '').slice(0, 2000);

      if (!Number.isFinite(id) || !question || !answer) {
        return truncate('id・question・answer は必須です');
      }
      const categoryResult = parseFaqCategoryArg(args['category']);
      if (!categoryResult.ok) {
        return truncate(categoryResult.error);
      }
      const category = categoryResult.category;
      // W1-2: 未指定(undefined)なら COALESCE で既存値を保持する(category と同じ作法)。
      const excludedFromSearch = parseBooleanArg(args['excluded_from_search']);

      try {
        // テナント確認
        const check = await db.query(
          'SELECT id, tenant_id FROM faq_docs WHERE id = $1',
          [id]
        );
        if (check.rows.length === 0) {
          return truncate(`FAQ（ID: ${id}）が見つかりません`);
        }
        const existing = check.rows[0] as { tenant_id: string };
        if (existing.tenant_id !== tenantId) {
          return truncate('この FAQ へのアクセス権限がありません');
        }

        // category / excludedFromSearch は未指定(null)なら COALESCE で既存値を保持する
        // (指定時のみ更新)。
        const updateResult = await db.query(
          `UPDATE faq_docs SET question = $1, answer = $2, category = COALESCE($3, category),
             is_excluded_from_search = COALESCE($4, is_excluded_from_search), updated_at = NOW()
           WHERE id = $5 AND tenant_id = $6
           RETURNING id, question, answer, is_published, is_excluded_from_search`,
          [question, answer, category, excludedFromSearch ?? null, id, tenantId]
        );
        const updated = updateResult.rows[0] as {
          id: number; question: string; answer: string; is_published: boolean;
          is_excluded_from_search: boolean | null;
        };

        // 古い embedding 削除 → 再挿入（best-effort）
        db.query(
          `DELETE FROM faq_embeddings WHERE tenant_id = $1 AND (metadata->>'faq_id')::bigint = $2`,
          [tenantId, id]
        ).catch(() => {});
        insertEmbeddingAsync(db, tenantId, `${updated.question}\n${updated.answer}`, updated.id, {
          source: 'admin_agent',
          faq_id: updated.id,
        });
        // 2026-08-25: is_excluded_from_search を渡さずに5引数で呼んでいたため、質問/回答文
        // を編集するだけの通常の更新でも、ESドキュメントの is_excluded_from_search が
        // 常にfalseへ黙って巻き戻っていた(set_faq_publishedは既に正しく引き継いでいる。
        // W1-2実装中に既存バグとして発見。DB側の値は正しいままだったため実害はES検索結果
        // のみに限定される)。set_faq_published と同じ理由で引き継ぐ。
        upsertToEsAsync(
          tenantId,
          updated.id,
          updated.question,
          updated.answer,
          updated.is_published,
          updated.is_excluded_from_search ?? false
        );

        const excludedNote = excludedFromSearch !== undefined
          ? `（検索対象: ${updated.is_excluded_from_search ? '除外中' : '含める'}）`
          : '';
        return truncate(`FAQ（ID: ${id}）を更新しました: ${updated.question}${excludedNote}`);
      } catch (err) {
        logger.warn('[actionExecutor] update_faq failed', err);
        return truncate('FAQ の更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'delete_faq': {
      const id = Number(args['id']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate(`FAQ（ID: ${id}）の削除には確認が必要です。confirmed=true を指定して再度実行してください`);
      }

      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      try {
        const check = await db.query(
          'SELECT id, tenant_id, question FROM faq_docs WHERE id = $1',
          [id]
        );
        if (check.rows.length === 0) {
          return truncate(`FAQ（ID: ${id}）が見つかりません`);
        }
        const existing = check.rows[0] as { tenant_id: string; question: string };
        if (existing.tenant_id !== tenantId) {
          return truncate('この FAQ へのアクセス権限がありません');
        }

        await db.query(
          `DELETE FROM faq_embeddings WHERE tenant_id = $1 AND (metadata->>'faq_id')::bigint = $2`,
          [tenantId, id]
        );
        await db.query('DELETE FROM faq_docs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
        await deleteFaqFromEs(tenantId, id);

        return truncate(`FAQ（ID: ${id}）を削除しました`);
      } catch (err) {
        logger.warn('[actionExecutor] delete_faq failed', err);
        return truncate('FAQ の削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // GID 1217535151495449(D2): 公開済みFAQをチャットから止められるようにする。
    // 誤った回答をすぐ止めたいときに delete_faq(不可逆)しか選べない欠落を埋める。
    case 'set_faq_published': {
      const id = Number(args['id']);
      const published = parseBooleanArg(args['published']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate(
          `FAQ（ID: ${id}）の公開状態の変更には確認が必要です。confirmed=true を指定して再度実行してください`
        );
      }

      if (!Number.isFinite(id) || published === undefined) {
        return truncate('id・published は必須です');
      }

      try {
        // テナント越境は「不存在」側に倒す(IDの実在を漏らさない)。delete_faq/update_faq の
        // 「アクセス権限がありません」は既存の挙動として維持したまま、この新規ツールでは
        // より安全な文言に統一する(意図的な差分。既存2ツールへの遡及修正は本タスクの範囲外)。
        const check = await db.query(
          'SELECT id, tenant_id FROM faq_docs WHERE id = $1',
          [id]
        );
        const existing = check.rows[0] as { tenant_id: string } | undefined;
        if (!existing || existing.tenant_id !== tenantId) {
          return truncate(`FAQ（ID: ${id}）が見つかりません。get_faq_list で対象のFAQをご確認ください`);
        }

        const updateResult = await db.query(
          `UPDATE faq_docs SET is_published = $1, updated_at = NOW()
           WHERE id = $2 AND tenant_id = $3
           RETURNING id, question, answer, is_published, is_excluded_from_search`,
          [published, id, tenantId]
        );
        const updated = updateResult.rows[0] as {
          id: number;
          question: string;
          answer: string;
          is_published: boolean;
          is_excluded_from_search: boolean | null;
        };

        // publish_faq_drafts と同じ理由でis_excluded_from_searchを引き継ぐ
        // (検索除外中のFAQを誤ってES側で検索対象に戻さないため)。
        upsertToEsAsync(
          tenantId,
          updated.id,
          updated.question,
          updated.answer,
          updated.is_published,
          updated.is_excluded_from_search ?? false
        );

        return truncate(
          `FAQ（ID: ${id}）を${updated.is_published ? '公開' : '非公開'}にしました: ${updated.question}`
        );
      } catch (err) {
        logger.warn('[actionExecutor] set_faq_published failed', err);
        return truncate('FAQ の公開状態の変更に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // W2-1(docs/COPILOT_UI_PARITY.md §3.1 #5): T2集合の選択。delete_faq/set_faq_publishedの
    // 配列拡張ではなく独立ツールにする(confirmPolicy.tsのリスク階層が「1件の操作」として
    // 付けたhigh/mediumが、配列を受け取るようになると実態を表さなくなるため)。
    // このツール自身は絞り込みを行わない — 対象は必ず get_faq_list で事前に取得したIDを
    // 渡させることで、「絞り込み条件を変えた後に古い対象集合で実行される」事故を構造的に
    // 起こり得なくする(このツールにフィルタ引数が無いので、そもそも再現しない)。
    // 上限20件は黙って切らない(超過時は一切実行せず、分割を案内する)。
    case 'bulk_unpublish_faqs': {
      const rawIds = Array.isArray(args['ids']) ? args['ids'] : [];
      const ids = rawIds.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      const confirmed = isConfirmed(args['confirmed']);
      const MAX_BULK_FAQ_IDS = 20;

      if (ids.length === 0) {
        return truncate('ids を1件以上指定してください');
      }
      if (ids.length > MAX_BULK_FAQ_IDS) {
        return truncate(
          `一度に指定できるのは最大${MAX_BULK_FAQ_IDS}件です(${ids.length}件指定されました)。` +
          `${MAX_BULK_FAQ_IDS}件ずつに分けて依頼してください`
        );
      }
      if (!confirmed) {
        return truncate(
          `FAQ ${ids.length}件（ID: ${ids.join(', ')}）の非公開化には確認が必要です。` +
          '対象を提示のうえ、confirmed=true を指定して再度実行してください'
        );
      }

      try {
        const result = await db.query(
          `UPDATE faq_docs SET is_published = false, updated_at = NOW()
           WHERE id = ANY($1) AND tenant_id = $2
           RETURNING id, question, answer, is_excluded_from_search`,
          [ids, tenantId]
        );
        const updated = result.rows as {
          id: number; question: string; answer: string; is_excluded_from_search: boolean | null;
        }[];
        // set_faq_publishedと同じ理由でis_excluded_from_searchを引き継ぐ(件数分)。
        for (const row of updated) {
          upsertToEsAsync(tenantId, row.id, row.question, row.answer, false, row.is_excluded_from_search ?? false);
        }
        const missing = ids.length - updated.length;
        const missingNote = missing > 0 ? `（${missing}件は見つからないか対象外でした）` : '';
        return truncate(`FAQ ${updated.length}件を非公開にしました${missingNote}`);
      } catch (err) {
        logger.warn('[actionExecutor] bulk_unpublish_faqs failed', err);
        return truncate('一括非公開に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // W2-1続き: 削除版。delete_faqと同じ不可逆な破棄のためhigh。設計はbulk_unpublish_faqsと同じ。
    case 'bulk_delete_faqs': {
      const rawIds = Array.isArray(args['ids']) ? args['ids'] : [];
      const ids = rawIds.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      const confirmed = isConfirmed(args['confirmed']);
      const MAX_BULK_FAQ_IDS = 20;

      if (ids.length === 0) {
        return truncate('ids を1件以上指定してください');
      }
      if (ids.length > MAX_BULK_FAQ_IDS) {
        return truncate(
          `一度に指定できるのは最大${MAX_BULK_FAQ_IDS}件です(${ids.length}件指定されました)。` +
          `${MAX_BULK_FAQ_IDS}件ずつに分けて依頼してください`
        );
      }
      if (!confirmed) {
        return truncate(
          `FAQ ${ids.length}件（ID: ${ids.join(', ')}）の削除には確認が必要です。この操作は元に戻せません。` +
          '対象を提示のうえ、confirmed=true を指定して再度実行してください'
        );
      }

      try {
        await db.query(
          `DELETE FROM faq_embeddings WHERE tenant_id = $1 AND (metadata->>'faq_id')::bigint = ANY($2)`,
          [tenantId, ids]
        );
        const result = await db.query(
          'DELETE FROM faq_docs WHERE id = ANY($1) AND tenant_id = $2 RETURNING id',
          [ids, tenantId]
        );
        const deletedIds = (result.rows as { id: number }[]).map((r) => r.id);
        for (const deletedId of deletedIds) {
          await deleteFaqFromEs(tenantId, deletedId);
        }
        const missing = ids.length - deletedIds.length;
        const missingNote = missing > 0 ? `（${missing}件は見つからないか対象外でした）` : '';
        return truncate(`FAQ ${deletedIds.length}件を削除しました${missingNote}`);
      } catch (err) {
        logger.warn('[actionExecutor] bulk_delete_faqs failed', err);
        return truncate('一括削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 新規テナントのオンボーディング(GID 1216274591838389のチャット版):
    // 業種別FAQたたき台を一括登録し、旧UI(OnboardingModal)と同じ条件で
    // onboarding_completed_at を更新する(業種選択のみで完了扱いになる仕様を踏襲)。
    //
    // Asana 1217040715802747(P3): テンプレは内容未確認のまま即座にエンドユーザーへ
    // 回答され得たため、is_published=false(下書き)で投入する。公開は別ツール
    // publish_faq_drafts でユーザーが内容を確認してから行う。onboarding_completed_at の
    // 更新条件は変えない(業種選択のみで完了扱いにする既存仕様をそのまま踏襲)。
    case 'import_industry_faq_templates': {
      const industryRaw = args['industry'];
      if (!isOnboardingIndustry(industryRaw)) {
        return truncate(`不明な業種です: ${String(industryRaw)}`);
      }
      const confirmed = isConfirmed(args['confirmed']);
      const templates = INDUSTRY_FAQ_TEMPLATES[industryRaw];
      const label = ONBOARDING_INDUSTRY_LABELS[industryRaw];

      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      if (!confirmed) {
        // オンボ 是正A-2: 業種の回答自体はここで確定させる(FAQ投入とは別の関心事のため
        // 確認ゲートの対象外)。保存しないと「あとで」を選んだユーザーに次回ログインでも
        // 「初めまして」の挨拶が再生され続ける(要件§0.2の既知バグ)。
        db.query(
          `UPDATE tenants SET onboarding_industry = $1 WHERE id = $2`,
          [industryRaw, tenantId],
        ).catch((err) => {
          logger.warn('[actionExecutor] import_industry_faq_templates industry save failed', err);
        });

        const lines = templates.map((t, i) => `${i + 1}. Q: ${t.question} / A: ${t.answer}`);
        return truncate(
          `「${label}」向けのFAQたたき台を${templates.length}件ご用意しました:\n` +
          lines.join('\n') +
          `\nよろしければ登録しますか？（下書きとして登録し、内容を確認してから公開できます）`,
        );
      }

      try {
        // オンボ 是正D-1: 生INSERTで既存質問との重複判定を一切していなかったため、
        // 業種チップ連打・2業種連続選択・「登録して」の複数回送信で同じテンプレが
        // 素直に二重登録されていた(X-2)。commitTextFaqs が使う既存の重複判定
        // (bigram類似度)をここでも通す。
        const existingQuestionsAtCommit = await fetchExistingQuestions(db, tenantId);
        let inserted = 0;
        let skipped = 0;
        for (const t of templates) {
          const isDuplicate = existingQuestionsAtCommit.some(
            (q) => bigramSimilarity(t.question, q) >= DUPLICATE_THRESHOLD,
          );
          if (isDuplicate) {
            skipped++;
            continue;
          }
          try {
            const result = await db.query(
              `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
               VALUES ($1, $2, $3, $4, false)
               RETURNING id, question, answer, is_published`,
              [tenantId, t.question, t.answer, t.category ?? 'general'],
            );
            const row = result.rows[0] as { id: number; question: string; answer: string; is_published: boolean };
            insertEmbeddingAsync(db, tenantId, `${row.question}\n${row.answer}`, row.id, {
              source: 'admin_agent_onboarding',
              faq_id: row.id,
            });
            upsertToEsAsync(tenantId, row.id, row.question, row.answer, row.is_published);
            existingQuestionsAtCommit.push(row.question);
            inserted++;
          } catch (err) {
            logger.warn('[actionExecutor] import_industry_faq_templates insert failed', err);
          }
        }

        // オンボ 是正A-2: 0件成功なら段階を進めない(要件どおり「登録しました」を返さない)。
        // 以前はinsertedの値に関わらずUPDATEと成功文言を返しており、全INSERT失敗時でも
        // industryAnswered=trueかつ下書き0件のまま stage2 で永久にループしていた。
        // 全件が重複スキップだった場合も同様に扱う(段階は既に進んでいるはずのため)。
        if (inserted === 0) {
          if (skipped > 0) {
            return truncate(
              `「${label}」向けのFAQはすべて登録済みでした(重複のため${skipped}件をスキップしました)。`,
            );
          }
          return truncate(
            `「${label}」向けのFAQの登録に失敗しました。時間をおいてもう一度お試しください。`,
          );
        }

        await db.query(
          `UPDATE tenants SET onboarding_industry = $1, onboarding_completed_at = NOW() WHERE id = $2`,
          [industryRaw, tenantId],
        ).catch((err) => {
          logger.warn('[actionExecutor] import_industry_faq_templates onboarding update failed', err);
        });

        return truncate(
          `「${label}」向けのFAQを${inserted}件、下書きとして登録しました。` +
          `内容をご確認のうえ、よろしければ公開しますか？（公開後も自由に編集・非公開に戻せます）`,
        );
      } catch (err) {
        logger.warn('[actionExecutor] import_industry_faq_templates failed', err);
        return truncate('FAQテンプレートの登録に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Asana 1217040715802747(P3): 下書き(is_published=false)のFAQを内容確認のうえ公開する。
    // オンボーディング由来に限定しない(docs/ONBOARDING_FIRST_LOGIN.md §3.1③ 決定1: 知識公開済み
    // 段階はテナント全体の is_published=true 件数で判定するため、出自を問う必要がない)。
    // 一度に最大20件(一覧提示と実際の公開対象を同じ集合に揃え、表示件数と実件数の不一致を防ぐ)。
    case 'publish_faq_drafts': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        try {
          // オンボ 是正D-1: LIMIT 20 のsilent cap対策。25件あっても「20件あります」とだけ
          // 表示すると実数と食い違う(CLAUDE.mdの「silent capを作らない」方針に反する)ため、
          // 総件数を別途取得して超過分を明示する。
          const [draftResult, countResult] = await Promise.all([
            db.query(
              `SELECT id, question, answer FROM faq_docs WHERE tenant_id = $1 AND is_published = false ORDER BY id DESC LIMIT 20`,
              [tenantId],
            ),
            db.query(
              `SELECT COUNT(*)::int AS cnt FROM faq_docs WHERE tenant_id = $1 AND is_published = false`,
              [tenantId],
            ),
          ]);
          const drafts = draftResult.rows as { id: number; question: string; answer: string }[];
          const totalDrafts = (countResult.rows[0] as { cnt: number } | undefined)?.cnt ?? drafts.length;
          if (drafts.length === 0) {
            return truncate('公開できる下書きのFAQはありません');
          }
          const lines = drafts.map((d, i) => `${i + 1}. Q: ${d.question} / A: ${d.answer}`);
          const countLine = totalDrafts > drafts.length
            ? `下書き（未公開）のFAQが総${totalDrafts}件あります。うち新しい${drafts.length}件:\n`
            : `下書き（未公開）のFAQが${drafts.length}件あります:\n`;
          return truncate(
            countLine +
            lines.join('\n') +
            `\nよろしければ公開しますか？（公開後も自由に編集・非公開に戻せます）`,
          );
        } catch (err) {
          logger.warn('[actionExecutor] publish_faq_drafts list failed', err);
          return truncate('下書きの取得に失敗しました');
        }
      }

      try {
        // オンボ 是正D-1: 確認時の一覧提示と同じ ORDER BY id DESC(新しい順)に揃える。
        // ASC(古い順)のままだと、既存テナントが使った場合に「意図的に非公開のままに
        // していた古いFAQ」が新しいオンボ由来の下書きより先に公開されてしまう。
        //
        // TOCTOU(確認時の一覧と実際の公開対象の集合が完全一致する保証が無い)は既知の
        // トレードオフとして残す: 対象IDをLLM往復で固定する設計は、このツールが意図的に
        // TTLステージングを持たない設計(X-10、docs/ONBOARDING_FIRST_LOGIN.md)と衝突し、
        // LLMがID配列を正しく往復できない場合に誤動作するリスクの方が大きいと判断した。
        const result = await db.query(
          `UPDATE faq_docs SET is_published = true, updated_at = NOW()
           WHERE id IN (
             SELECT id FROM faq_docs WHERE tenant_id = $1 AND is_published = false ORDER BY id DESC LIMIT 20
           )
           RETURNING id, question, answer, is_excluded_from_search`,
          [tenantId],
        );
        const rows = result.rows as { id: number; question: string; answer: string; is_excluded_from_search: boolean | null }[];
        for (const row of rows) {
          // オンボ 是正A-3: is_excluded_from_search を引き継がないと、意図的に検索除外
          // していた下書きを公開した際にESドキュメントがfalseで上書きされ、Phase69-2
          // PR-C2のES永続フィルタ層が無効化される(faqCrudRoutes.tsの一括公開と揃える)。
          upsertToEsAsync(tenantId, row.id, row.question, row.answer, true, row.is_excluded_from_search ?? false);
        }
        if (rows.length === 0) {
          return truncate('公開できる下書きのFAQはありません');
        }
        // オンボ 是正D-1: 残件数を明示する(公開後も「20件公開しました」だけでは
        // 残りの下書きの存在が伝わらない)。
        const remainingResult = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM faq_docs WHERE tenant_id = $1 AND is_published = false`,
          [tenantId],
        ).catch(() => null);
        const remaining = (remainingResult?.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
        return truncate(
          remaining > 0
            ? `${rows.length}件のFAQを公開しました(残り${remaining}件は次回以降に公開できます)`
            : `${rows.length}件のFAQを公開しました`,
        );
      } catch (err) {
        logger.warn('[actionExecutor] publish_faq_drafts failed', err);
        return truncate('FAQの公開に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_avatar_status': {
      try {
        const tenantRes = await db.query(
          `SELECT features->>'avatar' AS avatar_enabled FROM tenants WHERE id = $1`,
          [tenantId],
        );
        if (tenantRes.rows.length === 0) {
          return truncate('テナント設定が見つかりません');
        }
        const enabled = (tenantRes.rows[0] as { avatar_enabled: string | null }).avatar_enabled === 'true';
        if (!enabled) {
          return truncate('アバターは現在無効です');
        }
        const activeRes = await db.query(
          `SELECT id, name FROM avatar_configs WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId],
        );
        const active = activeRes.rows[0] as { id: string; name: string } | undefined;
        return truncate(
          active
            ? `アバターは有効です（稼働中の設定: ${active.name}）`
            : 'アバターは有効ですが、稼働中の設定がありません',
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_avatar_status failed', err);
        return truncate('アバター状況の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 一覧が無いと activate_avatar は「ID を知っている人しか使えない」ツールになるため、
    // 切替の前段としてここで ID を提示する。
    // 既定アバター(tenant_id='r2c_default')は avatar_configs の部分unique制約から
    // 除外されており全行 is_active = true なので、is_active だけで稼働中を判定すると
    // 見本18体がすべて「稼働中」に見える。稼働中の判定は自テナント行に限る。
    case 'get_avatar_list': {
      try {
        const res = await db.query(
          `SELECT id, name, is_active, is_default, tenant_id
             FROM avatar_configs
            WHERE tenant_id = $1 OR tenant_id = 'r2c_default'
            ORDER BY (tenant_id = $1) DESC, is_default ASC, created_at DESC`,
          [tenantId],
        );
        const rows = res.rows as { id: string; name: string; is_active: boolean; is_default: boolean; tenant_id: string }[];
        if (rows.length === 0) {
          return truncate('アバター設定はまだありません');
        }

        // reset_avatar_to_default が成功するのは「自テナント かつ is_default=true」の行だけ
        // （下の case のガード参照）。一覧の印はその条件と完全に一致させる。r2c_default
        // 所属行は reset の対象外（越境）なので、「既定」を含まない別語彙にして、
        // 一覧とツールで「既定の見本」の意味が食い違わないようにする。
        const lines = rows.map((row) => {
          const own = row.tenant_id === tenantId;
          if (!own) return `- ${row.name}（R2C提供の見本） ID: ${row.id}`;
          const parts: string[] = [];
          if (row.is_active) parts.push('稼働中');
          if (row.is_default) parts.push('既定に戻せます');
          const mark = parts.length > 0 ? `（${parts.join('・')}）` : '';
          return `- ${row.name}${mark} ID: ${row.id}`;
        });

        // このツールには get_faq_list と違い limit/offset/search が無く、絞り込めない
        // （toolDefinitions.ts の parameters 参照）。truncateRead の汎用注記
        // 「絞り込み条件やページを変えて」はこのツールには実行不能な案内になるため使わない。
        // 行の途中では切らず、実際に表示した件数を必ず残す
        // （src/api/admin/CLAUDE.md: 打ち切るなら「全N件中M件」を必ず残し、黙って切らない）。
        // 予算は truncateRead と同じ READ_RESULT_MAX_CHARS を使い、新しい予算は作らない。
        // header は打ち切り判定と実際の返却値の両方から呼び、文言を1箇所に保つ。
        const header = (shownCount: number): string =>
          shownCount < rows.length
            ? `アバター設定は全${rows.length}件中${shownCount}件を表示しています` +
              '（このツールに絞り込み条件が無いため、残りはこの一覧には出せません）:\n'
            : `アバター設定は${rows.length}件あります:\n`;

        let used = header(0).length;
        let shown = 0;
        for (const line of lines) {
          const next = used + line.length + 1;
          if (next > READ_RESULT_MAX_CHARS) break;
          used = next;
          shown++;
        }
        const shownLines = shown === rows.length ? lines : lines.slice(0, shown);
        // truncateRead は上のループで既に予算内に収めているため通常は no-op だが、
        // 行単位の見積もりがズレた場合の保険として最後に一度だけ掛ける。
        return truncateRead(`${header(shown)}${shownLines.join('\n')}`);
      } catch (err) {
        logger.warn('[actionExecutor] get_avatar_list failed', err);
        return truncate('アバター一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'activate_avatar': {
      const id = String(args['id'] ?? '');
      if (!id) {
        return truncate('id は必須です');
      }

      // GID: LP料金表(Growth〜: AIアバター)に基づくプラン制限。
      // tenants/routes.ts の features.avatar 更新チェックと同じ基準をここでも適用する
      // （AIエージェント経由でのチャットからのアクティベートがプラン制限を素通りしないように）。
      // 注入済みの db を使う（tenantHasFeature 経由だと内部で getPool() の実Poolを
      // 使ってしまい、テストのモックPoolと食い違って汚染するため queryTenantPlan を直接使う）。
      const plan = await queryTenantPlan(db, tenantId);
      if (!planHasFeature(plan, 'avatar')) {
        return truncate(planLimitNotice(tenantId, sessionId, 'avatar'));
      }

      const client = await db.connect();
      try {
        const res = await activateAvatarConfig(client, id, tenantId);
        if (!res.ok) {
          // 見つからない原因の大半はIDの取り違え。次の一手（一覧で確認）を示す。
          return truncate(
            `アバターの有効化に失敗しました: ${res.error ?? '不明なエラー'}。get_avatar_list で ID を確認してください`,
          );
        }
        return truncate(`アバター（ID: ${id}）を有効化しました`);
      } catch (err) {
        // 不正な形式のID（UUIDでない文字列）もここに来る。500にはせず日本語で返す。
        logger.warn('[actionExecutor] activate_avatar failed', err);
        return truncate('アバターの有効化に失敗しました。get_avatar_list で ID を確認してください');
      } finally {
        client.release();
      }
    }

    // -----------------------------------------------------------------------
    // 既定アバター(is_default)は全テナント共通の見本で、常に is_active = true の
    // 前提で運用されている（部分unique制約から除外されている）。停止対象から外す。
    case 'deactivate_avatar': {
      try {
        const res = await db.query(
          `UPDATE avatar_configs SET is_active = false
            WHERE tenant_id = $1 AND is_active = true AND (is_default = false OR is_default IS NULL)
            RETURNING name`,
          [tenantId],
        );
        const stopped = res.rows as { name: string }[];
        if (stopped.length === 0) {
          return truncate('稼働中のアバターはありません');
        }
        const names = stopped.map((r) => `「${r.name}」`).join('');
        return truncate(
          `アバター${names}を停止しました。ウィジェットにアバターは表示されなくなります。` +
          '再開したいときは activate_avatar で同じ設定を有効化できます',
        );
      } catch (err) {
        logger.warn('[actionExecutor] deactivate_avatar failed', err);
        return truncate('アバターの停止に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // W1-4(docs/COPILOT_UI_PARITY.md §3.1 #4): 不可逆な破棄のためhighリスク・confirmed必須。
    // 稼働中(is_active)の設定を削除させない制約は admin/avatar/routes.ts の
    // DELETE /v1/admin/avatar/configs/:id と同じ(client_adminは403相当で拒否)。
    // 削除後にアクティブな設定が0件になった場合 features.avatar を false に同期する後処理も
    // 同ルートと同じ。routes.ts側のハンドラは再利用可能な関数として切り出されておらず、
    // activate_avatar/deactivate_avatarと同様にここでも同じロジックを直接持つ(既存の
    // パターンを踏襲。切り出しは本タスクの範囲外)。
    case 'delete_avatar_config': {
      const id = String(args['id'] ?? '');
      const confirmed = isConfirmed(args['confirmed']);

      if (!id) {
        return truncate('id は必須です');
      }
      if (!confirmed) {
        return truncate('アバター設定の削除には確認が必要です。confirmed=true を指定して再度実行してください');
      }

      try {
        const existing = await db.query(
          'SELECT name, is_active FROM avatar_configs WHERE id = $1 AND tenant_id = $2',
          [id, tenantId]
        );
        if (existing.rows.length === 0) {
          return truncate('アバター設定が見つかりません。get_avatar_list で ID を確認してください');
        }
        const target = existing.rows[0] as { name: string; is_active: boolean };
        if (target.is_active) {
          return truncate(
            `「${target.name}」は現在稼働中のため削除できません。先に activate_avatar で別の設定に` +
            '切り替えるか、set_avatar_feature でアバター機能自体を停止してから削除してください'
          );
        }

        await db.query('DELETE FROM avatar_configs WHERE id = $1 AND tenant_id = $2', [id, tenantId]);

        const remaining = await db.query(
          'SELECT COUNT(*) AS count FROM avatar_configs WHERE tenant_id = $1 AND is_active = true',
          [tenantId]
        );
        if (parseInt(remaining.rows[0]!.count as string, 10) === 0) {
          await db.query(
            `UPDATE tenants SET features = jsonb_set(COALESCE(features, '{}'), '{avatar}', 'false') WHERE id = $1`,
            [tenantId]
          );
        }

        return truncate(`アバター設定「${target.name}」を削除しました`);
      } catch (err) {
        logger.warn('[actionExecutor] delete_avatar_config failed', err);
        return truncate('アバター設定の削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // GID 1217535352042856(E1): アバター機能のマスターON/OFF(tenants.features.avatar)を
    // チャットから行えるようにする。activate_avatar は avatar_configs.is_active しか触らず、
    // 旧UIの AvatarFeatureToggle(client_admin専用)にしかこのフラグを変える手段が無かった
    // ため、プラン契約済みでも features.avatar が false のテナントはチャットだけでは
    // アバターを出せなかった(オンボーディングが途中で旧UIに落ちる原因)。
    case 'set_avatar_feature': {
      const enabled = parseBooleanArg(args['enabled']);
      const confirmed = isConfirmed(args['confirmed']);

      if (enabled === undefined) {
        return truncate('enabled は必須です');
      }
      if (!confirmed) {
        return truncate(
          `アバター機能を${enabled ? 'ON' : 'OFF'}にするには確認が必要です。confirmed=true を指定して再度実行してください`,
        );
      }

      // 実機照合(2026-08-18): PATCH /v1/admin/my-tenant はONにする(true)ときだけプラン判定を
      // 行い、OFF(false)には掛けない。両方向を塞ぐと、契約を切ったテナントが「ONのまま
      // 消せない」状態に陥る。ここも同じ非対称にする。
      // 注入済みの db を使う（tenantHasFeature 経由だと内部で getPool() の実Poolを
      // 使ってしまい、テストのモックPoolと食い違って汚染するため queryTenantPlan を直接使う）。
      if (enabled) {
        const plan = await queryTenantPlan(db, tenantId);
        if (!planHasFeature(plan, 'avatar')) {
          return truncate(planLimitNotice(tenantId, sessionId, 'avatar'));
        }
      }

      try {
        // features は他のフラグ(voice/rag等)も持つJSONBのため、avatarキーだけを
        // マージで上書きする(my-tenantハンドラと同じ形。他のフラグを消さない)。
        const result = await db.query(
          `UPDATE tenants SET features = COALESCE(features, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
           WHERE id = $2
           RETURNING id`,
          [JSON.stringify({ avatar: enabled }), tenantId],
        );
        if (result.rowCount === 0) {
          return truncate('テナントが見つかりません');
        }
        return truncate(`アバター機能を${enabled ? 'ON' : 'OFF'}にしました`);
      } catch (err) {
        logger.warn('[actionExecutor] set_avatar_feature failed', err);
        return truncate('アバター機能の切り替えに失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // GID 1216978677372391(PR-16, D1) / 共有学習プールの参加モデル S4:
    // データ利用同意の2軸化。
    // ①自テナント内学習(learned_memory等)は learn が表す(データは外に出ない)。
    // ②共有プール参加(R2C共有プールに出し、かつ読む。外部Hermes VPSへ出る)は share が表す。
    // 新形式は tenants.features.learning = {learn, share}
    // (src/lib/hermesConsent.ts の resolveLearningConsent が読む形と一致させる)。
    // 旧フラグ features.hermes_raw_data_consent はここでは書かない(読み取り専用の
    // 後方互換経路として resolveLearningConsent 側にのみ残す)。
    // 旧UI(/admin/avatar のHermesConsentToggle)は2026-10-13まで閉鎖観察中のため、
    // 閉鎖後もチャットから同意操作ができるようにこのツールを新設した(コメントは新設時のまま)。
    case 'set_hermes_consent': {
      const learnArg = parseBooleanArg(args['learn']);
      const shareArgRaw = parseBooleanArg(args['share']);
      // 後方互換: 旧セッションが enabled(boolean)だけを送ってくる場合は share として解釈する。
      const enabledArg = parseBooleanArg(args['enabled']);
      const shareArg = shareArgRaw !== undefined ? shareArgRaw : enabledArg;

      if (learnArg === undefined && shareArg === undefined) {
        return truncate('learn または share(もしくは旧enabled)のいずれかを指定してください');
      }

      const confirmed = isConfirmed(args['confirmed']);
      if (!confirmed) {
        const parts: string[] = [];
        if (learnArg !== undefined) parts.push(`learn=${learnArg ? 'ON' : 'OFF'}`);
        if (shareArg !== undefined) parts.push(`share=${shareArg ? 'ON' : 'OFF'}`);
        return truncate(
          `学習設定(${parts.join('、')})を変更するには確認が必要です。confirmed=true を指定して再度実行してください`,
        );
      }

      try {
        // 指定されなかった軸は現在値を維持する。features の learning キー自体は
        // JSONBのトップレベルマージでは部分更新できない({learn, share}を毎回フルで
        // 書き直す必要がある)ため、先に現在値を読む。
        // 注入済みの db を直接読む(resolveLearningConsent を呼ぶと内部で getPool() の
        // 実Poolを使ってしまい、テストのモックPoolと食い違って汚染するため。
        // queryTenantPlan を直接使っている activate_avatar / set_avatar_feature と同じ理由)。
        const currentRes = await db.query<{
          features: { learning?: unknown; hermes_raw_data_consent?: boolean } | null;
        }>(`SELECT features FROM tenants WHERE id = $1`, [tenantId]);
        if (currentRes.rowCount === 0) {
          return truncate('テナントが見つかりません');
        }
        const currentFeatures = currentRes.rows[0]?.features ?? {};
        const currentLearning = currentFeatures.learning;
        const current =
          typeof currentLearning === 'object' &&
          currentLearning !== null &&
          !Array.isArray(currentLearning) &&
          typeof (currentLearning as Record<string, unknown>)['learn'] === 'boolean' &&
          typeof (currentLearning as Record<string, unknown>)['share'] === 'boolean'
            ? {
                learn: (currentLearning as Record<string, unknown>)['learn'] as boolean,
                share: (currentLearning as Record<string, unknown>)['share'] as boolean,
              }
            // 新形式未設定の場合の後方互換解決(learn=true固定、shareは旧フラグから)は
            // resolveLearningConsent と同じルール(src/lib/hermesConsent.ts 参照)。
            : { learn: true, share: currentFeatures.hermes_raw_data_consent === true };

        const nextLearn = learnArg !== undefined ? learnArg : current.learn;
        const nextShare = shareArg !== undefined ? shareArg : current.share;

        // G3: learn=false かつ share=true は不整合として拒否する
        // (learningConsentSchema の refine と同じルール。src/api/admin/tenants/routes.ts 参照)。
        if (nextLearn === false && nextShare === true) {
          return truncate(
            'learn=OFF(自社内学習なし)のまま share=ON(共有プールへ提供)にはできません。' +
              '先に learn をONにするか、share の指定を外してください',
          );
        }

        // 広告プラン(free_ad、確実に判定できた場合のみ)は share 強制ON。
        // ★fail-safeの向きが反転する: 判定不能(DB障害・未知プラン)時は強制しない★
        // (src/lib/billing/planFeatures.ts の resolveShareForPlan 参照。
        // queryTenantPlan の fail-safe=free_ad にここで相乗りすると、DB障害時に
        // 全テナントの share=OFF操作が拒否される=実質強制ONになってしまう)。
        if (shareArg === false) {
          const shareForPlan = await resolveShareForTenantPlan(db, tenantId);
          if (shareForPlan.forced) {
            return truncate('広告プランでは共有が必須です。有料プランへの変更が必要です');
          }
        }

        // features は他のフラグ(avatar/voice等)も持つJSONBのため、learningキーだけを
        // マージで上書きする(set_avatar_feature / my-tenantハンドラと同じ形。
        // 他のフラグを消さない)。
        const result = await db.query(
          `UPDATE tenants SET features = COALESCE(features, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
           WHERE id = $2
           RETURNING id`,
          [JSON.stringify({ learning: { learn: nextLearn, share: nextShare } }), tenantId],
        );
        if (result.rowCount === 0) {
          return truncate('テナントが見つかりません');
        }
        return truncate(
          `学習設定を更新しました(learn=${nextLearn ? 'ON' : 'OFF'}、share=${nextShare ? 'ON' : 'OFF'})。` +
            (nextShare
              ? ''
              : ' 共有プールへの新規データ提供は今後止まりますが、提供済みのデータは取り消せません'),
        );
      } catch (err) {
        logger.warn('[actionExecutor] set_hermes_consent failed', err);
        return truncate('データ提供同意の切り替えに失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // GID 1217536929600059(E2): アバターの基本設定（名前・性格・話し方）をチャットで
    // 直せるようにする。既定の見本(is_default=true)は全テナント共通のひな形のため
    // 更新対象から除外する — deactivate_avatar と同じガードの考え方（同コメント参照）。
    // 実装照合(2026-08-18): reset_avatar_to_default とはガードの向きが逆になる
    // （reset は is_default=true を要求する既定アバター専用の操作。routes.ts:700-745）。
    case 'update_avatar_profile': {
      const id = String(args['id'] ?? '');
      if (!id) {
        return truncate('id は必須です。get_avatar_list で対象の ID を確認してください');
      }
      const confirmed = isConfirmed(args['confirmed']);
      if (!confirmed) {
        return truncate('基本設定の更新には確認が必要です。confirmed=true を指定して再度実行してください');
      }

      // '' は「未指定」として扱う（parseOptionalTextArg のコメント参照）。
      // typeof で判定していた頃は name:'' でアバター名が空に上書きされた。
      const name = parseOptionalTextArg(args['name']);
      const personalityPrompt = parseOptionalTextArg(args['personality_prompt']);
      const behaviorDescription = parseOptionalTextArg(args['behavior_description']);

      const sets: string[] = [];
      const values: unknown[] = [];
      if (name !== undefined) {
        values.push(name);
        sets.push(`name = $${values.length}`);
      }
      if (personalityPrompt !== undefined) {
        values.push(personalityPrompt);
        sets.push(`personality_prompt = $${values.length}`);
      }
      if (behaviorDescription !== undefined) {
        values.push(behaviorDescription);
        sets.push(`behavior_description = $${values.length}`);
      }
      if (sets.length === 0) {
        return truncate('更新する項目がありません。name / personality_prompt / behavior_description のいずれかを指定してください');
      }

      values.push(id, tenantId);
      const idPlaceholder = values.length - 1;
      const tenantPlaceholder = values.length;

      try {
        const result = await db.query(
          `UPDATE avatar_configs
              SET ${sets.join(', ')}, updated_at = NOW()
            WHERE id = $${idPlaceholder} AND tenant_id = $${tenantPlaceholder}
              AND (is_default = false OR is_default IS NULL)
          RETURNING name`,
          values,
        );
        const updated = result.rows[0] as { name: string } | undefined;
        if (!updated) {
          return truncate('指定のアバター設定が見つかりませんでした。get_avatar_list で ID を確認してください');
        }
        return truncate(`アバター「${updated.name}」の基本設定を更新しました`);
      } catch (err) {
        logger.warn('[actionExecutor] update_avatar_profile failed', err);
        return truncate('アバターの基本設定の更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // GID 1217536929600059(E2): 既定の見本(is_default=true)を作成時点の値に戻す。
    // POST /v1/admin/avatar/configs/:id/reset-to-default（routes.ts:700-745）と
    // 同じ処理をここに再実装する。Wave 0 調査2の結論: ルートハンドラは
    // extractAuth(req)/res.status().json() に密結合で純関数として切り出されておらず、
    // 既存のアバター系エージェントツールもすべて actionExecutor 側で生SQLを直書きして
    // いる（ルートハンドラを再利用した前例が無い）ため、ここだけ別方式にすると読み手が
    // 経路を2つ追うことになる。したがって再利用はせず、同等ロジックをここに書く。
    // 既定値の取得元はルートと同じ「同一行の default_voice_id / default_personality_prompt /
    // default_name の3列」のみ（phase44_default_avatars.sql）。復元する列を増やさない。
    //
    // 実機照合(2026-08-18): 下のSELECTは他ツール（activate_avatar 等）と同じく
    // tenant_id = 呼び出し元テナント で絞っている。tenants/routes.ts:352-380 の
    // テナント作成時シードは今も is_default=true を自テナントの tenant_id で18体作る
    // ため、これは「対象が見つからない」を返し続けるツールではない — 自テナントの
    // シード済み見本に対しては成功する（get_avatar_list の「（既定に戻せます）」印と
    // 揃えたのはこの行）。'r2c_default' テナント所属行（Phase66 で追加された、
    // 全テナント共有の別プール）はここでは対象外のまま（越境）。対案は
    // tenant_id = 'r2c_default' も許容すること（suggest_avatar_preset/adopt_avatar_preset
    // と同じ形）だが、それは「どのテナントのチャットからでも全テナント共有の見本を
    // 書き換えられる」という、本タスクの本文が明示的に許可していない越境操作を
    // 新設することになるため、独断で変更しない。
    case 'reset_avatar_to_default': {
      const id = String(args['id'] ?? '');
      if (!id) {
        return truncate('id は必須です。get_avatar_list で対象の ID を確認してください');
      }
      const confirmed = isConfirmed(args['confirmed']);
      if (!confirmed) {
        return truncate('既定に戻すには確認が必要です。confirmed=true を指定して再度実行してください');
      }

      try {
        const existing = await db.query(
          `SELECT is_default FROM avatar_configs WHERE id = $1 AND tenant_id = $2`,
          [id, tenantId],
        );
        const row = existing.rows[0] as { is_default: boolean } | undefined;
        if (!row) {
          return truncate('指定のアバター設定が見つかりませんでした。get_avatar_list で ID を確認してください');
        }
        // 既定アバター専用の操作。テナント自身が作成・採用したアバターは対象外
        // （routes.ts:725-727 の 404 相当。ただしチャットではエラーにせず次の行動が
        // 分かる日本語1行で返す）。
        if (!row.is_default) {
          return truncate('既定に戻せるのは、一覧で「既定に戻せます」と表示された設定だけです。get_avatar_list でご確認ください');
        }

        const result = await db.query(
          `UPDATE avatar_configs
              SET voice_id = default_voice_id,
                  personality_prompt = default_personality_prompt,
                  name = default_name,
                  updated_at = NOW()
            WHERE id = $1
          RETURNING name`,
          [id],
        );
        const updated = result.rows[0] as { name: string } | undefined;
        if (!updated) {
          return truncate('既定に戻す処理に失敗しました');
        }
        return truncate(`アバター「${updated.name}」を既定の設定に戻しました`);
      } catch (err) {
        logger.warn('[actionExecutor] reset_avatar_to_default failed', err);
        return truncate('既定に戻す処理に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // avatar_configs には業種を示す列が無く、既定の18体（見た目・性格の作り込まれた
    // 見本）は業種ごとに分類されていない。したがって「業種に合わせて選ぶ」ことはできず、
    // 業種を尋ねずに未採用の見本を1件そのまま提示する（質問0件は「選ばせない」方針にも
    // 沿う）。採用済みかどうかは avatar_configs.name の一致で判定する
    // （adopt側でdefault_template_idを引き継がないため、他に手掛かりが無い）。
    case 'suggest_avatar_preset': {
      try {
        const res = await db.query(
          `SELECT id, name, image_url, personality_prompt, default_template_id
             FROM avatar_configs
            WHERE tenant_id = 'r2c_default' AND is_default = true
            ORDER BY default_template_id ASC NULLS LAST`,
        );
        const presets = res.rows as {
          id: string; name: string; image_url: string | null;
          personality_prompt: string | null; default_template_id: string | null;
        }[];
        if (presets.length === 0) {
          return truncate('アバターの見本が見つかりませんでした');
        }

        const ownedRes = await db.query(`SELECT name FROM avatar_configs WHERE tenant_id = $1`, [tenantId]);
        const ownedNames = new Set((ownedRes.rows as { name: string }[]).map((r) => r.name));
        const preset = presets.find((p) => !ownedNames.has(p.name)) ?? presets[0]!;

        const description = (preset.personality_prompt ?? '').slice(0, 120);
        return {
          text: truncate(
            `「${preset.name}」というアバターの見本があります。\n${description}\n` +
            `プリセットID: ${preset.id}\n` +
            'このまま採用しますか？（採用後も名前・話し方はいつでも変更できます）',
          ),
          card: {
            kind: 'avatar_preset',
            presetId: preset.id,
            name: preset.name,
            imageUrl: preset.image_url,
            description,
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] suggest_avatar_preset failed', err);
        return truncate('アバター見本の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 採用は自テナントへの複製のみで、is_active はここでは変えない（公開はしない）。
    // 新規のアバターを作る/直す/出す/止めるまでの一連の流れの中で、公開は
    // activate_avatar の役割として分離する（docs/AVATAR_CHAT_MIGRATION.md §4.4）。
    case 'adopt_avatar_preset': {
      const presetId = String(args['preset_id'] ?? '');
      if (!presetId) {
        return truncate('preset_id は必須です');
      }
      const confirmed = isConfirmed(args['confirmed']);
      if (!confirmed) {
        return truncate(
          '採用には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください',
        );
      }

      try {
        const result = await db.query(
          `INSERT INTO avatar_configs
             (tenant_id, name, image_url, image_prompt, voice_id, voice_description,
              personality_prompt, behavior_description, emotion_tags, lemonslice_agent_id,
              anam_avatar_id, anam_voice_id, anam_persona_id, anam_llm_id, avatar_provider,
              is_default, is_active)
           SELECT $1, name, image_url, image_prompt, voice_id, voice_description,
                  personality_prompt, behavior_description, emotion_tags, lemonslice_agent_id,
                  anam_avatar_id, anam_voice_id, anam_persona_id, anam_llm_id, avatar_provider,
                  false, false
             FROM avatar_configs
            WHERE id = $2 AND tenant_id = 'r2c_default' AND is_default = true
           RETURNING id, name, image_url, personality_prompt`,
          [tenantId, presetId],
        );
        const created = result.rows[0] as
          { id: string; name: string; image_url: string | null; personality_prompt: string | null } | undefined;
        if (!created) {
          return truncate('指定のアバター見本が見つかりませんでした。suggest_avatar_preset で提案をやり直してください');
        }
        // card の configId は自テナント側の新規行（presetId とは別物）。
        // フロントはこの id で以降の画像候補生成・PATCHを行う。
        return {
          text: truncate(
            `アバター「${created.name}」を採用しました。まだ公開はされていません。` +
            '声・名前・話し方を調整してから activate_avatar で公開できます',
          ),
          card: {
            kind: 'avatar_adopted',
            configId: created.id,
            name: created.name,
            imageUrl: created.image_url,
            description: (created.personality_prompt ?? '').slice(0, 120),
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] adopt_avatar_preset failed', err);
        return truncate('アバターの採用に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // LemonSliceペルソナスワップ: category_persona_map(JSONB)は稼働中のアバター
    // (is_active=true)1件に紐づく。対象を「稼働中のアバター」に限定するのは、
    // activate_avatar/deactivate_avatar と同じ「ウィジェットに実際に出ているもの」
    // という基準を踏襲するため。
    case 'get_category_personas': {
      try {
        const res = await db.query(
          `SELECT name, category_persona_map FROM avatar_configs
             WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId],
        );
        const row = res.rows[0] as { name: string; category_persona_map: Record<string, unknown> | null } | undefined;
        if (!row) {
          return truncate('稼働中のアバターがありません。先に activate_avatar でアバターを有効化してください');
        }
        const map = row.category_persona_map ?? {};
        const categories = Object.keys(map);
        if (categories.length === 0) {
          return truncate(`「${row.name}」にはカテゴリ別ペルソナがまだ設定されていません`);
        }
        return truncate(
          `「${row.name}」のカテゴリ別ペルソナ（${categories.length}件）: ${categories.join('、')}`,
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_category_personas failed', err);
        return truncate('カテゴリ別ペルソナの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 現在のアバター設定を土台にした下書きを返すのみで、何も保存しない
    // （suggest_avatar_preset と同じ「提案は読み取り専用」の原則）。
    case 'suggest_category_persona': {
      const category = String(args['category'] ?? '').trim();
      if (!category) {
        return truncate('category は必須です');
      }
      try {
        const res = await db.query(
          `SELECT image_url, agent_prompt, agent_idle_prompt, voice_id FROM avatar_configs
             WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
          [tenantId],
        );
        const row = res.rows[0] as
          { image_url: string | null; agent_prompt: string | null; agent_idle_prompt: string | null; voice_id: string | null }
          | undefined;
        if (!row) {
          return truncate('稼働中のアバターがありません。先に activate_avatar でアバターを有効化してください');
        }
        return truncate(
          `「${category}」用のペルソナ下書き（現在の設定を土台にしています。変更したい項目だけ教えてください）:\n` +
          `見た目: ${row.image_url ?? '（現在の画像のまま）'}\n` +
          `話し方: ${row.agent_prompt ?? '（現在のまま）'}\n` +
          `待機中の表情: ${row.agent_idle_prompt ?? '（現在のまま）'}\n` +
          `声: ${row.voice_id ?? '（現在のまま）'}\n` +
          'この内容で保存しますか？',
        );
      } catch (err) {
        logger.warn('[actionExecutor] suggest_category_persona failed', err);
        return truncate('ペルソナ下書きの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'save_category_persona': {
      // category は queryPlanner.ts が会話ごとに自由生成する filters.category と
      // 完全一致でしか照合されない（agent.py の resolve_category_persona）。
      // 大文字小文字・前後空白のゆれだけは救えるよう正規化して保存する
      // （語彙そのものがズレるケースまでは救えない。既知の制約）。
      const category = String(args['category'] ?? '').trim().toLowerCase();
      if (!category) {
        return truncate('category は必須です');
      }
      const confirmed = isConfirmed(args['confirmed']);
      if (!confirmed) {
        return truncate(
          'カテゴリ別ペルソナの保存には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください',
        );
      }
      const persona: Record<string, string> = {};
      for (const key of ['image_url', 'agent_prompt', 'idle_prompt', 'voice_id'] as const) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) {
          persona[key] = value.trim();
        }
      }
      if (Object.keys(persona).length === 0) {
        return truncate('image_url・agent_prompt・idle_prompt・voice_id のいずれか1つ以上を指定してください');
      }
      try {
        const res = await db.query(
          `UPDATE avatar_configs
             SET category_persona_map = COALESCE(category_persona_map, '{}'::jsonb)
               || jsonb_build_object($2::text, $3::jsonb)
             WHERE tenant_id = $1 AND is_active = true
             RETURNING name`,
          [tenantId, category, JSON.stringify(persona)],
        );
        const updated = res.rows[0] as { name: string } | undefined;
        if (!updated) {
          return truncate('稼働中のアバターがありません。先に activate_avatar でアバターを有効化してください');
        }
        return truncate(`「${updated.name}」にカテゴリ「${category}」のペルソナを保存しました`);
      } catch (err) {
        logger.warn('[actionExecutor] save_category_persona failed', err);
        return truncate('カテゴリ別ペルソナの保存に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_embed_code': {
      try {
        // 平文 API キーは保存されていないため key_prefix のみ返す
        const [keyResult, themeResult] = await Promise.all([
          db.query(
            'SELECT key_prefix FROM tenant_api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
            [tenantId]
          ),
          db.query('SELECT widget_theme FROM tenants WHERE id = $1', [tenantId]),
        ]);
        const keyPrefix: string = keyResult.rows.length > 0
          ? String((keyResult.rows[0] as { key_prefix: string }).key_prefix)
          : '（キー未発行）';

        // set_widget_theme で保存された primaryColor のみ、widget.js が実際に読む
        // data-accent-color 属性として反映する(他のテーマキーは現状ウィジェット側に
        // 読み取りが無いため出力しない)。値は set_widget_theme 側で #RRGGBB 形式に
        // 検証済みだが、直接DBを触られた場合の防御として再検証する。
        const widgetTheme = (themeResult.rows[0] as { widget_theme: Record<string, unknown> | null } | undefined)?.widget_theme;
        const primaryColor = widgetTheme?.['primaryColor'];
        const accentColorAttr = typeof primaryColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(primaryColor)
          ? `\n  data-accent-color="${primaryColor}"`
          : '';
        // 設置位置(position / offsetX / offsetY)。既定のままなら何も出力しない
        const placementAttrs = buildPlacementAttributes(widgetTheme);

        return truncate(
          `ウィジェット埋め込みコードのひな形:\n\n` +
          // src は動的ルート GET /widget/:tenantSlug.js（src/api/widget/routes.ts）を指す。
          // 静的な /widget.js への直リンクだとプラン別バッジ制御(showBrandingBadge)を
          // 経由できず、バッジ配布経路が事実上存在しなかった(GID 1217762331236037、
          // admin-ui/src/pages/admin/tenants/EmbedCodeTab.tsx と同一根本原因)。
          `<script src="https://api.r2c.biz/widget/${tenantId}.js" data-api-key="YOUR_API_KEY"${accentColorAttr}${placementAttrs}></script>\n\n` +
          `現在のAPIキー先頭: ${keyPrefix}...\n` +
          `※ 実際のAPIキーは発行時のみ表示されます。再確認が必要な場合は新しいキーを発行してください`
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_embed_code failed', err);
        return truncate('埋め込みコードの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'set_widget_theme': {
      const theme = args['theme'];
      if (typeof theme !== 'object' || theme === null || Array.isArray(theme)) {
        return truncate('theme はオブジェクト形式で指定してください（例: {"primaryColor": "#3B82F6"}）');
      }
      // primaryColor は埋め込みコードの data-accent-color 属性としてそのまま出力され、
      // widget.js 側で CSS カスタムプロパティに直接埋め込まれる(public/widget.js:151)。
      // 不正な値を許すと埋め込みコード自体が壊れた属性を持つため、ここで厳格に弾く。
      const primaryColor = (theme as Record<string, unknown>)['primaryColor'];
      if (primaryColor !== undefined && !/^#[0-9a-fA-F]{6}$/.test(String(primaryColor))) {
        return truncate('primaryColor は #RRGGBB 形式の16進数カラーコードで指定してください（例: #3B82F6）');
      }
      // position / offsetX / offsetY も同様に埋め込みコードの属性として出力されるため、
      // 壊れた属性を作らないよう書き込み前に弾く
      const placementError = validateWidgetPlacement(theme as Record<string, unknown>);
      if (placementError) {
        return truncate(placementError);
      }

      try {
        await db.query(
          `UPDATE tenants SET widget_theme = COALESCE(widget_theme, '{}') || $1::jsonb WHERE id = $2`,
          [JSON.stringify(theme), tenantId]
        );
        return truncate(`ウィジェットテーマを更新しました: ${JSON.stringify(theme)}`);
      } catch (err) {
        logger.warn('[actionExecutor] set_widget_theme failed', err);
        return truncate('ウィジェットテーマの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 誤答の是正。**店主に「知識かルールか」を選ばせない**(要件 F1)。
    // 層の判定は correctionRouter(純関数)が唯一の実装。ここで再実装しない。
    // 書き込みは行わず、既存の save_faq / suggest_tuning_rule へ繋ぐだけ。
    // 新しい書き込み経路も新しいカード種別も作らない(禁止6・32)。
    case 'suggest_answer_correction': {
      const userMessage = String(args['user_message'] ?? '').trim();
      const aiMessage = String(args['ai_message'] ?? '').trim();
      const correction = String(args['correction'] ?? '').trim();

      if (!userMessage || !aiMessage) {
        return truncate('元の質問(user_message)とAIの回答(ai_message)が必要です');
      }
      if (!correction) {
        return truncate('どこが違うかを教えてください（例:「保証は2年です」「値引きの話は避けて」）');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      const route = routeCorrection({ question: userMessage, answer: aiMessage, correction });

      if (route.layer === 'knowledge') {
        // 事実の訂正 → 知識データへ。下書きは決定的に組む(質問=元の質問、答え=指摘)。
        return truncate(
          `事実の訂正として扱います。\n` +
          `質問: ${userMessage}\n` +
          `新しい答え: ${correction}\n` +
          `\nこの内容でよいか店舗管理者に確認し、同意が得られたら save_faq を呼び出してください` +
          `（question は上記の「質問」、answer は上記の「新しい答え」を使うこと）。` +
          `保存後は「次に『${userMessage.slice(0, 30)}』と聞かれたら、この内容で答えます」と伝えてください。`
        );
      }

      // 振る舞いの指示 → 指示ルールへ。下書きの生成は suggest_tuning_rule が唯一の実装なので、
      // ここでは作らずそちらへ渡す(2箇所目を作らない)。
      return truncate(
        `振る舞いの指示として扱います（${route.reason}）。\n` +
        `\n続けて suggest_tuning_rule を呼び出してください` +
        `（user_message と ai_message は今回と同じものを渡し、指摘の内容「${correction.slice(0, 60)}」を反映させること）。` +
        `どんな質問のときに使うかが決まっていない場合は、店舗管理者に聞き返してください。`
      );
    }

    case 'suggest_tuning_rule': {
      const freeText = String(args['free_text'] ?? '').trim();
      const userMessage = String(args['user_message'] ?? '').trim();
      const aiMessage = String(args['ai_message'] ?? '').trim();
      // P5-1: 会話の全文表示・知識ギャップの一覧から画面遷移なしでルールの下書きに
      // 繋げる導線。既存のfree_text経路とは別に、会話1往復(user_message/ai_message)
      // からの提案経路を追加する。新しい提案ロジックは書かず、旧UI(TuningRuleModal.tsx)
      // が使っているのと同じ callGroq8bSuggest に分岐するだけ。
      const isConversationMode = Boolean(userMessage && aiMessage);
      if (!freeText && !isConversationMode) {
        return truncate('free_text か、user_message と ai_message の組み合わせのいずれかが必要です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const anchorText = isConversationMode ? userMessage : freeText;
        const [knowledgeCtx, existingRules] = await Promise.all([
          searchKnowledgeForSuggestion(tenantId, anchorText).catch(() => ({ results: [] })),
          listRules(tenantId).catch(() => []),
        ]);
        const knowledgeSection = formatKnowledgeContext(knowledgeCtx);
        const existingRulesSection = existingRules
          .filter((r) => r.is_active)
          .map((r) => `- [${r.trigger_pattern}] ${r.expected_behavior}`)
          .join('\n');

        const suggestion = isConversationMode
          ? await callGroq8bSuggest(userMessage, aiMessage, knowledgeSection, existingRulesSection)
          : await callGroq8bSuggestFromText(freeText, knowledgeSection, existingRulesSection);

        if (!suggestion.trigger_pattern && !suggestion.instruction) {
          return truncate('提案の生成に失敗しました。もう少し具体的に教えてください');
        }

        // トリガーが決められなかった場合、「（常時適用）」等のプレースホルダを
        // 提案値として見せない。それをそのまま save_tuning_rule に渡すと、
        // 文字列としてtrigger_patternに保存され永久に発火しないルールができる(D4)。
        // どんな質問の時に使うかを店主に聞き返し、save_tuning_rule へは進めない。
        // splitTriggerKeywords で区切り文字だけの trigger_pattern(例: "、、、")も
        // 同じ穴として検出する(D4と同型の別入力・テスト作成時に発見)。
        if (!suggestion.trigger_pattern || splitTriggerKeywords(suggestion.trigger_pattern).length === 0) {
          return truncate(
            `対応方針の候補: ${suggestion.instruction}\n` +
            (suggestion.reason ? `理由: ${suggestion.reason}\n` : '') +
            `\nこの振る舞いは、お客様がどんな質問をした時に使いたいですか？キーワードを教えてください（例:「保証」「返品」など）。` +
            `決まったら、もう一度 suggest_tuning_rule を呼び出してください。`
          );
        }

        return {
          text: truncate(
            `提案:\n` +
            `トリガー: ${suggestion.trigger_pattern}\n` +
            `対応方針: ${suggestion.instruction}\n` +
            `優先度: ${suggestion.priority}\n` +
            (suggestion.reason ? `理由: ${suggestion.reason}\n` : '') +
            `\nこの内容でよいかユーザーに確認し、同意が得られたら save_tuning_rule を呼び出してください（trigger_pattern/expected_behavior/priority は上記の提案値を使うこと）。`
          ),
          card: {
            kind: 'tuning_rule_draft',
            triggerPattern: suggestion.trigger_pattern,
            expectedBehavior: suggestion.instruction,
            priority: suggestion.priority,
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] suggest_tuning_rule failed', err);
        return truncate('ルールの提案に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'save_tuning_rule': {
      const confirmed = isConfirmed(args['confirmed']);
      const triggerPattern = String(args['trigger_pattern'] ?? '').slice(0, 1000);
      const expectedBehavior = String(args['expected_behavior'] ?? '').slice(0, 4000);
      // D5: ユーザーが「高い優先度で」等、3段階の言葉で話した場合は priority_tier を優先する。
      // 数値(priority)は suggest_tuning_rule の提案値をそのまま渡す既存経路のために残す。
      const priorityTier = parsePriorityTier(args['priority_tier']);
      const priorityRaw = Number(args['priority']);
      const priority = priorityTier
        ? PRIORITY_TIER_VALUE[priorityTier]
        : Number.isFinite(priorityRaw) ? Math.max(0, Math.min(10, Math.round(priorityRaw))) : 5;

      if (!confirmed) {
        return truncate('ルールの保存には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!triggerPattern || !expectedBehavior) {
        return truncate('trigger_pattern と expected_behavior は必須です');
      }
      // suggest_tuning_rule がトリガー未決定時に案内していた文字列(「（常時適用）」)が
      // そのままtrigger_patternとして渡ってきた場合の防御(D4)。これを通すと
      // 保存は成功するが質問文に一致せず永久に発火しないルールができる。
      // splitTriggerKeywords で区切り文字だけの trigger_pattern(例: "、、、")も
      // 同じ穴として検出する(D4と同型の別入力・テスト作成時に発見)。
      if (ALWAYS_APPLY_PLACEHOLDER.has(triggerPattern) || splitTriggerKeywords(triggerPattern).length === 0) {
        return truncate(
          'トリガーが決まっていないようです。お客様のどんな質問の時にこの振る舞いを使うか、キーワードを教えてください（例:「保証」「返品」など）。'
        );
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const rule = await createRule({
          tenant_id: tenantId,
          trigger_pattern: triggerPattern,
          expected_behavior: expectedBehavior,
          priority,
          created_by: 'admin_agent',
        });
        return truncate(`指示ルールを保存しました（ID: ${rule.id}）: 「${rule.trigger_pattern}」→ ${rule.expected_behavior}`);
      } catch (err) {
        logger.warn('[actionExecutor] save_tuning_rule failed', err);
        return truncate('ルールの保存に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_tuning_rules': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const rules = await listRules(tenantId);
        if (rules.length === 0) {
          return truncate('有効な指示ルールはありません');
        }
        const activeCount = rules.filter((r) => r.is_active).length;
        // text は件数の要約のみ(件数によらず500字に収まる)。全件の中身はcardに載せる。
        return {
          text: truncate(
            `指示ルール一覧（${rules.length}件、うち有効${activeCount}件・無効${rules.length - activeCount}件）です。詳しい内容は一覧でご確認いただけます。`
          ),
          card: {
            kind: 'tuning_rules_list',
            rules: rules.map((r) => ({
              id: r.id,
              triggerPattern: r.trigger_pattern,
              expectedBehavior: r.expected_behavior,
              priority: r.priority,
              isActive: r.is_active,
              source: r.source ?? null,
              status: r.status ?? null,
              evidence: r.evidence ?? null,
            })),
            totalCount: rules.length,
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] get_tuning_rules failed', err);
        return truncate('指示ルール一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'update_tuning_rule': {
      const id = Number(args['id']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate(`指示ルール（ID: ${id}）の更新には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      const triggerPattern = typeof args['trigger_pattern'] === 'string' ? args['trigger_pattern'].slice(0, 1000) : undefined;
      // parseOptionalTextArg で '' を未指定扱いにする(#780と同型)。trimもするが、
      // 空白だけの応答方針に正当な用途は無いため未指定と同一視してよい。
      const expectedBehavior = parseOptionalTextArg(args['expected_behavior'])?.slice(0, 4000);
      const isActive = typeof args['is_active'] === 'boolean' ? args['is_active'] : undefined;
      // AI提案(source='judge')の承認/却下でのみ指定される。is_activeだけではpending(未承認)と
      // rejected(却下済み)を区別できない(どちらもis_active=falseのため)。
      const statusRaw = args['status'];
      const status = statusRaw === 'active' || statusRaw === 'rejected' ? statusRaw : undefined;
      // D5: 「優先度を高くして」のような3段階の言葉での編集をチャットから可能にする。
      const priorityTier = parsePriorityTier(args['priority_tier']);
      const priority = priorityTier ? PRIORITY_TIER_VALUE[priorityTier] : undefined;

      if (
        triggerPattern === undefined &&
        expectedBehavior === undefined &&
        isActive === undefined &&
        status === undefined &&
        priority === undefined
      ) {
        return truncate('変更する内容がありません（trigger_pattern・expected_behavior・is_active・priority_tier のいずれかを指定してください）');
      }
      // save_tuning_rule と同じ防御(D4派生): 既存ルールのトリガーを編集する経路でも
      // 「（常時適用）」やsplitTriggerKeywordsが空になる区切り文字だけの値が
      // 渡ってくると、更新は成功するが永久に発火しないルールになってしまう。
      if (
        triggerPattern !== undefined &&
        (ALWAYS_APPLY_PLACEHOLDER.has(triggerPattern) || splitTriggerKeywords(triggerPattern).length === 0)
      ) {
        return truncate(
          'トリガーが決まっていないようです。お客様のどんな質問の時にこの振る舞いを使うか、キーワードを教えてください（例:「保証」「返品」など）。'
        );
      }

      try {
        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const updated = await updateRule(
          id,
          { trigger_pattern: triggerPattern, expected_behavior: expectedBehavior, is_active: isActive, status, priority },
          ownerFilter,
        );
        if (!updated) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        if (status === 'active') {
          return truncate(`指示ルール（ID: ${id}）を承認し、有効にしました: 「${updated.trigger_pattern}」`);
        }
        if (status === 'rejected') {
          return truncate(`指示ルール（ID: ${id}）を却下しました: 「${updated.trigger_pattern}」`);
        }
        const priorityNote = priorityTier ? `／優先度: ${PRIORITY_TIER_LABEL_JA[priorityTier]}` : '';
        return truncate(`指示ルール（ID: ${id}）を更新しました: 「${updated.trigger_pattern}」${updated.is_active ? '' : '（現在無効）'}${priorityNote}`);
      } catch (err) {
        logger.warn('[actionExecutor] update_tuning_rule failed', err);
        return truncate('指示ルールの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'delete_tuning_rule': {
      const id = Number(args['id']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate(`指示ルール（ID: ${id}）の削除には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      try {
        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const ok = await deleteRule(id, ownerFilter);
        if (!ok) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        return truncate(`指示ルール（ID: ${id}）を削除しました`);
      } catch (err) {
        logger.warn('[actionExecutor] delete_tuning_rule failed', err);
        return truncate('指示ルールの削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'generate_tuning_rule_test_responses': {
      const id = Number(args['id']);
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }

      try {
        const result = await generateTestResponses(id, tenantId ?? '', isSuperAdmin);
        if (!result.ok) {
          switch (result.reason) {
            case 'not_found':
              return truncate(`指示ルール（ID: ${id}）が見つかりません`);
            case 'forbidden':
              return truncate('このルールへのアクセス権限がありません');
            case 'no_api_key':
              return truncate('テスト応答の生成機能が現在利用できません');
            case 'llm_error':
              return truncate('LLMとの通信に失敗しました。もう一度お試しください');
            case 'invalid_output':
              return truncate('テスト応答の生成に失敗しました。もう一度お試しください');
          }
        }
        const lines = result.responses.map((r, i) => `${i + 1}. [${r.style}] ${r.text.slice(0, 200)}`);
        return truncate(
          `テスト応答案（ルールID: ${id}）:\n` + lines.join('\n') +
          '\n\n採用する場合はユーザーに確認の上、approve_tuning_rule_response で保存してください。',
        );
      } catch (err) {
        logger.warn('[actionExecutor] generate_tuning_rule_test_responses failed', err);
        return truncate('テスト応答の生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'approve_tuning_rule_response': {
      const id = Number(args['id']);
      const text = String(args['text'] ?? '').trim().slice(0, 4000);
      const style = String(args['style'] ?? '').trim().slice(0, 50);
      const reason = typeof args['reason'] === 'string' ? args['reason'].trim().slice(0, 1000) || undefined : undefined;
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate('返答の採用には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!Number.isFinite(id) || !text || !style) {
        return truncate('id・text・style は必須です');
      }

      try {
        const existing = await db.query('SELECT tenant_id, approved_responses FROM tuning_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`指示ルール（ID: ${id}）が見つかりません`);
        }
        const row = existing.rows[0] as { tenant_id: string; approved_responses: ApprovedResponse[] | null };
        if (!isSuperAdmin && row.tenant_id !== tenantId) {
          return truncate('このルールへのアクセス権限がありません');
        }

        const current = row.approved_responses ?? [];
        const next: ApprovedResponse[] = [...current, { text, style, reason, approved_at: new Date().toISOString() }];

        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const updated = await updateRule(id, { approved_responses: next }, ownerFilter);
        if (!updated) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        return truncate(`返答を採用しました（ルールID: ${id}、現在${next.length}件採用済み）: 「${text.slice(0, 100)}」`);
      } catch (err) {
        logger.warn('[actionExecutor] approve_tuning_rule_response failed', err);
        return truncate('返答の採用に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'remove_approved_response': {
      const id = Number(args['id']);
      const index = Number(args['index']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate('採用済み返答の取消には確認が必要です。confirmed=true を指定して再度実行してください');
      }
      if (!Number.isFinite(id) || !Number.isFinite(index) || index < 0) {
        return truncate('id・index が不正です');
      }

      try {
        const existing = await db.query('SELECT tenant_id, approved_responses FROM tuning_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`指示ルール（ID: ${id}）が見つかりません`);
        }
        const row = existing.rows[0] as { tenant_id: string; approved_responses: ApprovedResponse[] | null };
        if (!isSuperAdmin && row.tenant_id !== tenantId) {
          return truncate('このルールへのアクセス権限がありません');
        }

        const current = row.approved_responses ?? [];
        if (index >= current.length) {
          return truncate(`採用済み返答（${current.length}件）に index ${index} は存在しません`);
        }
        const next = current.filter((_, i) => i !== index);

        const ownerFilter = isSuperAdmin ? undefined : tenantId;
        const updated = await updateRule(id, { approved_responses: next }, ownerFilter);
        if (!updated) {
          return truncate(`指示ルール（ID: ${id}）が見つからないかアクセス権限がありません`);
        }
        return truncate(`採用済み返答を取り消しました（ルールID: ${id}、残り${next.length}件）`);
      } catch (err) {
        logger.warn('[actionExecutor] remove_approved_response failed', err);
        return truncate('採用済み返答の取消に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase2 (P7 プロアクティブ・ブリーフィング): 今週(暦週・月曜00:00 JST起点)の状況を
    // 1回で要約取得する読み取り専用ツール。ログイン直後など能動的な状況説明に使う。
    // 期間の計算は weekRange.ts に集約する(SQLへ AT TIME ZONE を直書きしない)。
    case 'get_weekly_briefing': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const { weekStart, prevWeekStart, prevWeekEnd } = getWeekRange(new Date());
        // 指標ごとに Promise.allSettled で独立させる。以前は1本の失敗で全指標が
        // 「取得に失敗しました」に落ちていたが、指標が増えるほど1本の不調が全体を
        // 巻き込む確率が上がるため、取れた指標だけを出す方式に変更する。
        const [sessionsRes, prevSessionsRes, evalRes, cvRes, faqRes, tuningRes, gapsRes, learnedRes] = await Promise.allSettled([
          db.query(
            `SELECT COUNT(*)::int AS n FROM chat_sessions
             WHERE tenant_id = $1 AND started_at >= $2
               ${userSourceClause("chat_sessions")}`,
            [tenantId, weekStart],
          ),
          db.query(
            `SELECT COUNT(*)::int AS n FROM chat_sessions
             WHERE tenant_id = $1
               AND started_at >= $2
               AND started_at < $3
               ${userSourceClause("chat_sessions")}`,
            [tenantId, prevWeekStart, prevWeekEnd],
          ),
          db.query(
            `SELECT AVG(score) AS avg FROM conversation_evaluations
             WHERE tenant_id = $1 AND evaluated_at >= $2 AND score > 0
               ${userSourceExists("conversation_evaluations.session_id", "conversation_evaluations.tenant_id")}`,
            [tenantId, weekStart],
          ),
          db.query(
            `SELECT COUNT(*)::int AS n, COALESCE(SUM(conversion_value), 0)::numeric AS total
             FROM conversion_attributions
             WHERE tenant_id = $1 AND created_at >= $2`,
            [tenantId, weekStart],
          ),
          // 旧ダッシュボードStatCard代替: FAQ総数・公開数・最終更新日(週に限定しないテナント全体の値)
          db.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE is_published)::int AS published,
                    MAX(updated_at) AS last_updated
             FROM faq_docs WHERE tenant_id = $1`,
            [tenantId],
          ),
          // weeklyReportGenerator(Phase46)からの唯一の引き継ぎ指標。
          // P4-1で修正: 以前は approved_at/rejected_at を見ており、店主が作った通常の
          // ルール(is_active=true, approved_at=NULLのまま)も含めて全件を「承認待ち」として
          // 数えていた。AI提案(source IN ('judge','hermes'))かつ未承認(is_active=false)かつ
          // 却下されていない件数に修正する。approved_at/rejected_at は現在 updateRule
          // (GID 1217752900578379, R4)も更新するようになったが、この集計はAI提案の
          // 未承認件数を数えるのが目的で判定にis_active/statusしか使わないため無関係。
          // R6: Hermes提案もtuning_rulesの同じ棚に着地するため、同じ集計に含める。
          db.query(
            `SELECT COUNT(*)::int AS n FROM tuning_rules
             WHERE tenant_id = $1 AND source IN ('judge', 'hermes') AND is_active = false
               AND status IS DISTINCT FROM 'rejected'`,
            [tenantId],
          ),
          getGaps({ tenantId, status: 'open', limit: 3 }),
          // 今週AIが覚えたこと。店主に「学習が起きているか」を返すための指標。
          // faq_docs は人が足したもの、learned_memory は会話から自動で覚えたもの。
          // learned_memory は未適用環境もありうるので、この1本が失敗しても
          // allSettled で他の指標を巻き込まない。
          db.query(
            `SELECT
               (SELECT COUNT(*)::int FROM faq_docs
                 WHERE tenant_id = $1 AND created_at >= $2) AS faq_added,
               (SELECT COUNT(*)::int FROM learned_memory
                 WHERE tenant_id = $1 AND created_at >= $2) AS memorized`,
            [tenantId, weekStart],
          ),
        ]);

        const lines: string[] = ['今週(月曜起点)の状況:'];
        // 数値の権威はこのcard(サーバ集計値)。text はLLMに渡す自然文とフォールバック
        // 表示用で、card と同じ値から組み立てる(2箇所に別の計算を書かない)。
        const card: WeeklySummaryCardPayload = {
          kind: 'weekly_summary',
          asOf: new Date().toISOString(),
          sessions: null,
          avgScore: null,
          conversions: null,
          faq: null,
          pendingTuningRules: null,
          gaps: null,
          learned: null,
        };

        if (sessionsRes.status === 'fulfilled') {
          const totalSessions = Number(sessionsRes.value?.rows?.[0]?.n ?? 0);
          // 先週の同一経過時間との比較値。先週は既に終わっているため確定値として併記する
          // （週初の部分週をまる1週間の前週と比べると常に大幅マイナスになり指標として使えない）。
          let changePct: number | null = null;
          let prevSessions = 0;
          if (prevSessionsRes.status === 'fulfilled') {
            prevSessions = Number(prevSessionsRes.value?.rows?.[0]?.n ?? 0);
            if (prevSessions > 0) {
              changePct = Math.round(((totalSessions - prevSessions) / prevSessions) * 100);
            }
          }
          card.sessions = { total: totalSessions, changePct, prevTotal: prevSessions };
          const changeSuffix = changePct !== null
            ? `（先週同時点比 ${changePct >= 0 ? '+' : ''}${changePct}%、先週同時点は${prevSessions}件）`
            : '';
          lines.push(`会話数 ${totalSessions}件${changeSuffix}`);
        }

        if (evalRes.status === 'fulfilled') {
          const avgScoreRaw = evalRes.value?.rows?.[0]?.avg;
          if (avgScoreRaw != null) {
            card.avgScore = Math.round(Number(avgScoreRaw));
            lines.push(`応答品質スコア ${card.avgScore}/100`);
          }
        }

        if (cvRes.status === 'fulfilled') {
          const cvCount = Number(cvRes.value?.rows?.[0]?.n ?? 0);
          const cvTotal = Math.round(Number(cvRes.value?.rows?.[0]?.total ?? 0));
          card.conversions = { count: cvCount, total: cvTotal };
          lines.push(`成約 ${cvCount}件・¥${cvTotal.toLocaleString('ja-JP')}`);
        }

        if (faqRes.status === 'fulfilled') {
          const row = faqRes.value?.rows?.[0];
          const faqTotal = Number(row?.total ?? 0);
          const faqPublished = Number(row?.published ?? 0);
          // last_updated が想定外の値(パース不能)でも toISOString() で例外を投げない。
          // ここで投げると case 全体の try/catch に捕まり、他6指標が正常に取得できていても
          // 「取得に失敗しました」に落ちる — Promise.allSettled で守っている部分失敗耐性が
          // この1行のせいで無効化されてしまうため、必ず検証してから変換する。
          const lastUpdatedDate = row?.last_updated ? new Date(row.last_updated) : null;
          const lastUpdatedIso: string | null =
            lastUpdatedDate && !Number.isNaN(lastUpdatedDate.getTime()) ? lastUpdatedDate.toISOString() : null;
          card.faq = { total: faqTotal, published: faqPublished, lastUpdated: lastUpdatedIso };
          const lastUpdatedDisplay = lastUpdatedIso
            ? new Date(lastUpdatedIso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })
            : null;
          lines.push(
            `FAQ ${faqTotal}件（公開${faqPublished}件）` + (lastUpdatedDisplay ? `・最終更新 ${lastUpdatedDisplay}` : ''),
          );
        }

        if (tuningRes.status === 'fulfilled') {
          const pending = Number(tuningRes.value?.rows?.[0]?.n ?? 0);
          card.pendingTuningRules = pending;
          lines.push(`承認待ちの指示ルール ${pending}件`);
        }

        if (gapsRes.status === 'fulfilled') {
          const { gaps, total: gapsTotal } = gapsRes.value;
          card.gaps = { total: gapsTotal, top: gaps.map((g) => ({ id: g.id, question: g.user_question.slice(0, 60) })) };
          lines.push(`AIが答えられなかった質問 ${gapsTotal}件（未対応の累計）`);
          if (gaps.length > 0) {
            lines.push('うち上位:');
            gaps.forEach((g, i) => {
              lines.push(`${i + 1}. 「${g.user_question.slice(0, 60)}」`);
            });
          }
        }

        if (learnedRes.status === 'fulfilled') {
          const row = learnedRes.value?.rows?.[0];
          const faqAdded = Number(row?.faq_added ?? 0);
          const memorized = Number(row?.memorized ?? 0);
          card.learned = { faqAdded, memorized };
          // 0 は「今週は動きが無かった」という正しい情報。伏せずにそのまま伝える
          // (CLAUDE.md 禁止34 の趣旨: 母数不足で率は出さないが、件数の 0 は 0 と書く)。
          lines.push(
            faqAdded + memorized === 0
              ? 'AIが新しく覚えたこと なし'
              : `AIが新しく覚えたこと ${faqAdded + memorized}件（追加したFAQ ${faqAdded}件・会話から自動 ${memorized}件）`,
          );
        }

        if (lines.length === 1) {
          // 全指標が取得失敗
          return truncate('週次サマリーの取得に失敗しました');
        }

        return { text: truncate(lines.join('\n')), card };
      } catch (err) {
        logger.warn('[actionExecutor] get_weekly_briefing failed', err);
        return truncate('週次サマリーの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_knowledge_gaps': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const limit = clampToolLimit(args['limit'], 10, 20);

      try {
        const { gaps, total } = await getGaps({ tenantId, status: 'open', limit });
        if (gaps.length === 0) {
          return truncate('未対応の知識ギャップはありません');
        }
        const lines = gaps.map((g) => `[${g.id}] ${g.user_question.slice(0, 100)}（${g.rag_hit_count}件ヒット）`);
        // P5-1: cardに全件の質問文をそのまま持たせ、フロントの「このギャップから
        // ルールを作る」チップが id と質問文をそのまま自然文に埋め込めるようにする。
        return {
          text: truncate(`知識ギャップ一覧（未対応${total}件中${gaps.length}件）:\n` + lines.join('\n')),
          card: {
            kind: 'knowledge_gaps_list',
            gaps: gaps.map((g) => ({ id: g.id, userQuestion: g.user_question, ragHitCount: g.rag_hit_count })),
            totalCount: total,
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] get_knowledge_gaps failed', err);
        return truncate('知識ギャップ一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'dismiss_knowledge_gap': {
      const id = Number(args['id']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate(`知識ギャップ（ID: ${id}）を片付けるには確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const ok = await updateGapStatus(id, 'dismissed', tenantId, null);
        if (!ok) {
          return truncate(`知識ギャップ（ID: ${id}）が見つかりません`);
        }
        return truncate(`知識ギャップ（ID: ${id}）を「対応不要」として片付けました`);
      } catch (err) {
        logger.warn('[actionExecutor] dismiss_knowledge_gap failed', err);
        return truncate('知識ギャップの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase3: suggest_faq — 自然文からFAQ下書きを生成する読み取り専用ツール
    case 'suggest_faq': {
      const freeText = String(args['free_text'] ?? '').trim();
      if (!freeText) return truncate('free_text は必須です');
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const existing = await db.query(
          `SELECT question FROM faq_docs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 40`,
          [tenantId],
        );
        const existingQuestions = (existing.rows as { question: string }[]).map((r) => r.question);

        const faqs = await textToFaqs(freeText, undefined, existingQuestions);
        if (faqs.length === 0) {
          return truncate('FAQの下書き生成に失敗しました。もう少し具体的に教えてください');
        }

        const top = faqs[0]!;
        const lines = [
          '提案:',
          `質問: ${top.question}`,
          `回答: ${top.answer}`,
          `分類: ${top.category ?? '(自動判定)'}`,
        ];
        if (faqs.length > 1) lines.push(`（他に${faqs.length - 1}件の候補も生成されました。必要なら伝えてください）`);
        lines.push('この内容でよいかユーザーに確認し、同意が得られたら save_faq を呼び出してください（question/answer/category は上記の提案値を使うこと）。');

        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_faq failed', err);
        return truncate('FAQの下書き生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase3: save_faq — confirmedゲート必須のFAQ保存(add_faqと同じINSERT経路)
    case 'save_faq': {
      const confirmed = isConfirmed(args['confirmed']);
      const question = String(args['question'] ?? '').slice(0, 500);
      const answer = String(args['answer'] ?? '').slice(0, 2000);
      const category = typeof args['category'] === 'string' ? args['category'] : null;

      if (!confirmed) {
        return truncate('FAQの保存には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!question || !answer) {
        return truncate('question と answer は必須です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const result = await db.query(
          `INSERT INTO faq_docs (tenant_id, question, answer, category, is_published)
           VALUES ($1, $2, $3, $4, true)
           RETURNING id, question, answer, is_published`,
          [tenantId, question, answer, category],
        );
        const row = result.rows[0] as { id: number; question: string; answer: string; is_published: boolean };

        insertEmbeddingAsync(db, tenantId, `${row.question}\n${row.answer}`, row.id, {
          source: 'admin_agent',
          faq_id: row.id,
        });
        upsertToEsAsync(tenantId, row.id, row.question, row.answer, row.is_published);

        return truncate(`FAQを保存しました（ID: ${row.id}）: ${row.question}`);
      } catch (err) {
        logger.warn('[actionExecutor] save_faq failed', err);
        return truncate('FAQの保存に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // チャット版 FAQ一括取り込み(テキスト): 旧UIの「AIの知識データ」テキストタブと
    // 同じ generateTextFaqPreview を使ってFAQ案を生成し、結果をサーバー側にステージングする
    // (LLMに配列を持ち回らせない設計。詳細は knowledgeImportStaging.ts のコメント参照)。
    // DB書き込みはしない読み取り専用ツール。登録は commit_faq_import で行う。
    case 'suggest_faq_import_from_text': {
      const text = String(args['text'] ?? '').trim();
      const category = typeof args['category'] === 'string' ? args['category'] : null;

      if (text.length < 50 || text.length > 10000) {
        return truncate('text は50文字以上10000文字以内で入力してください');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        let faqs = await generateTextFaqPreview(db, tenantId, text, category);
        if (faqs.length === 0) {
          return truncate('FAQを生成できませんでした。テキストをもう少し詳しく入力してみてください');
        }

        const truncated = faqs.length > MAX_IMPORT_FAQS;
        if (truncated) faqs = faqs.slice(0, MAX_IMPORT_FAQS);

        setStagedFaqImport(tenantId, sessionId, {
          kind: 'text',
          tenantId,
          faqs,
          categoryOverride: category,
          truncated,
          createdAt: Date.now(),
        });

        const dupCount = faqs.filter((f) => f.duplicate).length;
        const examples = faqs.slice(0, 3).map((f) => `「${f.question.slice(0, 40)}」`).join('、');
        const lines = [
          `${faqs.length}件のFAQ案を作成しました。` +
            (dupCount > 0 ? `うち${dupCount}件は既存と重複のため登録時にスキップされます。` : ''),
          `例: ${examples}`,
        ];
        if (truncated) lines.push(`※ 生成数が上限(${MAX_IMPORT_FAQS}件)を超えたため、先頭${MAX_IMPORT_FAQS}件のみを対象にしています。`);
        lines.push('登録してよろしければお知らせください。');
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_faq_import_from_text failed', err);
        return truncate('FAQ案の生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // チャット版 FAQ一括取り込み(URL): 旧UIの「AIの知識データ」URLタブと同じ
    // generateScrapeFaqPreview を使ってFAQ案を生成し、結果をサーバー側にステージングする。
    // DB書き込みはしない読み取り専用ツール。登録は commit_faq_import で行う。
    case 'suggest_faq_import_from_urls': {
      const urlsRaw = args['urls'];
      const category = typeof args['category'] === 'string' ? args['category'] : null;

      if (!Array.isArray(urlsRaw) || urlsRaw.length === 0 || urlsRaw.length > 5) {
        return truncate('urls は1〜5件のURLを配列で指定してください');
      }
      const urls = urlsRaw.map((u) => String(u));
      const invalidUrl = urls.find((u) => !/^https?:\/\//i.test(u));
      if (invalidUrl) {
        return truncate(`URLの形式が不正です: ${invalidUrl.slice(0, 100)}`);
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const items = await generateScrapeFaqPreview(db, tenantId, urls, category);
        let totalFaqs = items.reduce((sum, item) => sum + item.faqs.length, 0);
        const errorItems = items.filter((item) => item.error);

        if (totalFaqs === 0) {
          const detail = errorItems.length > 0 ? `（${errorItems[0]!.error}）` : '';
          return truncate(`指定されたURLからFAQを生成できませんでした${detail}`);
        }

        // 20件上限は item をまたいで先頭から詰める（末尾の item・faq から間引く）
        let truncated = false;
        if (totalFaqs > MAX_IMPORT_FAQS) {
          truncated = true;
          let remaining = MAX_IMPORT_FAQS;
          for (const item of items) {
            if (remaining <= 0) { item.faqs = []; continue; }
            if (item.faqs.length > remaining) item.faqs = item.faqs.slice(0, remaining);
            remaining -= item.faqs.length;
          }
          totalFaqs = MAX_IMPORT_FAQS;
        }

        setStagedFaqImport(tenantId, sessionId, {
          kind: 'scrape',
          tenantId,
          items,
          categoryOverride: category,
          truncated,
          createdAt: Date.now(),
        });

        const allFaqs = items.flatMap((item) => item.faqs);
        const dupCount = allFaqs.filter((f) => f.duplicate).length;
        const examples = allFaqs.slice(0, 3).map((f) => `「${f.question.slice(0, 40)}」`).join('、');
        const lines = [
          `${urls.length}件のURLから合計${totalFaqs}件のFAQ案を作成しました。` +
            (dupCount > 0 ? `うち${dupCount}件は既存と重複のため登録時にスキップされます。` : ''),
          `例: ${examples}`,
        ];
        if (errorItems.length > 0) lines.push(`取得できなかったURL: ${errorItems.length}件`);
        if (truncated) lines.push(`※ 生成数が上限(${MAX_IMPORT_FAQS}件)を超えたため、先頭${MAX_IMPORT_FAQS}件のみを対象にしています。`);
        lines.push('登録してよろしければお知らせください。');
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_faq_import_from_urls failed', err);
        return truncate('FAQ案の生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // チャット版 FAQ一括取り込みのコミット: suggest_faq_import_from_text/urls で
    // ステージング済みのFAQをDBに登録する。confirmedゲート必須。
    case 'commit_faq_import': {
      const confirmed = isConfirmed(args['confirmed']);
      const targetRaw = typeof args['target'] === 'string' ? args['target'] : undefined;

      if (!confirmed) {
        return truncate('FAQの一括登録には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      const staged = getStagedFaqImport(tenantId, sessionId);
      if (!staged) {
        return truncate('プレビューがありません。先に suggest_faq_import_from_text または suggest_faq_import_from_urls でFAQ案を作成してください');
      }

      const target = targetRaw || tenantId;
      if (target === 'global' && !isSuperAdmin) {
        return truncate('全店舗共通の知識データはSuper Adminのみ登録可能です');
      }
      // target は toolDefinitions でLLMに公開されているため、client_admin が自然文で
      // 他テナントIDを指定できてしまう。'global' 以外の越境書き込みもここで塞ぐ
      // （旧HTTPルート /text/commit の requireKnowledgeTenant は body の target を
      // 見ないため同じ穴があるが、チャットからは自然文で到達可能なのでここで防ぐ）。
      if (target !== tenantId && !isSuperAdmin) {
        return truncate('他のテナントには登録できません');
      }

      try {
        const categoryOverride = staged.categoryOverride ?? undefined;
        const result =
          staged.kind === 'text'
            ? await commitTextFaqs(db, target, staged.faqs, categoryOverride, 'admin_agent_text_import')
            : await commitScrapeFaqs(db, target, staged.items, categoryOverride, 'admin_agent_scrape_import');

        clearStagedFaqImport(tenantId, sessionId);

        return truncate(
          `FAQを${result.inserted}件登録しました` +
            (result.skipped > 0 ? `（重複のため${result.skipped}件はスキップしました）` : ''),
        );
      } catch (err) {
        logger.warn('[actionExecutor] commit_faq_import failed', err);
        return truncate('FAQの一括登録に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // チャット版 FAQ一括取り込みのプレビュー破棄: 直前の suggest_faq_import_from_text/urls
    // の結果を明示的に取り消す。TTL(30分)でも自動失効するが、続けて別の内容を試す前に
    // 古いプレビューが残っていることでの誤登録を避けるための明示的な取消手段として用意する。
    // 確認は不要(DBへの書き込みは何もしていない取り消しのため、他の削除系ツールと違いconfirmedゲートは設けない)。
    case 'discard_faq_import': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const staged = getStagedFaqImport(tenantId, sessionId);
      if (!staged) {
        return truncate('破棄する対象のFAQ案はありません');
      }
      clearStagedFaqImport(tenantId, sessionId);
      return truncate('FAQ案を破棄しました');
    }

    // -----------------------------------------------------------------------
    // Phase3: suggest_engagement_rule — 自然文から声がけルールの下書きを生成する読み取り専用ツール
    case 'suggest_engagement_rule': {
      const freeText = String(args['free_text'] ?? '').trim();
      if (!freeText) return truncate('free_text は必須です');
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const suggestion = await suggestEngagementRuleFromText(freeText, tenantId);
        if (!suggestion.message_template) {
          return truncate('声がけの下書き生成に失敗しました。もう少し具体的に教えてください');
        }

        const lines = [
          '提案:',
          `トリガー種別: ${suggestion.trigger_type}`,
          `トリガー設定: ${JSON.stringify(suggestion.trigger_config)}`,
          `表示文言: ${suggestion.message_template}`,
          `優先度: ${suggestion.priority}`,
        ];
        if (suggestion.reason) lines.push(`理由: ${suggestion.reason}`);
        lines.push('この内容でよいかユーザーに確認し、同意が得られたら save_engagement_rule を呼び出してください（trigger_type/trigger_config/message_template/priority は上記の提案値を使うこと）。');

        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] suggest_engagement_rule failed', err);
        return truncate('声がけの下書き生成に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Phase3: save_engagement_rule — confirmedゲート必須の声がけルール保存(trigger_rules)
    case 'save_engagement_rule': {
      const confirmed = isConfirmed(args['confirmed']);
      const triggerType = String(args['trigger_type'] ?? '');
      const messageTemplate = String(args['message_template'] ?? '').slice(0, 500);
      const priorityRaw = Number(args['priority']);
      const priority = Number.isFinite(priorityRaw) ? Math.max(0, Math.min(100, Math.round(priorityRaw))) : 0;
      const triggerConfigRaw = args['trigger_config'];

      const VALID_TYPES = new Set(['scroll_depth', 'idle_time', 'exit_intent', 'page_url_match']);

      if (!confirmed) {
        return truncate('声がけルールの保存には確認が必要です。ユーザーに内容を提示し、同意を得てから confirmed=true で再度呼び出してください');
      }
      if (!VALID_TYPES.has(triggerType)) {
        return truncate('trigger_type が不正です（scroll_depth/idle_time/exit_intent/page_url_match のいずれか）');
      }
      if (!messageTemplate) {
        return truncate('message_template は必須です');
      }
      if (typeof triggerConfigRaw !== 'object' || triggerConfigRaw === null || Array.isArray(triggerConfigRaw)) {
        return truncate('trigger_config はオブジェクト形式で指定してください');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const result = await db.query(
          `INSERT INTO trigger_rules (tenant_id, trigger_type, trigger_config, message_template, is_active, priority)
           VALUES ($1, $2, $3, $4, true, $5)
           RETURNING id, trigger_type, message_template`,
          [tenantId, triggerType, JSON.stringify(triggerConfigRaw), messageTemplate, priority],
        );
        const row = result.rows[0] as { id: number; trigger_type: string; message_template: string };

        return truncate(`声がけルールを保存しました（ID: ${row.id}）: 「${row.trigger_type}」→ ${row.message_template}`);
      } catch (err) {
        logger.warn('[actionExecutor] save_engagement_rule failed', err);
        return truncate('声がけルールの保存に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_engagement_rules': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const result = await db.query(
          `SELECT id, trigger_type, message_template, is_active, priority
           FROM trigger_rules WHERE tenant_id = $1
           ORDER BY priority DESC, created_at DESC LIMIT 15`,
          [tenantId],
        );
        if (result.rows.length === 0) {
          return truncate('声がけルールは登録されていません');
        }
        const lines = (result.rows as { id: number; trigger_type: string; message_template: string; is_active: boolean; priority: number }[]).map(
          (r) => `[${r.id}]${r.is_active ? '' : '(無効)'} ${r.trigger_type} → ${r.message_template.slice(0, 80)}`,
        );
        return truncate(`声がけルール一覧（${result.rows.length}件）:\n` + lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_engagement_rules failed', err);
        return truncate('声がけルール一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'update_engagement_rule': {
      const id = Number(args['id']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate(`声がけルール（ID: ${id}）の更新には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      const VALID_TRIGGER_TYPES = new Set(['scroll_depth', 'idle_time', 'exit_intent', 'page_url_match']);
      const triggerTypeRaw = args['trigger_type'];
      if (triggerTypeRaw !== undefined && !VALID_TRIGGER_TYPES.has(String(triggerTypeRaw))) {
        return truncate('trigger_type が不正です（scroll_depth/idle_time/exit_intent/page_url_match のいずれか）');
      }
      const triggerType = typeof triggerTypeRaw === 'string' ? triggerTypeRaw : undefined;
      const triggerConfigRaw = args['trigger_config'];
      const triggerConfig =
        typeof triggerConfigRaw === 'object' && triggerConfigRaw !== null && !Array.isArray(triggerConfigRaw)
          ? triggerConfigRaw
          : undefined;
      // parseOptionalTextArg で '' を未指定扱いにする(#780と同型)。trimもするが、
      // 空白だけの声がけ文言に正当な用途は無いため未指定と同一視してよい。
      const messageTemplate = parseOptionalTextArg(args['message_template'])?.slice(0, 500);
      const priorityRaw = args['priority'];
      const priority =
        typeof priorityRaw === 'number' && Number.isFinite(priorityRaw)
          ? Math.max(0, Math.min(100, Math.round(priorityRaw)))
          : undefined;
      const isActive = typeof args['is_active'] === 'boolean' ? args['is_active'] : undefined;

      if (triggerType === undefined && triggerConfig === undefined && messageTemplate === undefined && priority === undefined && isActive === undefined) {
        return truncate('変更する内容がありません（trigger_type・trigger_config・message_template・priority・is_active のいずれかを指定してください）');
      }

      try {
        const existing = await db.query('SELECT id, tenant_id FROM trigger_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`声がけルール（ID: ${id}）が見つかりません`);
        }
        if (!isSuperAdmin && (existing.rows[0] as { tenant_id: string }).tenant_id !== tenantId) {
          return truncate('この声がけルールへのアクセス権限がありません');
        }

        const result = await db.query(
          `UPDATE trigger_rules SET
             trigger_type   = COALESCE($1, trigger_type),
             trigger_config = COALESCE($2::jsonb, trigger_config),
             message_template = COALESCE($3, message_template),
             priority       = COALESCE($4, priority),
             is_active      = COALESCE($5, is_active)
           WHERE id = $6
           RETURNING id, trigger_type, message_template, is_active`,
          [
            triggerType ?? null,
            triggerConfig ? JSON.stringify(triggerConfig) : null,
            messageTemplate ?? null,
            priority ?? null,
            isActive ?? null,
            id,
          ],
        );
        const row = result.rows[0] as { id: number; trigger_type: string; message_template: string; is_active: boolean };
        return truncate(`声がけルール（ID: ${id}）を更新しました: 「${row.trigger_type}」→ ${row.message_template}${row.is_active ? '' : '（現在無効）'}`);
      } catch (err) {
        logger.warn('[actionExecutor] update_engagement_rule failed', err);
        return truncate('声がけルールの更新に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'delete_engagement_rule': {
      const id = Number(args['id']);
      const confirmed = isConfirmed(args['confirmed']);

      if (!confirmed) {
        return truncate(`声がけルール（ID: ${id}）の削除には確認が必要です。confirmed=true を指定して再度実行してください`);
      }
      if (!Number.isFinite(id)) {
        return truncate('id が不正です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const existing = await db.query('SELECT id, tenant_id FROM trigger_rules WHERE id = $1', [id]);
        if (existing.rows.length === 0) {
          return truncate(`声がけルール（ID: ${id}）が見つかりません`);
        }
        if (!isSuperAdmin && (existing.rows[0] as { tenant_id: string }).tenant_id !== tenantId) {
          return truncate('この声がけルールへのアクセス権限がありません');
        }

        await db.query('DELETE FROM trigger_rules WHERE id = $1', [id]);
        return truncate(`声がけルール（ID: ${id}）を削除しました`);
      } catch (err) {
        logger.warn('[actionExecutor] delete_engagement_rule failed', err);
        return truncate('声がけルールの削除に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_chat_sessions': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      // limit はこのツール固有の既定値(10)・上限(20)を維持する(normalizeSessionListParams
      // 側の全ツール共通の既定値20とは意図的に異なる。会話コンテキストに載る量を絞るため)。
      // NaN等の非数値フォールバックは clampToolLimit に一本化済み。
      const limit = clampToolLimit(args['limit'], 10, 20);
      // sort_by/sort_order/period/sentiment/offset は LLM 由来の未検証な値なので、
      // getSessions() 自身も内部で再検証するが、ここでも allowlist ヘルパを必ず通す
      // (src/api/admin/CLAUDE.md の SQL 検証境界の規約)。args をそのまま渡さない。
      const normalized = normalizeSessionListParams(args);
      const search = typeof args['search'] === 'string' ? args['search'] : undefined;

      try {
        const { sessions, total } = await getSessions({
          tenantId,
          limit,
          offset: normalized.offset,
          sort_by: normalized.sort_by,
          sort_order: normalized.sort_order,
          period: normalized.period,
          sentiment: normalized.sentiment,
          search,
        });
        if (sessions.length === 0) {
          return truncate('会話セッションはありません');
        }
        const lines = sessions.map(
          (s) => `[${s.session_id.slice(0, 8)}] ${s.started_at.slice(0, 10)} (${s.message_count}件) 「${s.first_message_preview}」`,
        );
        return {
          text: truncateRead(`会話セッション一覧（全${total}件中${sessions.length}件）:\n` + lines.join('\n')),
          // card は次の1件を選ぶ操作のため。フロントは card.sessions[].shortId をそのまま
          // 次の get_chat_session_messages 呼び出しに使い、短縮IDの手打ちを不要にする。
          card: {
            kind: 'chat_session_list',
            total,
            sessions: sessions.map((s) => ({
              shortId: s.session_id.slice(0, 8),
              startedAt: s.started_at,
              messageCount: s.message_count,
              preview: s.first_message_preview,
              outcome: s.outcome,
            })),
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] get_chat_sessions failed', err);
        return truncate('会話セッション一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_chat_session_messages': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const limit = clampToolLimit(args['limit'], 20, 50);

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }

        // resolveSessionByShortId が存在確認済みのため null は実質到達しないが、
        // getMessages の戻り型が null|[] になった(CLAUDE.md 20)のでガードする。
        const messages = await getMessages({ sessionDbId: resolved.session.id, tenantId });
        if (messages === null || messages.length === 0) {
          return truncate(`セッション[${resolved.session.session_id.slice(0, 8)}]にメッセージはありません`);
        }

        const recent = messages.slice(-limit);
        const lines = recent.map((m) => `${CHAT_ROLE_LABELS[m.role] ?? m.role}: ${m.content}`);
        return {
          text: truncateRead(
            `セッション[${resolved.session.session_id.slice(0, 8)}]の会話（全${messages.length}件中${recent.length}件）:\n` +
            lines.join('\n'),
          ),
          card: {
            kind: 'chat_session_messages',
            shortId: resolved.session.session_id.slice(0, 8),
            totalMessages: messages.length,
            // role のラベル化はここ(CHAT_ROLE_LABELS)を単一の情報源とする。
            // フロント側に同じ辞書を二重に持たせない。
            messages: recent.map((m) => ({ role: m.role, roleLabel: CHAT_ROLE_LABELS[m.role] ?? m.role, content: m.content })),
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] get_chat_session_messages failed', err);
        return truncate('会話内容の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 会話セッションの完全削除。不可逆操作のため deleteSessionRepository.deleteSession()
    // (reason検証・audit_logs記録・行ロック・lock_timeoutを内包)を必ず経由し、
    // ここに削除SQLを新規に書かない。
    case 'delete_chat_session': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const reason = String(args['reason'] ?? '').trim();
      const confirmed = isConfirmed(args['confirmed']);

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }
        const display = resolved.session.session_id.slice(0, 8);

        if (reason.length < 5 || reason.length > 500) {
          return truncate(
            '削除理由(reason)は5文字以上500文字以内で指定してください。ユーザーに理由を尋ねてから再度実行してください',
          );
        }

        if (!confirmed) {
          // 契約文字列(BLOCKED_UNCONFIRMED_MARKER = '確認が必要です')を含めること。
          // agentRoutes.ts の計測(agent_write_blocked)とフロントのチップ出し分けが
          // この部分一致に依存している。
          return truncate(
            `セッション[${display}]の削除には確認が必要です。この操作は取り消せません。\n` +
            `理由: ${reason}\n` +
            'この内容でよいかユーザーに提示し、同意を得てから confirmed=true で再度実行してください',
          );
        }

        // previewMode中のsuper_adminでも常にtenantスコープで削除する(globalスコープを
        // 使わない)。resolveSessionByShortId が既に tenantId 条件でセッションを解決
        // しているため、ここで global に切り替えると所有権チェックの意味が消える。
        const result = await deleteSession({
          sessionDbId: resolved.session.id,
          scope: { kind: 'tenant', tenantId },
          actorRole: actor.role,
          actorEmail: actor.email,
          reason,
        });

        if (!result) {
          return truncate(`セッション[${display}]は見つかりません`);
        }

        return truncate(
          `セッション[${display}]を削除しました（メッセージ${result.affected_counts.chat_messages}件を含む）`,
        );
      } catch (err) {
        logger.warn('[actionExecutor] delete_chat_session failed', err);
        return truncate('会話セッションの削除に失敗しました。時間をおいて再度お試しください');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_conversation_evaluation': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }

        // conversation_evaluations.session_id は chat_sessions の公開文字列キー
        // (DBの内部UUIDではない)。resolveSessionByShortId が返す session_id をそのまま使う。
        const evaluations = await getEvaluationsBySession(resolved.session.session_id, tenantId);
        if (evaluations.length === 0) {
          // 未評価は0点や欠測として扱わず、明示する(閲覧側の判断材料を誤らせないため)。
          return truncate(`セッション[${resolved.session.session_id.slice(0, 8)}]はまだ未評価です`);
        }

        const ev = evaluations[0]!;
        // 4軸ラベルは旧UI(JudgeEvaluationSection.tsx)と同一の語彙を使う。
        // 同じ会話が面によって違う評価に見えてはならない。
        const axes: Array<{ label: string; score: number | null }> = [
          { label: '心理対応力', score: ev.psychology_fit_score },
          { label: '顧客対応力', score: ev.customer_reaction_score },
          { label: '商談進行力', score: ev.stage_progress_score },
          { label: '禁止事項の遵守率', score: ev.taboo_violation_score },
        ];
        const axesText = axes.map((a) => `${a.label}: ${a.score ?? '未測定'}`).join(' / ');
        const shortId8 = resolved.session.session_id.slice(0, 8);
        return {
          // notes はJudgeの自由記述で、書き込み系の500字予算(truncate)だと所見の
          // 大半が無言で切れうる(card側は全文を持つため、LLMだけが根拠を読めない
          // 非対称が起きる)。閲覧系の予算(truncateRead, 4000字+打ち切り注記)を使う。
          text: truncateRead(
            `セッション[${shortId8}]の対応品質評価: 総合${ev.overall_score}点\n${axesText}` +
            (ev.notes ? `\n所見: ${ev.notes}` : ''),
          ),
          card: {
            kind: 'conversation_evaluation',
            shortId: shortId8,
            overallScore: ev.overall_score,
            axes,
            notes: ev.notes,
          },
        };
      } catch (err) {
        logger.warn('[actionExecutor] get_conversation_evaluation failed', err);
        return truncate('評価データの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_escalations': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        // 件数を絞らないと、対応待ちが多いテナントでは閲覧系予算(truncateRead, 4000字)
        // でも末尾が切れる(1行あたり約110字のため36件前後が上限)。SQL側で先に絞り、
        // 「全N件中M件」を出して取りこぼしを可視化する(get_chat_sessions と同じ形)。
        const { escalations, total } = await getActiveEscalations(tenantId, ESCALATION_LIST_LIMIT);
        if (total === 0) {
          return truncate('対応中のエスカレーションはありません');
        }
        const lines = escalations.map(
          (e) => `[${e.session_id.slice(0, 8)}] ${e.escalated_at.slice(0, 16).replace('T', ' ')} 「${e.first_message_preview}」`,
        );
        return truncateRead(
          `対応中のエスカレーション（全${total}件中${escalations.length}件）:\n` + lines.join('\n'),
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_escalations failed', err);
        return truncate('エスカレーション一覧の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // 有人返信 / 対応完了: 旧UI(/admin/escalations)と同じ書き込みをチャットから行う。
    // セッションの特定は必ず resolveSessionByShortId 経由（tenant_id 条件込み）とし、
    // 他テナントのセッションへ書き込む経路を作らない。
    case 'reply_to_escalation': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const content = String(args['content'] ?? '').trim();
      const confirmed = isConfirmed(args['confirmed']);

      if (!content) {
        return truncate('返信内容（content）は必須です');
      }
      if (content.length > MAX_OPERATOR_REPLY_LENGTH) {
        return truncate(`返信内容は${MAX_OPERATOR_REPLY_LENGTH}文字以内で指定してください（現在${content.length}文字）`);
      }

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }
        const display = resolved.session.session_id.slice(0, 8);

        if (!confirmed) {
          return truncate(
            `お客様への返信には確認が必要です。セッション[${display}]に以下の文面を送信します。` +
            'ユーザーに提示し、同意を得てから confirmed=true で再度実行してください\n' +
            `返信内容: ${content}`,
          );
        }

        await saveMessage({
          tenantId,
          sessionId: resolved.session.session_id,
          role: 'operator',
          content,
        });
        return truncate(`セッション[${display}]への返信を保存しました。お客様の画面に表示されます`);
      } catch (err) {
        logger.warn('[actionExecutor] reply_to_escalation failed', err);
        return truncate('返信の送信に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'resolve_escalation': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const confirmed = isConfirmed(args['confirmed']);

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }
        const display = resolved.session.session_id.slice(0, 8);

        if (!confirmed) {
          return truncate(
            `対応完了にするには確認が必要です。セッション[${display}]を対応完了にすると、エスカレーション一覧から外れます。` +
            'ユーザーに提示し、同意を得てから confirmed=true で再度実行してください',
          );
        }

        const ok = await resolveEscalation({ sessionDbId: resolved.session.id, tenantId });
        if (!ok) {
          return truncate(`セッション[${display}]は見つかりません`);
        }
        return truncate(`セッション[${display}]のエスカレーションを対応完了に更新しました`);
      } catch (err) {
        logger.warn('[actionExecutor] resolve_escalation failed', err);
        return truncate('対応完了の記録に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_session_outcome': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }
        const display = resolved.session.session_id.slice(0, 8);

        const outcome = await getSessionOutcome(resolved.session.id);
        if (!outcome?.outcome) {
          return truncate(`セッション[${display}]の成果はまだ記録されていません`);
        }
        return truncate(
          `セッション[${display}]の成果: ${outcome.outcome}` +
          (outcome.outcomeRecordedAt ? `（${outcome.outcomeRecordedAt.slice(0, 10)}に記録）` : ''),
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_session_outcome failed', err);
        return truncate('成果の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'record_session_outcome': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const shortId = String(args['session_id'] ?? '').trim();
      const outcomeValue = String(args['outcome'] ?? '').trim();
      const confirmed = isConfirmed(args['confirmed']);

      if (!outcomeValue) {
        return truncate('outcome（記録する成果）は必須です');
      }

      try {
        const resolved = await resolveSessionByShortId(db, tenantId, shortId);
        if (!resolved.ok) {
          return truncate(resolved.message);
        }
        const display = resolved.session.session_id.slice(0, 8);

        const conversionTypes = await getConversionTypes(tenantId);
        if (!conversionTypes.includes(outcomeValue)) {
          return truncate(
            `「${outcomeValue}」はこのテナントの成果選択肢に含まれていません。有効な選択肢: ${conversionTypes.join(' / ')}`,
          );
        }

        if (!confirmed) {
          return truncate(
            `セッション[${display}]の成果を「${outcomeValue}」として記録するには確認が必要です。` +
            'ユーザーに提示し、同意を得てから confirmed=true で再度実行してください',
          );
        }

        const recorded = await recordOutcome({
          sessionDbId: resolved.session.id,
          tenantId,
          outcome: outcomeValue,
          // actor.email は '' になりうる('' は audit_logs 上 null と区別する意味を
          // 持たないため null に正規化する。HTTP経路(routes.ts)と同じ規約)。
          recordedBy: actor.email || null,
        });
        if (!recorded) {
          // 直前のresolveSessionByShortIdでは存在確認済みのため通常到達しないが、
          // 競合(削除)に備える。
          return truncate(`セッション[${display}]が見つかりませんでした`);
        }
        return truncate(`セッション[${display}]の成果を「${outcomeValue}」として記録しました`);
      } catch (err) {
        logger.warn('[actionExecutor] record_session_outcome failed', err);
        return truncate('成果の記録に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_monitoring_summary': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      try {
        const kpis = await computeKpis(db, tenantId);
        return truncate(
          `直近30日間のサマリー:\n会話数 ${kpis.totalSessions}件\n完了率 ${kpis.completionRate}%\nフォールバック率（AIが答えられなかった割合） ${kpis.fallbackRate}%`,
        );
      } catch (err) {
        logger.warn('[actionExecutor] get_monitoring_summary failed', err);
        return truncate('モニタリングサマリーの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // Saiへの代行依頼: テナント(client_admin)・super_admin共通で利用可能。
    // 費用は一回限りの即時課金ではなく、他のLLM機能(admin_agent等)と同じ従量課金
    // (trackUsage → usage_logs → 月次Stripe請求)に計上される。
    case 'request_sai_task': {
      const confirmed = isConfirmed(args['confirmed']);
      const description = String(args['description'] ?? '').trim().slice(0, 2000);

      if (!confirmed) {
        return truncate('Saiへの依頼には確認が必要です。作業内容をユーザーに提示し、同意を得てから confirmed=true で再度実行してください');
      }
      if (!description) {
        return truncate('description は必須です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      // GID 1216944249525907: LP料金表(Enterprise〜: Sai代行)に基づくプラン制限。
      // super_adminは従来どおりバイパス。fail-safe: plan取得失敗時はstarter扱い(=拒否)。
      if (!isSuperAdmin) {
        const plan = await queryTenantPlan(db, tenantId);
        if (!planHasFeature(plan, 'sai_task')) {
          return truncate(planLimitNotice(tenantId, sessionId, 'sai_task'));
        }
      }

      try {
        const ceilingCheck = await checkSaiMonthlyCostCeiling(db, tenantId);
        if (!ceilingCheck.ok) {
          logger.warn({ event: 'sai_cost_ceiling_blocked', tenantId, ...ceilingCheck }, 'request_sai_task blocked: monthly cost ceiling reached');
          const msg =
            ceilingCheck.reason === 'global'
              ? 'Saiの全体月次コスト上限に達しているため、今回は依頼できません。管理者に確認してください'
              : 'Saiの月次コスト上限に達しているため、今回は依頼できません。管理者に確認してください';
          return truncate(msg);
        }

        const { task_id } = await submitSaiTask({ description });

        // 所有権を記録してからでないと、あとで進捗を照会できない（照合先が無いと
        // fail-closed で拒否される）。記録に失敗しても依頼自体は VPS 側で進行して
        // いるため、成功を装わず「進捗確認ができない」ことを明示して返す。
        const recorded = await recordSaiTask(db, {
          taskId: task_id,
          tenantId,
          description,
          requestedBy: actor.email || null,
        });
        if (!recorded) {
          return truncate(
            `Saiにタスクを依頼しました（タスクID: ${task_id}）。` +
            'ただし依頼の記録に失敗したため、このタスクの進捗はチャットから確認できません。' +
            'お手数ですが運営（R2Cサポート）にタスクIDをお伝えください',
          );
        }
        return truncate(`Saiにタスクを依頼しました（タスクID: ${task_id}）。get_sai_task_status で進捗を確認できます`);
      } catch (err: any) {
        if (err?.message === 'SAI_API_KEY not set') {
          return truncate('Saiが設定されていません');
        }
        logger.warn('[actionExecutor] request_sai_task failed', err);
        return truncate('Saiへの依頼に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_sai_task_status': {
      const taskId = String(args['task_id'] ?? '').trim();
      if (!taskId) {
        return truncate('task_id は必須です');
      }
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      // 所有権照合。task_id は LLM/ユーザー由来の文字列なので、依頼元テナントと
      // 一致しない限り Sai VPS へ問い合わせない（越境で status/outcome/last_action が
      // 読め、さらに他テナント分のステップが自テナントに計上されてしまうため）。
      // super_admin もバイパスしない — チャット経路は常に実効テナントスコープで動く
      // （previewMode 中は isSuperAdmin のまま対象テナントを見ているため、
      //   ここでロールを見ると preview の意味が壊れる）。
      const owner = await resolveSaiTaskTenant(db, taskId);
      if (owner.status === 'unavailable') {
        return truncate(
          'タスクの進捗を確認できませんでした。時間をおいて再度お試しいただくか、' +
          '解消しない場合は運営（R2Cサポート）にご連絡ください',
        );
      }
      // 越境は「権限がない」ではなく「不存在」に倒す（IDの実在を漏らさない）。
      if (owner.status === 'not_found' || owner.tenantId !== tenantId) {
        return truncate(
          `タスクID「${taskId}」の依頼が見つかりません。IDをご確認のうえ、` +
          'もう一度お知らせください',
        );
      }

      try {
        const task = await getSaiTask(taskId);

        // 完了時のみ、他のLLM機能と同じ従量課金ロジックでコストを計上する
        // (requestIdをtask_idで固定し、再ポーリングでも二重計上しない)
        if (task.status === 'complete' && tenantId) {
          trackUsage({
            tenantId,
            requestId: `sai-agent-request:${taskId}`,
            model: 'agent-s',
            inputTokens: 0,
            outputTokens: 0,
            featureUsed: 'sai_agent',
            saiAgentSteps: task.steps,
          });
        }

        const lines = [
          `状態: ${task.status}`,
          `ステップ: ${task.steps}/${task.max_steps}`,
        ];
        if (task.outcome) lines.push(`自己申告: ${task.outcome}（自己申告は信用しない設計のため、最終スクリーンショットを目視確認してから完了させてください）`);
        if (task.last_action) lines.push(`直近の操作: ${task.last_action}`);
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn('[actionExecutor] get_sai_task_status failed', err);
        return truncate('Saiタスクの状態取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    case 'get_legacy_ui_link': {
      const feature = String(args['feature'] ?? '');
      const LEGACY_UI_LINKS: Record<string, { label: string; path: string; description: string }> = {
        // 請求書の再送・金額調整・無料期間設定・一時停止/再開は実装上すべてsuper_adminガードの
        // 内側にあり、テナントがこの画面へ行っても実行できない。案内文はテナントが実際に
        // できること(利用量・請求額の確認)だけを書く。
        billing: {
          label: '請求管理',
          path: '/admin/billing',
          description: '今月の利用量と請求額の確認はこちらの画面で行えます',
        },
        avatar_studio: {
          label: 'アバタースタジオ',
          path: '/admin/avatar/studio',
          description: '画像候補の選択・音声クローン・性格設定・ライブテストはこちらの画面で行えます',
        },
        escalation_reply: {
          label: 'エスカレーション対応',
          path: '/admin/escalations',
          description: '有人での返信・対応記録はこちらの画面で行えます',
        },
        session_deletion: {
          label: '会話履歴',
          path: '/admin/chat-history',
          description: '会話内容の確認とその会話セッションの削除はこちらの画面で行えます',
        },
        analytics: {
          label: '会話分析',
          path: '/admin/analytics',
          description: '会話数・満足度スコア・品質指標の推移や低評価セッションの確認はこちらの画面で行えます',
        },
        conversion: {
          label: '成約・効果分析',
          path: '/admin/conversion',
          description: '成約への貢献度・ABテスト・効果測定の確認はこちらの画面で行えます',
        },
        chat_test: {
          label: 'テストチャット',
          path: '/admin/chat-test',
          description: '設定した内容を実際のチャットで試すのはこちらの画面で行えます',
        },
        avatar_wizard: {
          label: 'アバター新規作成',
          path: '/admin/avatar/wizard',
          description: 'アバターを新しく作る手順（ウィザード）はこちらの画面で行えます',
        },
        // GID 1217040818410419(2026-07-31): 「書籍/PDFはR2C運用限定」の方針により、
        // このキー自体はテナント向けの案内としてはもう使わない(system prompt からも誘導文を除去済み)。
        // それでも feature enum とキーは残す — 削除すると LEGACY_UI_FEATURES から漏れ、
        // agent_legacy_handoff{feature} のトリップワイヤー(docs/LEGACY_UI_SUNSET.md)が
        // 無言で 'unknown' に丸められて死ぬため。path/label は旧UIの実体(super_adminには
        // 引き続き見える画面)に合わせたまま、description だけ現状に更新する。
        // /admin/knowledge (tenantId無し)は KnowledgeIndexPage が navigate() で
        // /admin/knowledge/:tenantId へリダイレクトする際に location.search を引き継がず
        // ?tab=pdf が失われるため、他のキーと異なりここでは tenantId を path に含める必要がある
        // (下のガードで !tenantId は事前に弾いている)。
        knowledge_pdf: {
          label: 'PDFアップロード',
          path: `/admin/knowledge/${tenantId}?tab=pdf`,
          description: 'PDFファイルからの知識登録は現在R2C運営チームが行っています。内容を文章で教えていただければ、代わりに登録できます。',
        },
        // knowledge_pdf と同じ理由でtenantIdをpathに含める必要がある(下のガードで !tenantId は事前に弾いている)。
        // GET /v1/admin/analytics/knowledge-attribution にプラン制限は無いため、ここでもゲートを設けない
        // (R2Cは従量課金であり、上限/プランゲートを反射的に足す方針ではない。conversion等の既存ゲートは模倣しない)。
        knowledge_attribution: {
          label: '成約への貢献度',
          path: `/admin/knowledge/${tenantId}?tab=attribution`,
          description: 'ナレッジ(FAQ・書籍)ごとの成約への貢献度はこちらの画面で確認できます',
        },
        // knowledge_pdf と同じ理由でtenantIdをpathに含める必要がある(下のガードで !tenantId は事前に弾いている)。
        faq_publish_toggle: {
          label: 'AIの知識データ',
          path: `/admin/knowledge/${tenantId}`,
          description: 'FAQごとにAIが答えるかどうかを切り替えられます',
        },
        faq_bulk_ops: {
          label: 'AIの知識データ',
          path: `/admin/knowledge/${tenantId}`,
          description: 'まとめて非公開・まとめて削除はこちらの画面です',
        },
        avatar_feature_toggle: {
          label: 'アバター設定',
          path: '/admin/avatar',
          description: 'アバター機能全体のON/OFFはこちらの画面です',
        },
        avatar_profile: {
          label: 'アバタースタジオ',
          path: '/admin/avatar/studio',
          description: '名前・性格・話し方の編集はこちらの画面です',
        },
        avatar_premium: {
          label: 'アバター新規作成',
          path: '/admin/avatar/wizard',
          description: '高品質な画像の生成はこちらの画面です',
        },
      };

      // GID: LP料金表(Growth〜: 高度なAnalytics、CV計測、AIアバター、プレミアムアバター生成)に
      // 基づくプラン制限。AppSidebar.tsx(225行付近)とは異なり、ここでは super_admin も
      // バイパスさせない。super_admin がこの新UIに入る経路は「クライアントビューで見る」
      // (previewMode)であり、目的はテナントに見えている状態の再現なので、Starterテナントの
      // プレビューでGrowth限定機能の案内を出すのは再現として誤り。読み取り専用の案内でしかなく、
      // planFeatures.ts の GID 1216961878992581 が扱う「永続的な権能付与 vs 都度原価」の
      // 判断軸（activate_avatar 等）にも当てはまらない。
      // avatar_feature_toggle(ON/OFF切替) / avatar_premium(高品質生成) は実際の操作先が
      // 403 plan_upgrade_required で拒否される(routes.ts / premiumGenerationRoutes.ts)ため、
      // 案内リンク側でも同じ制限を返す — さもないと使えない画面へ自信満々に案内してしまう。
      // get_legacy_ui_link の feature 語彙と GatedFeature/PlanLimitedFeature の語彙が
      // 異なるキーは、ここで対応付ける。
      const PLAN_GATED_LEGACY_FEATURES: Partial<Record<string, PlanLimitedFeature>> = {
        analytics: 'analytics',
        conversion: 'conversion',
        avatar_feature_toggle: 'avatar',
        avatar_premium: 'premium_avatar',
      };
      const gatedFeature = PLAN_GATED_LEGACY_FEATURES[feature];
      if (gatedFeature) {
        if (!tenantId) {
          return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
        }
        const plan = await queryTenantPlan(db, tenantId);
        if (!planHasFeature(plan, gatedFeature)) {
          return truncate(planLimitNotice(tenantId, sessionId, gatedFeature));
        }
      }

      // knowledge_pdf / knowledge_attribution / faq_publish_toggle / faq_bulk_ops は
      // path に tenantId を埋め込む都合上、他のキーと違い必須。
      if (
        (feature === 'knowledge_pdf' ||
          feature === 'knowledge_attribution' ||
          feature === 'faq_publish_toggle' ||
          feature === 'faq_bulk_ops') &&
        !tenantId
      ) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }

      const link = LEGACY_UI_LINKS[feature];
      if (!link) {
        return truncate(`不明な案内先です: ${feature}`);
      }

      // session_deletion で対象の会話が分かっているときは、一覧ではなくその会話を直接開くリンクにする
      // (一覧から探し直させないため)。解決できない場合(存在しない/曖昧/他テナント)は一覧へ素直に戻す。
      let path = link.path;
      if (feature === 'session_deletion' && tenantId) {
        const shortId = String(args['session_id'] ?? '').trim();
        if (shortId) {
          try {
            const resolved = await resolveSessionByShortId(db, tenantId, shortId);
            if (resolved.ok) {
              path = `/admin/chat-history/${resolved.session.id}`;
            }
          } catch (err) {
            logger.warn('[actionExecutor] get_legacy_ui_link session resolve failed', err);
          }
        }
      }

      // avatar_studio / avatar_profile はどちらも同じ studio.tsx (/admin/avatar/studio)へ
      // 案内するため、同じ解決ロジックを適用する。avatar_config_id が渡っていればそれを使い
      // (tenant_id条件により、他テナントのIDは越境せず「不存在」側に倒れる)、渡っていなければ
      // 稼働中(is_active=true)の設定を1件解決して使う。どちらも解決できないときだけ
      // 従来のID無しURLに戻す。studio.tsx はID無しだと新規作成の空フォームで開くため、
      // 既存アバターを編集しているつもりの利用者(例: 「音声クローンをした」「名前を変えたい」)が
      // 意図せず別の新規アバターを作ってしまう事故を防ぐ(session_deletion の既存パターンに倣う)。
      if ((feature === 'avatar_studio' || feature === 'avatar_profile') && tenantId) {
        const configId = String(args['avatar_config_id'] ?? '').trim();
        try {
          if (configId) {
            const resolved = await db.query<{ id: string }>(
              `SELECT id FROM avatar_configs WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
              [configId, tenantId]
            );
            if (resolved.rows.length > 0) {
              path = `/admin/avatar/studio/${resolved.rows[0].id}`;
            }
          } else {
            const activeRes = await db.query<{ id: string }>(
              `SELECT id FROM avatar_configs WHERE tenant_id = $1 AND is_active = true LIMIT 1`,
              [tenantId]
            );
            if (activeRes.rows.length > 0) {
              path = `/admin/avatar/studio/${activeRes.rows[0].id}`;
            }
          }
        } catch (err) {
          logger.warn('[actionExecutor] get_legacy_ui_link avatar_studio resolve failed', err);
        }
      }

      // 冒頭は「できません」ではなく「どこでできるか」から始める(行き止まりに見せない)。
      // 続く3行(画面:/URL:/説明:)は copilot-preview の parseLegacyUiLink が
      // リンクカード描画のために正規表現で読む契約なので、順序・ラベルを変えないこと。
      // card を併せて返すことで新しいクライアントは正規表現を経ずに描画できるが、
      // 自然文だけを見る経路(LLMへの差し戻し・旧クライアント)のために text は不可欠。
      // 失敗パス(プラン制限・不明なfeature等)は素の文字列を返すため、押せないリンク
      // カードが出ないという性質は card 側でもそのまま保たれる。
      return {
        text: truncate(`この操作は${link.label}画面から行えます。\n画面: ${link.label}\nURL: ${path}\n説明: ${link.description}`),
        card: { kind: 'legacy_link', label: link.label, url: path, description: link.description },
      };
    }

    // -----------------------------------------------------------------------
    case 'get_analytics_summary':
    case 'get_conversion_summary': {
      const feature = toolName === 'get_analytics_summary' ? 'analytics' : 'conversion';

      // get_legacy_ui_link の analytics/conversion と同じ扱い。super_admin もバイパスさせない
      // （クライアントビューはテナントに見えている状態の再現が目的のため）。
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const plan = await queryTenantPlan(db, tenantId);
      if (!planHasFeature(plan, feature)) {
        return truncate(planLimitNotice(tenantId, sessionId, feature));
      }

      // W2-8: 以前は '7d' 以外をすべて '30d' に丸めていたため、'90d' を指定しても黙って
      // 30日に差し替わっていた(旧UIの analytics/utils.ts PERIOD_LABELS は7d/30d/90dの3つ)。
      // periodToInterval(summaryQueries.ts) は既に90dに対応済みで、この2行だけが穴だった。
      const period = args['period'] === '7d' || args['period'] === '90d' ? args['period'] : '30d';
      const periodLabel = period === '7d' ? '直近7日間' : period === '90d' ? '直近90日間' : '直近30日間';

      try {
        if (toolName === 'get_analytics_summary') {
          const s = await fetchAnalyticsSummary({ db, tenantId, period });
          const sent = s.sentiment_distribution;
          const lines = [
            `会話分析サマリー（${periodLabel}）`,
            `• 会話数: ${s.total_sessions}件（前期間 ${s.prev_total_sessions}件 / ${s.sessions_change_pct >= 0 ? '+' : ''}${s.sessions_change_pct.toFixed(1)}%）`,
            `• 満足度スコア: ${s.avg_judge_score != null ? s.avg_judge_score.toFixed(1) : '評価データなし'}`,
            `• 1会話あたりのメッセージ数: ${s.avg_messages_per_session.toFixed(1)}件`,
            `• 答えられなかった質問: ${s.total_knowledge_gaps}件`,
          ];
          if (sent.total > 0) {
            lines.push(`• 感情の内訳: ポジティブ${sent.positive} / ネガティブ${sent.negative} / ニュートラル${sent.neutral}`);
          }
          return truncate(lines.join('\n'));
        }

        const c = await fetchConversionSummary({ db, tenantId, period });
        const lines = [
          `成約・効果分析サマリー（${periodLabel}）`,
          `• 会話数: ${c.summary.total_sessions}件（うち結果記録済み ${c.summary.recorded_outcomes}件 / 記録率 ${c.summary.recording_rate}%）`,
        ];
        const outcomeEntries = Object.entries(c.summary.outcomes);
        if (outcomeEntries.length > 0) {
          lines.push(`• 結果の内訳: ${outcomeEntries.map(([k, v]) => `${k} ${v}件`).join(' / ')}`);
        }
        const topTechniques = c.technique_effectiveness.slice(0, 3);
        if (topTechniques.length > 0) {
          lines.push(`• 成果の高い話法: ${topTechniques.map((t) => `${t.technique} ${t.conversion_rate}%（${t.sessions_used}件）`).join(' / ')}`);
        }
        const topDropout = Object.entries(c.stage_dropout)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])[0];
        if (topDropout) {
          lines.push(`• 離脱が最も多いステージ: ${topDropout[0]}（${topDropout[1]}件）`);
        }
        return truncate(lines.join('\n'));
      } catch (err) {
        logger.warn(`[actionExecutor] ${toolName} failed`, err);
        return truncate('分析サマリーの取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    // GID 1217752900578379 (R4): 承認済みルールの効果(DiD推定)をチャットから確認する。
    // 母数不足のときは点推定・率・矢印を一切出さず到達条件のみ返す(CLAUDE.md 禁止34)。
    case 'get_tuning_rule_effect': {
      if (!tenantId) {
        return truncate('テナントが特定できません。super_admin の場合は対象テナントを指定してください');
      }
      const ruleId = Number(args['rule_id']);
      if (!Number.isFinite(ruleId)) {
        return truncate('ルールIDを指定してください');
      }

      try {
        const result = await getRuleEffect(db, ruleId);

        if (result.status === 'rule_not_found') {
          return truncate('指定されたルールが見つかりません');
        }
        // 越境防止: 他テナントのルールIDを直接指定されても、存在有無を漏らさず
        // 「見つからない」に倒す(r2c-tenant-isolation)。
        if (result.tenantId !== tenantId) {
          return truncate('指定されたルールが見つかりません');
        }
        if (result.status === 'not_yet_approved') {
          return truncate('このルールはまだ承認されていません。承認後に効果を確認できます');
        }

        if (result.status === 'insufficient_data') {
          // ruleEffect.ts の4群ラベル。旧UIに同等の表示は無いためここが唯一の語彙
          // (フロントに同じ辞書を二重持ちさせない。ConversationEvaluationCardPayload の
          // axes[].label / ChatSessionMessagesCardPayload の roleLabel と同じ作法)。
          const groupLabel: Record<string, string> = {
            beforeTreatment: '承認前・該当する会話',
            afterTreatment: '承認後・該当する会話',
            beforeControl: '承認前・該当しない会話',
            afterControl: '承認後・該当しない会話',
          };
          const card: RuleEffectCardPayload = {
            kind: 'rule_effect',
            ruleId,
            approvedAt: result.approvedAt,
            truncated: result.truncated,
            analyzedSessions: result.analyzedSessions,
            comparison: null,
            progress: result.progress.map((p) => ({
              group: p.group,
              groupLabel: groupLabel[p.group] ?? p.group,
              currentN: p.currentN,
              requiredN: p.requiredN,
              etaDays: p.etaDays,
            })),
          };
          const lines = [
            `指示ルール（ID: ${ruleId}）はまだ効果を判定できません（判定に必要な会話数が不足しています）`,
          ];
          for (const p of card.progress!) {
            const eta = p.etaDays != null ? `、現ペースであと約${p.etaDays}日` : '';
            lines.push(`・${p.groupLabel}: 現在${p.currentN}件 / 必要${p.requiredN}件${eta}`);
          }
          return { text: truncate(lines.join('\n')), card };
        }

        // status === 'ok'
        const { did, naiveTreatmentDelta } = result.comparison;
        const [ciLow, ciHigh] = did.ci95;
        const card: RuleEffectCardPayload = {
          kind: 'rule_effect',
          ruleId,
          approvedAt: result.approvedAt,
          truncated: result.truncated,
          analyzedSessions: result.analyzedSessions,
          comparison: {
            didEstimate: did.estimate,
            ci95Low: ciLow,
            ci95High: ciHigh,
            naiveTreatmentDelta,
          },
          progress: null,
        };
        const verdict =
          card.comparison!.ci95Low > 0
            ? '効いている可能性が高いです'
            : card.comparison!.ci95High < 0
              ? '逆効果の可能性があります'
              : 'まだ判定できません（差が誤差の範囲内です）';
        const lines = [
          `指示ルール（ID: ${ruleId}）の効果: ${verdict}`,
          `推定差分: ${card.comparison!.didEstimate}点（95%信頼区間: ${card.comparison!.ci95Low}〜${card.comparison!.ci95High}）`,
          `参考（対照群との比較前の単純差分）: ${card.comparison!.naiveTreatmentDelta}点`,
        ];
        if (card.truncated) {
          lines.push(`※直近${card.analyzedSessions}件のセッションで判定しています`);
        }
        return { text: truncate(lines.join('\n')), card };
      } catch (err) {
        logger.warn('[actionExecutor] get_tuning_rule_effect failed', err);
        return truncate('ルール効果の取得に失敗しました');
      }
    }

    // -----------------------------------------------------------------------
    default:
      return truncate(`不明なツール: ${toolName}`);
  }
}
