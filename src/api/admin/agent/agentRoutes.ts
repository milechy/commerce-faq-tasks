// src/api/admin/agent/agentRoutes.ts
// Phase B-Admin: POST /v1/admin/agent/chat

import type { Express, Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { supabaseAuthMiddleware } from '../../../admin/http/supabaseAuthMiddleware';
import { logger } from '../../../lib/logger';
import { ADMIN_AGENT_TOOLS, LEGACY_UI_FEATURES } from './toolDefinitions';
import { executeToolCall, parseBooleanArg } from './actionExecutor';
import type { ActionResult, ActionCardPayload } from './actionExecutor';
import { requiresConfirmation, WRITE_TOOL_RISK_TIERS } from './confirmPolicy';
import { trackUsage } from '../../../lib/billing/usageTracker';
import { recordAgentMetric, type AgentMetricInput } from '../../../lib/metrics/agentMetrics';
import { recordAgentSettingsChange } from './agentAuditLog';
import { GPT_OSS_120B, groqReasoningParams } from '../../../config/groqModels';
import { isUnanswered } from '../ai-assist/systemPrompt';

// ---------------------------------------------------------------------------
// 挙動メトリクス（metric_name / labels / value の契約は docs/AGENT_METRICS.md）
// ---------------------------------------------------------------------------

// ブロック判定の部分一致。フロント(copilot-preview)が確認待ちUIの出し分けに使うのと同じ規約だが、
// get_embed_code の成功文「再確認が必要な場合は〜」を誤ってブロックと数えないよう「です」まで含める。
const BLOCKED_UNCONFIRMED_MARKER = '確認が必要です';
const BLOCKED_CHAIN_MARKER = '確認をスキップできません';

// ラベルの語彙を有界に保つためのホワイトリスト。値は列挙し直さず toolDefinitions の
// feature enum から導出する（ここに写しを持つと、旧UIページ閉鎖でenumから値を消しても
// 閉鎖済みページ宛の handoff が 'unknown' に落ちず自分の名前で記録され続け、
// docs/LEGACY_UI_SUNSET.md のトリップワイヤーが無言で作動しなくなる）。
const LEGACY_HANDOFF_FEATURES = new Set<string>(LEGACY_UI_FEATURES);

// 全メトリクスに載せる「どちらのチャットUIから来たターンか」。リクエストが surface を
// 送ってこない場合(この項目より前のクライアント / 直接APIを叩く経路)は 'unknown' に丸める。
// docs/AGENT_METRICS.md: この項目以前に記録された行はキー自体を持たないため、
// 'unknown' と「キーなし」は集計上区別できる別物である。
type MetricSurface = 'panel' | 'fullscreen' | 'unknown';

/** 計測は fire-and-forget。記録の失敗をチャット応答に一切影響させない。 */
function fireAgentMetric(db: Pool, input: AgentMetricInput): void {
  try {
    void Promise.resolve(recordAgentMetric(db, input)).catch(() => undefined);
  } catch {
    // 計測失敗は応答に影響させない
  }
}

function classifyToolResult(result: string): {
  outcome: 'ok' | 'blocked';
  reason?: 'unconfirmed' | 'chain';
} {
  if (result.includes(BLOCKED_CHAIN_MARKER)) return { outcome: 'blocked', reason: 'chain' };
  if (result.includes(BLOCKED_UNCONFIRMED_MARKER)) return { outcome: 'blocked', reason: 'unconfirmed' };
  return { outcome: 'ok' };
}

// ---------------------------------------------------------------------------
// 設定変更の監査ログ（tenant_settings_history。旧UI PATCH /v1/admin/tenants/:id と同じテーブル）
// ---------------------------------------------------------------------------

// 「テナント単位の単一設定フィールドを変える」ツールだけを対象にする。
// FAQ・指示ルール・エンゲージメントルール・エスカレーションは実体（エンティティ）の
// 書き込みであり field_name/old_value/new_value の形に収まらないため対象外
// （別テーブルが必要になるので将来の別タスク）。
//
// successMarker: classifyToolResult の ok/blocked 判定だけでは足りないため併用する。
// 確認ゲート以外の理由で書き込みが行われなかったケース（activate_avatar のプラン制限、
// set_ga4_id の形式不正、DB例外時の失敗メッセージ）は blocked マーカーを含まないため
// outcome=ok に落ちる。それをそのまま記録すると「実際には変更されていない変更」が
// 監査ログに残るので、各ツールの成功メッセージの一致も必須条件にする
// （メッセージ変更で無言に記録が止まらないよう、4ツール分すべてを
//  agentRoutes.test.ts の「設定変更の監査ログ」で固定している）。
const AUDITED_SETTINGS_TOOLS: Record<
  string,
  { fieldName: string; successMarker: string; readNewValue: (args: Record<string, unknown>) => unknown }
> = {
  set_ga4_id: {
    fieldName: 'ga4_measurement_id',
    successMarker: 'に設定しました',
    readNewValue: (args) => args['measurement_id'],
  },
  set_posthog: {
    fieldName: 'posthog_host',
    successMarker: 'に設定しました',
    readNewValue: (args) => args['host'],
  },
  // 実装は既存 widget_theme への JSONB マージなので、記録されるのは「今回当てた差分」。
  set_widget_theme: {
    fieldName: 'widget_theme',
    successMarker: 'を更新しました',
    readNewValue: (args) => args['theme'],
  },
  // tenants の列ではないが、テナントで稼働中のアバター設定という単一の設定値。
  activate_avatar: {
    fieldName: 'active_avatar_config_id',
    successMarker: 'を有効化しました',
    readNewValue: (args) => args['id'],
  },
  // GID 1217535352042856(E1): tenants.features.avatar(マスターON/OFF)。
  // PATCH /v1/admin/my-tenant と同じ tenant_settings_history に記録する。
  set_avatar_feature: {
    fieldName: 'features.avatar',
    successMarker: 'アバター機能を',
    // /code-review high 指摘: Groqがbooleanを文字列化して送ることがある(actionExecutor.ts
    // 76-90行目)。case側はparseBooleanArgで正規化してから実行するが、ここで生のargsを
    // そのまま読むと "true"(文字列)がbooleanのつもりで監査ログに残ってしまう。
    readNewValue: (args) => parseBooleanArg(args['enabled']),
  },
  // GID 1216978677372391(PR-16, D1) / 共有学習プールの参加モデル S4:
  // tenants.features.learning = {learn, share}。learn=自社内学習(外に出ない)、
  // share=共有プール参加(外部Hermes VPSへ出る)。actionExecutor.ts の
  // case 'set_hermes_consent' 参照。newValueは「今回引数で指定された軸のみ」を
  // 記録する(set_widget_theme と同じ「当てた差分だけ」の考え方。旧enabled引数は
  // shareとして解釈する後方互換)。
  set_hermes_consent: {
    fieldName: 'features.learning',
    successMarker: '学習設定を更新しました',
    readNewValue: (args) => {
      const learn = parseBooleanArg(args['learn']);
      const shareRaw = parseBooleanArg(args['share']);
      const enabled = parseBooleanArg(args['enabled']);
      const share = shareRaw !== undefined ? shareRaw : enabled;
      const value: Record<string, boolean> = {};
      if (learn !== undefined) value['learn'] = learn;
      if (share !== undefined) value['share'] = share;
      return value;
    },
  },
  // オンボ 是正B-2: オンボ2ツールが未登録で tenant_settings_history に一切記録されず、
  // 「各段階の到達に actor が記録される」(AC-4)が未達だった。successMarker は
  // 下のonboarding_stage_reachedメトリクス発火(478行目付近)と同じ文字列に揃える。
  import_industry_faq_templates: {
    fieldName: 'onboarding_industry',
    successMarker: '下書きとして登録しました',
    readNewValue: (args) => args['industry'],
  },
  publish_faq_drafts: {
    fieldName: 'faq_docs_published',
    successMarker: '件のFAQを公開しました',
    // 公開対象のFAQ ID等はactionExecutor内部の戻り値にしかなくargsからは取れないため、
    // 「公開操作が行われた」ことのみを記録する。
    readNewValue: () => true,
  },
};

/** 監査記録も fire-and-forget。記録の失敗をチャット応答に一切影響させない。 */
function fireSettingsAudit(
  db: Pool,
  params: { tenantId: string; changedBy: string; fieldName: string; newValue: unknown },
): void {
  try {
    void Promise.resolve(
      recordAgentSettingsChange(db, {
        tenantId: params.tenantId,
        changedBy: params.changedBy,
        fieldName: params.fieldName,
        // 変更前の値は 45分岐の case 本体からは取り出せない（取り出すには case 側の
        // 改変が必要になる）。migration の COMMENT どおり NULL =「初期値不明」として記録する。
        oldValue: null,
        newValue: params.newValue,
      }),
    ).catch(() => undefined);
  } catch {
    // 監査記録の失敗は応答に影響させない
  }
}

function recordTurnCompleted(
  db: Pool,
  params: {
    tenantId: string | null;
    toolHops: number;
    hitHopLimit: boolean;
    answeredFrom: AnsweredFrom;
    surface: MetricSurface;
  },
): void {
  fireAgentMetric(db, {
    metricName: 'agent_turn_hops',
    tenantId: params.tenantId,
    labels: { hit_limit: params.hitHopLimit, surface: params.surface },
    value: params.toolHops,
  });
  fireAgentMetric(db, {
    metricName: 'agent_turn_completed',
    tenantId: params.tenantId,
    labels: { answered_from: params.answeredFrom, surface: params.surface },
    value: 1,
  });
}

// ---------------------------------------------------------------------------
// answered_from: このターンの回答がどこから来たかをUIに伝える
// ---------------------------------------------------------------------------

type AnsweredFrom = 'faq_list' | 'tool_action' | 'general';

// クライアントへ返すツール実行結果。result(自然文)は構造化ツールでも必ず入るので
// 既存クライアントと既存の正規表現パーサはそのまま動き、card は追加でのみ載る。
type ChatAction = { tool: string; result: string; card?: ActionCardPayload };

function determineAnsweredFrom(actions: Array<{ tool: string; result: string }>): AnsweredFrom {
  if (actions.some((a) => a.tool === 'get_faq_list')) return 'faq_list';
  if (actions.length > 0) return 'tool_action';
  return 'general';
}

// ---------------------------------------------------------------------------
// 未回答質問の自動記録: ツール未使用かつ回答が「わかりません」系の場合のみ、
// admin_feedback に knowledge_gap として記録する（ai-assist/routes.ts の
// recordFeedback と同パターン）。失敗しても本処理は継続する。
// ---------------------------------------------------------------------------

async function recordUnansweredFeedback(
  db: Pool,
  params: {
    tenantId: string;
    email: string;
    message: string;
    reply: string;
  }
): Promise<void> {
  const safeTenantId = params.tenantId || 'unknown';
  try {
    await db.query(
      `INSERT INTO admin_feedback
         (tenant_id, user_email, message, ai_response, ai_answered, category)
       VALUES ($1, $2, $3, $4, false, 'knowledge_gap')`,
      [safeTenantId, params.email || null, params.message, params.reply]
    );
  } catch (err: any) {
    if (err?.code === '42P01') {
      logger.warn('[admin-agent] admin_feedback table not found — run migration_admin_feedback.sql');
    } else {
      logger.error('[admin-agent] feedback INSERT failed:', err?.code, err?.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Auth helper（options/routes.ts と同パターンのローカル定義）
// ---------------------------------------------------------------------------

function extractAuth(req: Request) {
  const su = (req as any).supabaseUser as Record<string, any> | undefined;
  const role = su?.app_metadata?.role;
  const tenantId: string = su?.app_metadata?.tenant_id ?? su?.tenant_id ?? '';
  const isSuperAdmin: boolean = role === 'super_admin';
  return { su, role, tenantId, isSuperAdmin };
}

// ---------------------------------------------------------------------------
// Zod スキーマ
// ---------------------------------------------------------------------------

// G2: 会話履歴はサーバに永続化せず、フロントが保持する直近の会話を毎リクエスト送る
// （ステートレスサーバのまま最小コストでマルチターン文脈を実現する）
const historyItemSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000),
});

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  sessionId: z.string().min(1).max(100),
  targetTenantId: z.string().optional(),
  history: z.array(historyItemSchema).max(20).optional(),
  // 明示的にオプトインした場合のみ true。省略時(既存クライアント)は従来通りJSON一括応答のまま。
  stream: z.boolean().optional(),
  // どちらのチャットUIから来たリクエストか。省略時は 'unknown' として計測する(必須にはしない
  // ため、この値を送らない既存クライアントは従来どおり動く)。値そのものは enum で閉じており、
  // 未知のリテラルは他のフィールドと同様 zod のバリデーションで 400 になる
  // （ラベルの語彙を有界に保つ責任をサーバ側に置く）。
  surface: z.enum(['panel', 'fullscreen']).optional(),
});

// UIイベント計測の受け口。event は**閉じた enum** にしておく。自由記述のイベント名を
// 受けると管理されない分析投入口になり、docs/AGENT_METRICS.md の命名契約が
// 意味を失うため、値を増やすときは必ずこのリテラルとドキュメントを同時に更新する。
// tenant_id は JWT 由来のみを使うので、body に tenantId 相当のキーは定義しない
// （zod は未知キーを黙って捨てるため、送られてきても参照されることはない）。
const uiEventSchema = z.object({
  event: z.literal('chat_first_toggle'),
  enabled: z.boolean(),
});

// ---------------------------------------------------------------------------
// Groq function calling 呼び出し（tools 付き）
// ---------------------------------------------------------------------------

interface GroqMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface GroqToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface GroqUsage {
  promptTokens: number;
  completionTokens: number;
}

async function callGroqWithTools(
  messages: GroqMessage[],
  tools: typeof ADMIN_AGENT_TOOLS
): Promise<{ content: string | null; tool_calls: GroqToolCall[]; usage: GroqUsage }> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GPT_OSS_120B,
      // gpt-oss は推論トークンが max_tokens を食う（groqModels.ts 参照）
      ...groqReasoningParams(GPT_OSS_120B),
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? null,
    tool_calls: choice?.message?.tool_calls ?? [],
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

async function callGroqFinal(messages: GroqMessage[]): Promise<{ reply: string; usage: GroqUsage }> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GPT_OSS_120B,
      // gpt-oss は推論トークンが max_tokens を食う（groqModels.ts 参照）
      ...groqReasoningParams(GPT_OSS_120B),
      messages,
      max_tokens: 512,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  return {
    reply: data.choices?.[0]?.message?.content?.trim() ?? '',
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 共有: tool_calls の実行（confirmed同一ターン連鎖ガード込み）。
// 非ストリーミング・ストリーミング両方の多段ループから使う単一の実装。
// ---------------------------------------------------------------------------

interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * ツール呼び出しの arguments(JSON文字列)を安全にパースする。
 * 実際のGroq API観測で、無引数ツールに対し文字列 "null" が送られてくるケースを確認済み。
 * JSON.parse自体は例外を投げず null を返すため、catch だけでは防げない
 * （object以外に解決した場合は空オブジェクトへフォールバックする）。
 */
function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return {};
  } catch {
    return {};
  }
}

// 同一ターン連鎖ブロックの対象かどうか。requiresConfirmation() は未分類ツール(読み取り専用含む)を
// 例外にするため、先に WRITE_TOOL_RISK_TIERS でのメンバーシップを確認してから呼ぶ
// （読み取り専用ツールに対して呼ぶと例外になる）。
function isConfirmationGatedWriteTool(name: string): boolean {
  return name in WRITE_TOOL_RISK_TIERS && requiresConfirmation(name);
}

async function executeHopToolCalls(
  toolCalls: ParsedToolCall[],
  effectiveTenantId: string,
  db: Pool,
  suggestedThisTurn: Set<string>,
  untrustedReadToolsThisTurn: Set<string>,
  actions: ChatAction[],
  messages: GroqMessage[],
  isSuperAdmin: boolean,
  sessionId: string,
  changedBy: string,
  surface: MetricSurface,
  // delete_chat_session が audit_logs に記録する実行者ロール。changedBy(email)と
  // 対にして executeToolCall へ渡す。
  actorRole: string,
): Promise<void> {
  for (const toolCall of toolCalls) {
    const { id, name, args } = toolCall;
    // この save/commit ツールを指す suggest キー(複数の可能性あり。例: commit_faq_importは
    // suggest_faq_import_from_text/urls の両方から指される)のいずれかが今ターン既に呼ばれていないか。
    const suggestCounterparts = Object.entries(SUGGEST_TO_SAVE_TOOL)
      .filter(([, save]) => save === name)
      .map(([suggest]) => suggest);
    const alreadySuggestedThisTurn = suggestCounterparts.some((s) => suggestedThisTurn.has(s));

    // 同一ターン連鎖のブロックは「確認ゲートの対象ツール」にのみ効かせる。
    // 対象かどうかの判定は confirmPolicy.ts に集約する（リスク階層の単一の情報源）。
    // isConfirmationGatedWriteTool は分類済みの書き込みツールすべてに対して true を返すため、
    // ここでの判定結果は従来と完全に同一（挙動不変）。未分類の読み取りツールは
    // WRITE_TOOL_RISK_TIERS のメンバーシップで先に弾かれるため requiresConfirmation は呼ばれない。
    //
    // ブロック条件は2つ（どちらも「人間の実際の同意を経ていない書き込み」を防ぐ）:
    //  1. blockedBySuggestChain … suggest_*→save_* の連鎖（SUGGEST_TO_SAVE_TOOL）
    //  2. blockedByUntrustedRead … 信頼できないテキストの読み取り直後の書き込み（下記参照）
    const blockedBySuggestChain = alreadySuggestedThisTurn && isConfirmationGatedWriteTool(name);
    const blockedByUntrustedRead = untrustedReadToolsThisTurn.size > 0 && isConfirmationGatedWriteTool(name);

    let result: string;
    let card: ActionCardPayload | undefined;
    if (blockedByUntrustedRead) {
      // 同一ターン内で「顧客・外部が書いた文字列」を読んだ直後に書き込みが連鎖しようとしている:
      // 人間の確認を経ていないためブロック。次ターンで一覧を取り直すと再びこのブロックに
      // 当たり続けるため（新しいリクエストのたびにフラグはリセットされる）、一覧の再取得ではなく
      // 直前に得たIDを使って依頼し直すよう明示的に誘導する。
      result = `この書き込みは、直前に顧客・外部由来のテキストを読み取った同一ターン内での実行のため${BLOCKED_CHAIN_MARKER}。一覧を取り直さず、直前に得た [ID] を使ってもう一度依頼してください。`;
    } else if (blockedBySuggestChain) {
      // 同一ターン内で suggest → save が連鎖しようとしている: 人間の確認を経ていないためブロック
      result = `この保存は同一ターン内での連続実行のため${BLOCKED_CHAIN_MARKER}。提案内容を確認のうえ、あらためて「保存して」等のメッセージを送ってください。`;
    } else {
      let raw: ActionResult;
      try {
        raw = await executeToolCall(name, args, effectiveTenantId, db, sessionId, isSuperAdmin, {
          role: actorRole,
          email: changedBy,
        });
      } catch (err) {
        fireAgentMetric(db, {
          metricName: 'agent_tool_invoked',
          tenantId: effectiveTenantId || null,
          labels: { tool: name, outcome: 'error', surface },
          value: 1,
        });
        throw err;
      }
      // 構造化結果を「自然文 + 任意のカード」へ正規化する。これ以降の処理
      // (LLMへの差し戻し・classifyToolResult による計測・answered_from)は
      // 従来どおり自然文だけを見るため、構造化しても挙動は変わらない。
      if (typeof raw === 'string') {
        result = raw;
      } else {
        result = raw.text;
        card = raw.card;
      }
      if (name in SUGGEST_TO_SAVE_TOOL) suggestedThisTurn.add(name);
      if (UNTRUSTED_TEXT_READ_TOOLS.has(name)) untrustedReadToolsThisTurn.add(name);
    }

    // card を持たないツールでは JSON に card キー自体を出さない(既存レスポンス形と同一)。
    actions.push(card ? { tool: name, result, card } : { tool: name, result });
    messages.push({ role: 'tool', tool_call_id: id, name, content: result });

    const metricTenantId = effectiveTenantId || null;
    const { outcome, reason } = classifyToolResult(result);
    fireAgentMetric(db, {
      metricName: 'agent_tool_invoked',
      tenantId: metricTenantId,
      labels: { tool: name, outcome, surface },
      value: 1,
    });
    if (reason) {
      fireAgentMetric(db, {
        metricName: 'agent_write_blocked',
        tenantId: metricTenantId,
        labels: { tool: name, reason, surface },
        value: 1,
      });
    }
    // 設定変更の監査記録。ブロックされた書き込み(outcome=blocked)は実際にDBを変えていないため
    // 記録しない（記録すると監査ログに偽のエントリが残る）。
    const auditedSetting = AUDITED_SETTINGS_TOOLS[name];
    if (
      auditedSetting &&
      outcome === 'ok' &&
      result.includes(auditedSetting.successMarker) &&
      effectiveTenantId
    ) {
      fireSettingsAudit(db, {
        tenantId: effectiveTenantId,
        changedBy,
        fieldName: auditedSetting.fieldName,
        newValue: auditedSetting.readNewValue(args),
      });
    }
    if (name === 'get_legacy_ui_link') {
      const feature = String(args['feature'] ?? '');
      fireAgentMetric(db, {
        metricName: 'agent_legacy_handoff',
        tenantId: metricTenantId,
        labels: { feature: LEGACY_HANDOFF_FEATURES.has(feature) ? feature : 'unknown', surface },
        value: 1,
      });
    }
    // Asana 1217040702485762(P5): オンボーディング段階到達メトリクス。
    // 発火回数(重複排除なし)・actorの定義・widget_installed/first_conversationが
    // 未実装であることは docs/AGENT_METRICS.md の onboarding_stage_reached 節を参照。
    if (outcome === 'ok' && metricTenantId) {
      const actor = isSuperAdmin ? 'delegated' : 'self';
      if (name === 'import_industry_faq_templates' && result.includes('下書きとして登録しました')) {
        fireAgentMetric(db, {
          metricName: 'onboarding_stage_reached',
          tenantId: metricTenantId,
          labels: { stage: 'industry_answered', actor, surface },
          value: 1,
        });
      }
      if (name === 'publish_faq_drafts' && result.includes('件のFAQを公開しました')) {
        fireAgentMetric(db, {
          metricName: 'onboarding_stage_reached',
          tenantId: metricTenantId,
          labels: { stage: 'knowledge_published', actor, surface },
          value: 1,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SSE: 本物のトークンストリーミング（stream:true オプトイン時のみ）。
// 各ホップをGroqの stream:true で受け、content デルタは受信次第そのまま
// クライアントへ転送し、tool_calls デルタはindexごとに蓄積して完成後に実行する。
// ---------------------------------------------------------------------------

interface StreamHopResult {
  content: string | null;
  tool_calls: GroqToolCall[];
  usage: GroqUsage;
}

async function runStreamingHop(
  messages: GroqMessage[],
  tools: typeof ADMIN_AGENT_TOOLS | undefined,
  res: Response,
): Promise<StreamHopResult> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error('GROQ_API_KEY not configured');

  const body: Record<string, unknown> = {
    model: GPT_OSS_120B,
    // gpt-oss は推論トークンが max_tokens を食う（groqModels.ts 参照）
    ...groqReasoningParams(GPT_OSS_120B),
    messages,
    max_tokens: 1024,
    temperature: 0.2,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!groqRes.ok || !groqRes.body) {
    const text = await groqRes.text().catch(() => '');
    throw new Error(`Groq API error ${groqRes.status}: ${text.slice(0, 200)}`);
  }

  const reader = groqRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentAcc = '';
  let hasContent = false;
  const toolCallAcc: Array<{ id?: string; name?: string; args: string }> = [];
  let usage: GroqUsage = { promptTokens: 0, completionTokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // 最後の不完全な行は次のchunkに持ち越す

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice('data:'.length).trim();
      if (payload === '[DONE]') continue;

      let parsed: any;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? usage.promptTokens,
          completionTokens: parsed.usage.completion_tokens ?? usage.completionTokens,
        };
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        hasContent = true;
        contentAcc += delta.content;
        res.write(`event: delta\ndata: ${JSON.stringify({ text: delta.content })}\n\n`);
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx: number = tc.index ?? 0;
          if (!toolCallAcc[idx]) toolCallAcc[idx] = { args: '' };
          if (tc.id) toolCallAcc[idx]!.id = tc.id;
          if (tc.function?.name) toolCallAcc[idx]!.name = tc.function.name;
          if (tc.function?.arguments) toolCallAcc[idx]!.args += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls: GroqToolCall[] = toolCallAcc
    .filter((tc): tc is { id: string; name: string; args: string } => Boolean(tc?.id && tc?.name))
    .map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: tc.args },
    }));

  // ストリームの usage イベントが得られなかった場合の概算(日本語はおおよそ4文字≒1トークン)
  if (usage.completionTokens === 0 && contentAcc) {
    usage = { ...usage, completionTokens: Math.ceil(contentAcc.length / 4) };
  }

  return { content: hasContent ? contentAcc : null, tool_calls: toolCalls, usage };
}

// ---------------------------------------------------------------------------
// G1: 多段エージェントループの設定
// ---------------------------------------------------------------------------

// 1リクエストあたり許容する「tools付きGroq呼び出し」の最大回数。
// 暴走・無限ループ防止のガード。上限に達しても収束しない場合は tools 無しの
// 強制まとめ呼び出し(callGroqFinal)で必ず自然文の reply を返して終了する。
const MAX_TOOL_HOPS = 4;

// 同一ターン内の危険な連鎖をブロックする対応表(トリガー側ツール → ブロック対象ツール)。
// G1導入により「複数ツールを同一ターン内で連鎖実行」が技術的に可能になったが、
// これは人間の確認を経ないまま書き込みが確定してしまう抜け道になるため、
// プロンプト任せにせずコードで明示的にブロックする（下記ループ内で使用）。
// suggest_* → save_* の対応（下書きの提示と、その採用の連鎖防止）専用。value(ブロック対象)は
// 複数のtriggerから指されうる点に注意（下のブロック判定は「このツールを指すtriggerキーの
// いずれかが今ターン呼ばれたか」で見る）。
const SUGGEST_TO_SAVE_TOOL: Record<string, string> = {
  suggest_tuning_rule: 'save_tuning_rule',
  suggest_faq: 'save_faq',
  suggest_engagement_rule: 'save_engagement_rule',
  suggest_faq_import_from_text: 'commit_faq_import',
  suggest_faq_import_from_urls: 'commit_faq_import',
  // 見本の提示と採用(永続レコード作成)が同一ターンで連鎖しないようにする。他の
  // suggest_*→save_* と同じ理由: confirmed=true はモデルが自己申告する値でしかなく、
  // 同一ターン内では人間の実際の同意を経ていない。
  suggest_avatar_preset: 'adopt_avatar_preset',
  // カテゴリ別ペルソナの下書き提示と保存が同一ターンで連鎖しないようにする。
  // 実装時に登録漏れがあり、suggest_category_persona → save_category_persona(confirmed=true)
  // が同一ターンで素通りしていた欠陥の修正(2026-08-01)。
  suggest_category_persona: 'save_category_persona',
};

// 方針決定(2026-08-18・hkobayashi・Asana 1217566291608806): 「信頼できないテキストの
// 読み取り元」を1つの集合として持ち、これらのいずれかが今ターン既に呼ばれていたら、
// 以降の確認ゲート対象ツール(isConfirmationGatedWriteTool)を無差別にブロックする。
//
// 経緯: 上のSUGGEST_TO_SAVE_TOOLは元々 get_chat_session_messages → delete_chat_session の
// 連鎖も1エントリとして登録していたが、Record<string, string>は1キーにつき1値しか持てず、
// record_session_outcome / set_faq_published 等、他の書き込みツールへは連鎖ブロックが
// 効かないという穴が実測で判明した(32ツール中7ツールにしか効いていなかった)。
// トリガー側ツールを列挙する方式は登録漏れが静かに積み上がるため、「顧客・外部が書いた
// 文字列をコンテキストへ入れたか」という状態1つで判定する方式に変更する。
//
// 実測で顧客・外部由来の文字列を返すことを確認済みなのは以下の6本
// (get_chat_session_messages は会話本文そのもの、get_escalations / get_chat_sessions は
// first_message_preview、get_knowledge_gaps は user_question で、同様に顧客の発言をそのまま返す。
// get_conversation_evaluation の text/card は ev.notes = 顧客との会話からJudge(Gemini)が
// 生成した所見であり、顧客が書いた指示文が要約を経て残りうる。suggest_faq_import_from_urls は
// 外部サイト本文からの生成物で、テナント自身が制御できない入力源)。
//
// 2026-08-18 是正(Asana 1217568022159772・PR #781の積み残し): この2本は#781時点で
// 未収録だったため、以下の書き込みツールへの連鎖ブロックが効いていなかった:
//   get_conversation_evaluation → 「評価を見てから指示ルールを作る」等の任意の確認ゲート対象ツール
//   suggest_faq_import_from_urls → commit_faq_import以外の任意の確認ゲート対象ツール
//     (commit_faq_importへの連鎖は元々SUGGEST_TO_SAVE_TOOLで別途ブロックされていたが、
//      それ以外の書き込みツールへの連鎖は無防備だった)
//
// get_conversation_evaluationを対象に含めると「評価を見てから指示ルールを作る」フローが
// 2ターンに分かれる副作用があるが、顧客発の指示文がJudge要約を経て書き込みへ連鎖する経路を
// 塞ぐことを優先し、他の読み取りツールと同じ安全側の既定に揃える。
const UNTRUSTED_TEXT_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_chat_session_messages',
  // 露出は first_message_preview に限られ get_chat_session_messages より注入面は小さいが、
  // 安全側の既定(受け入れ条件)に従い対象に含める。
  'get_escalations',
  'get_chat_sessions',
  'get_knowledge_gaps',
  'get_conversation_evaluation',
  'suggest_faq_import_from_urls',
]);

// 中期案(ActionResult に「外部・顧客由来テキストを含む」というメタ情報を持たせ、この集合の
// 手動管理をやめる)は本PRでは見送る。理由: actionExecutor.ts は本PRと同時並行の別タスク
// (Lane α)が編集中のファイル分離ルールにより本PRからは触れない。メタ情報化は45ケース全体
// (最低でも本集合が対象とする6ケース)へ配線する変更になり、actionExecutor.ts への手入れが
// 必須のため、この制約下では実施できない。列挙方式は残り、登録漏れの再発余地も残る。
// 実施する場合は別タスクとして起票し、actionExecutor.ts が空くタイミングで着手する。

// MAX_TOOL_HOPS到達後の強制まとめ呼び出し用。tools無しにしただけでは、モデルがまだ
// ツールを呼びたい場合に "<function=...>" のような擬似構文をテキストとして出力することが
// 実測で確認されたため、明示的に禁止する一文を最後に差し込む。
const WRAP_UP_NOTICE: GroqMessage = {
  role: 'user',
  content:
    'これ以上ツールは呼び出せません。ここまでの情報をもとに、自然な日本語の文章だけで回答してください（関数呼び出しの構文などは一切書かないでください）。',
};

// ---------------------------------------------------------------------------
// ルート登録
// ---------------------------------------------------------------------------

export function registerAdminAgentRoutes(app: Express, db: Pool): void {
  app.use('/v1/admin/agent', supabaseAuthMiddleware);

  app.post('/v1/admin/agent/chat', async (req: Request, res: Response) => {
    const { su, role, tenantId, isSuperAdmin } = extractAuth(req);
    // src/api/admin/chat-history/routes.ts と同じ規約(su.email が無い場合は
    // app_metadata.email にフォールバックする)。同一ユーザーが経路によって
    // 異なる email に解決されないようにする。
    const email: string = su?.email ?? su?.app_metadata?.email ?? '';

    // ロールチェック
    if (role !== 'super_admin' && role !== 'client_admin') {
      return res.status(403).json({ error: 'この操作を実行する権限がありません' });
    }

    // バリデーション
    const parsed = chatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
    }

    const { message, sessionId, targetTenantId, history } = parsed.data;
    // 送ってこないクライアントも受け入れる代わりに、計測側では 'unknown' として1つの語彙に丸める。
    const surface: MetricSurface = parsed.data.surface ?? 'unknown';

    // effectiveTenantId: super_admin は targetTenantId を使用可、client_admin は JWT 由来のみ
    const effectiveTenantId = isSuperAdmin ? (targetTenantId ?? tenantId) : tenantId;

    if (!isSuperAdmin && !effectiveTenantId) {
      return res.status(403).json({ error: 'テナント情報が取得できません' });
    }

    // GROQ_API_KEY 未設定の場合はグレースフルダウングレード
    if (!process.env.GROQ_API_KEY?.trim()) {
      return res.status(200).json({
        reply: 'AIアシスタントは現在利用できません',
        actions: [],
      });
    }

    try {
      const systemPrompt =
        `あなたはテナント管理AIエージェントです。テナントID "${effectiveTenantId}" の管理者をサポートします。` +
        `必要に応じてツールを呼び出して設定を確認・変更してください。回答は日本語で簡潔に行ってください。` +
        `画面はMarkdownとして解釈して描画するため、強調・見出し・箇条書き・表はMarkdown記法（**太字**、` +
        `#見出し、- 箇条書き、|付きの表など）で書いてください。<br>のような生のHTMLタグは描画されず` +
        `文字として消えるため使わないでください。` +
        `ツールの実行結果を見てから続けて別のツールを呼び出すこともできます（最大${MAX_TOOL_HOPS}回まで）。` +
        `confirmed フラグを持つツール（save_tuning_rule, delete_faq 等）は、必ず先に内容をユーザーに要約提示し、` +
        `明確な同意を得たターンでのみ confirmed=true を指定して呼び出してください。` +
        `suggest_* で下書きを提案した直後に、同じターン内で対応する save_* を呼び出すことはできません` +
        `（ユーザーが確認して次のメッセージを送るまで待つ必要があります）。` +
        `商品説明文などの長いテキストやURLからFAQをまとめて登録したい場合は、1件ずつ add_faq/save_faq を` +
        `使うのではなく suggest_faq_import_from_text（テキストから）または suggest_faq_import_from_urls` +
        `（URL 1〜5件から）でプレビューを作成し、内容を要約提示のうえ同意を得たら commit_faq_import で` +
        `登録してください（同じく同一ターン内での連鎖実行は避け、ユーザーの次のメッセージを待つこと）。` +
        `PDFからの知識登録はR2C運営チームのみが行うため、頼まれても旧管理画面へは案内せず、` +
        `内容を文章で教えてもらえれば代わりに登録できる旨を伝えてください。` +
        `ナレッジ(FAQ・書籍)ごとの成約への貢献度を尋ねられた場合は get_legacy_ui_link(feature=knowledge_attribution) で` +
        `旧管理画面へ案内してください。` +
        `請求（支払い操作）、アバタースタジオ（画像/音声/性格/ライブテスト）、エスカレーションへの有人返信、` +
        `会話セッションの削除、テストチャット、アバター新規作成について尋ねられた場合は、` +
        `チャットで実行しようとせず get_legacy_ui_link を呼び出して旧管理画面へ案内してください。` +
        `会話分析・成約・効果分析については get_analytics_summary / get_conversion_summary で数値サマリーを` +
        `そのままチャットで答えてください。グラフの詳細・個別の低評価セッション・ABテスト結果を見たいと言われた` +
        `場合のみ get_legacy_ui_link(feature=analytics / conversion) で旧管理画面へ案内してください。` +
        `ユーザーが管理画面の操作を代わりにやってほしいと頼んできた場合（例:「送料表記を直して」）は、` +
        `request_sai_task が使えます。他のLLM機能と同じ従量課金が発生するため、必ず先に依頼内容を要約提示し、` +
        `同意を得たターンでのみ confirmed=true で呼び出してください。進捗は get_sai_task_status で確認できます。` +
        `新規テナントのオンボーディング中でユーザーが業種を答えてくれた場合は import_industry_faq_templates を` +
        `使ってFAQのたたき台を提案・登録してください（confirmedゲート必須）。登録が完了したら、続けて` +
        `get_avatar_status でアバターの状況を確認し、無効であれば有効化(activate_avatar)を提案し、最後に` +
        `get_embed_code でウィジェットの埋め込みコードを案内する、という3ステップを自然な会話で順に進めてください。` +
        `セッションID: ${sessionId}`;

      // G2: 直近の会話履歴をそのままシステムプロンプトの後に差し込み、マルチターンの文脈を持たせる
      const historyMessages: GroqMessage[] = (history ?? []).map((h) => ({
        role: h.role,
        content: h.content,
      }));

      const messages: GroqMessage[] = [
        { role: 'system', content: systemPrompt },
        ...historyMessages,
        { role: 'user', content: message },
      ];

      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      const actions: ChatAction[] = [];
      // このリクエスト(ターン)内で suggest_* が呼ばれたツール名を記録し、
      // 対応する save_* が同一ターン内で連鎖実行されるのを防ぐ（G1のリスク軽減策）
      const suggestedThisTurn = new Set<string>();
      // このリクエスト(ターン)内で UNTRUSTED_TEXT_READ_TOOLS のいずれかが呼ばれたかを記録し、
      // 以降の確認ゲート対象ツールを一律ブロックする（新しいリクエストのたびにリセットされる）。
      const untrustedReadToolsThisTurn = new Set<string>();

      // -----------------------------------------------------------------
      // SSE: stream:true をオプトインした場合のみ本物のトークンストリーミング経路へ。
      // 省略時(既存クライアント・本番AdminAgentPanel)は下の非ストリーミング経路のまま、挙動は完全に不変。
      // -----------------------------------------------------------------
      if (parsed.data.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        try {
          let finalReply: string | null = null;
          // ループを抜けた時点で「ツール呼び出しを含むホップを何回消費したか」になる（agent_turn_hops の value）
          let toolHops = 0;

          for (; toolHops < MAX_TOOL_HOPS; toolHops++) {
            const hopResult = await runStreamingHop(messages, ADMIN_AGENT_TOOLS, res);
            totalPromptTokens += hopResult.usage.promptTokens;
            totalCompletionTokens += hopResult.usage.completionTokens;

            if (hopResult.tool_calls.length === 0) {
              finalReply = hopResult.content ?? '回答を生成できませんでした';
              break;
            }

            messages.push({ role: 'assistant', content: hopResult.content, tool_calls: hopResult.tool_calls });

            const parsedToolCalls: ParsedToolCall[] = hopResult.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              args: parseToolArgs(tc.function.arguments),
            }));

            const beforeCount = actions.length;
            await executeHopToolCalls(parsedToolCalls, effectiveTenantId, db, suggestedThisTurn, untrustedReadToolsThisTurn, actions, messages, isSuperAdmin, sessionId, email, surface, role);
            for (const action of actions.slice(beforeCount)) {
              res.write(`event: action\ndata: ${JSON.stringify(action)}\n\n`);
            }
          }

          const hitHopLimit = finalReply === null;

          if (finalReply === null) {
            // MAX_TOOL_HOPS に達しても収束しなかった場合、tools無しで強制的にまとめさせる(これもストリーミング)。
            // 実測: toolsを外しただけだと、まだ呼びたいツールがある場合にモデルが
            // "<function=...>" のような擬似構文をテキストとして出力することがあるため、明示的に釘を刺す。
            messages.push(WRAP_UP_NOTICE);
            const wrapUp = await runStreamingHop(messages, undefined, res);
            totalPromptTokens += wrapUp.usage.promptTokens;
            totalCompletionTokens += wrapUp.usage.completionTokens;
            finalReply = wrapUp.content ?? '回答を生成できませんでした';
          }

          if (effectiveTenantId) {
            trackUsage({
              tenantId: effectiveTenantId,
              requestId: `admin-agent-${sessionId}-${Date.now()}`,
              model: GPT_OSS_120B,
              inputTokens: totalPromptTokens,
              outputTokens: totalCompletionTokens,
              featureUsed: 'admin_agent',
            });
          }

          const answeredFrom = determineAnsweredFrom(actions);
          if (effectiveTenantId && actions.length === 0 && isUnanswered(finalReply)) {
            await recordUnansweredFeedback(db, { tenantId: effectiveTenantId, email, message, reply: finalReply });
          }

          recordTurnCompleted(db, {
            tenantId: effectiveTenantId || null,
            toolHops,
            hitHopLimit,
            answeredFrom,
            surface,
          });

          res.write(`event: done\ndata: ${JSON.stringify({ reply: finalReply, actions, answered_from: answeredFrom })}\n\n`);
          res.end();
        } catch (err) {
          logger.warn('[POST /v1/admin/agent/chat stream]', err);
          res.write(`event: error\ndata: ${JSON.stringify({ error: 'AIエージェントの応答生成に失敗しました' })}\n\n`);
          res.end();
        }
        return;
      }

      // -----------------------------------------------------------------
      // 非ストリーミング経路(既定・既存挙動): JSON一括応答
      // -----------------------------------------------------------------
      const reportUsage = () => {
        // super_adminがテナント未特定（targetTenantId未指定）の場合は課金対象がないためスキップ
        if (!effectiveTenantId) return;
        trackUsage({
          tenantId: effectiveTenantId,
          requestId: `admin-agent-${sessionId}-${Date.now()}`,
          model: GPT_OSS_120B,
          inputTokens: totalPromptTokens,
          outputTokens: totalCompletionTokens,
          featureUsed: 'admin_agent',
        });
      };

      let finalReply: string | null = null;
      // ループを抜けた時点で「ツール呼び出しを含むホップを何回消費したか」になる（agent_turn_hops の value）
      let toolHops = 0;

      // G1: tools付きGroq呼び出しを最大 MAX_TOOL_HOPS 回まで繰り返す。
      // モデルがツール結果を見て追加のツールを呼ぶ「多段推論」を許容しつつ、
      // 上限に達しても収束しない場合は必ず自然文の reply で終了させる。
      for (; toolHops < MAX_TOOL_HOPS; toolHops++) {
        const hopResponse = await callGroqWithTools(messages, ADMIN_AGENT_TOOLS);
        totalPromptTokens += hopResponse.usage.promptTokens;
        totalCompletionTokens += hopResponse.usage.completionTokens;

        if (hopResponse.tool_calls.length === 0) {
          finalReply = hopResponse.content ?? '回答を生成できませんでした';
          break;
        }

        messages.push({
          role: 'assistant',
          content: hopResponse.content,
          tool_calls: hopResponse.tool_calls,
        });

        const parsedToolCalls: ParsedToolCall[] = hopResponse.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          args: parseToolArgs(toolCall.function.arguments),
        }));

        await executeHopToolCalls(parsedToolCalls, effectiveTenantId, db, suggestedThisTurn, untrustedReadToolsThisTurn, actions, messages, isSuperAdmin, sessionId, email, surface, role);
      }

      const hitHopLimit = finalReply === null;

      if (finalReply === null) {
        // MAX_TOOL_HOPS に達しても収束しなかった場合、tools無しで強制的にまとめさせる。
        // 実測: toolsを外しただけだと、まだ呼びたいツールがある場合にモデルが
        // "<function=...>" のような擬似構文をテキストとして出力することがあるため、明示的に釘を刺す。
        messages.push(WRAP_UP_NOTICE);
        const wrapUp = await callGroqFinal(messages);
        totalPromptTokens += wrapUp.usage.promptTokens;
        totalCompletionTokens += wrapUp.usage.completionTokens;
        finalReply = wrapUp.reply;
      }

      reportUsage();

      const answeredFrom = determineAnsweredFrom(actions);
      if (effectiveTenantId && actions.length === 0 && isUnanswered(finalReply)) {
        await recordUnansweredFeedback(db, { tenantId: effectiveTenantId, email, message, reply: finalReply });
      }

      recordTurnCompleted(db, {
        tenantId: effectiveTenantId || null,
        toolHops,
        hitHopLimit,
        answeredFrom,
        surface,
      });

      return res.json({ reply: finalReply, actions, answered_from: answeredFrom });
    } catch (err) {
      logger.warn('[POST /v1/admin/agent/chat]', err);
      return res.status(500).json({ error: 'AIエージェントの応答生成に失敗しました' });
    }
  });

  // チャットUIの操作イベントを計測するためだけのベストエフォートな副回線。
  // 「既定の画面にする」トグル(admin-ui/src/lib/chatFirstDefault.ts)は完全に
  // localStorage 側で完結しており、この endpoint はその ON/OFF を数えるだけで
  // 挙動には一切関与しない。したがって想定外の例外でも 500 を返さず ok を返す
  // （フロントに「本物のエラー」と見えてしまうと、計測の失敗がトグルの不具合に
  //   見える／トグル自体を壊す余地が生まれる）。
  app.post('/v1/admin/agent/ui-event', (req: Request, res: Response) => {
    try {
      const { role, tenantId } = extractAuth(req);

      if (role !== 'super_admin' && role !== 'client_admin') {
        return res.status(403).json({ error: 'この操作を実行する権限がありません' });
      }

      const parsed = uiEventSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'invalid_request', details: parsed.error.issues });
      }

      // テナントは JWT 由来のみ。body の値は（送られてきても）一切使わない。
      // テナント未特定の super_admin は docs/AGENT_METRICS.md どおり NULL で記録する。
      fireAgentMetric(db, {
        metricName: 'chat_first_toggle',
        tenantId: tenantId || null,
        labels: { enabled: parsed.data.enabled },
        value: 1,
      });

      return res.json({ ok: true });
    } catch (err) {
      logger.warn('[POST /v1/admin/agent/ui-event]', err);
      return res.json({ ok: true });
    }
  });
}
