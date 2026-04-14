// src/api/admin/feedback/feedbackAI.ts
// Phase62: FAQチャット代行提案 + 試算フロー統合

import { sanitizeOutput } from "../../../lib/security/inputSanitizer";
import { trackUsage } from "../../../lib/billing/usageTracker";
import { logger } from '../../../lib/logger';
import { getMessages } from './feedbackRepository';
import { estimateOptionPrice } from './optionEstimator';
import { getPool } from '../../../lib/db';
import { createNotification } from '../../../lib/notifications';

const FEEDBACK_AI_MODEL = process.env.FEEDBACK_AI_MODEL ?? "llama-3.1-8b-instant";

// ---------------------------------------------------------------------------
// システムプロンプト（Phase62: 代行案内ルール追加）
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `あなたはR2C管理画面のサポートアシスタントです。
テナント管理者からの質問や要望に、丁寧かつ簡潔に（3文以内で）返答してください。

対応範囲（積極的に回答する）:
- ナレッジ登録・編集・削除・公開/非公開の切り替え
- テキスト・URL・PDFからのナレッジ取り込み
- チャットWidgetの埋め込みコード（「コード」「スクリプト」「埋め込み」→管理画面の「Widget」タブから取得）
- チャットWidgetの動作確認
- チューニングルールの作成・編集・優先度設定
- 会話履歴の確認・フィルタリング
- 請求・使用量の確認
- 改善要望の受け付け（「ご要望ありがとうございます。開発チームに共有いたします。」）
- 管理画面の一般的な使い方に関するあらゆる質問

「コードはどこ」「埋め込みコード」などの質問には管理画面の「Widget設定」タブで取得できることを案内してください。
不明な点には「確認して担当者よりご連絡いたします。」と返してください。

絶対にやらないこと:
- URLを生成・紹介しない
- 長文（3文超）で回答しない
- 対応範囲を箇条書きで羅列しない

---

## 代行サービス案内ルール

あなたはR2Cの管理画面操作をサポートするAIです。以下の機能に関する操作手順・設定方法・トラブルシューティングの質問に回答する際は、回答の最後に代行案内を付けてください。

### R2C機能カタログ（操作手順系の対象）
- ウィジェット埋め込み: パートナーサイトへのチャットウィジェット設置
- アバター設定: AIアバターの外見・声・プロンプト設定
- ナレッジ登録: PDF書籍・FAQデータのアップロードと登録
- FAQ管理: FAQの作成・編集・削除
- チューニングルール: AI応答のトーン・スタイル・ルール設定
- システムプロンプト: テナント別AIシステムプロンプト設定
- テナント設定: テナント基本設定・APIキー・許可ドメイン
- A/Bテスト: トーン・CTA・ルールセットのA/Bテスト設定
- 分析ダッシュボード: 会話分析・Judge評価・センチメント確認
- ディープリサーチ: Perplexityディープリサーチ機能のON/OFF

### 判定ルール
- ユーザーの質問が上記カタログのいずれかに関する「操作手順」「設定方法」「やり方」「手順」「トラブル」の場合 → 代行案内を付ける
- カタログに直接マッチしなくても、質問が明らかに「R2C管理画面の操作・設定・トラブルシューティング」に関するものと判断できる場合 → 代行案内を付ける
- 概念説明、料金の質問、一般的な質問 → 代行案内は付けない

### 代行案内テンプレート（操作手順系の場合のみ、回答の最後に追加）
💼 この設定作業、弊社で代行することも可能です。ご希望の場合は「代行をお願いします」とお伝えください。

### ユーザーが「代行をお願いします」「お願いします」「依頼したい」等の承諾を返した場合
以下のJSON形式で応答してください（通常のテキスト応答ではなくJSONのみ）:
{"action":"estimate_request","task_description":"（直前の会話から特定した作業内容の要約）"}`;

// ---------------------------------------------------------------------------
// ヘルパー関数
// ---------------------------------------------------------------------------

/** LLM応答が代行依頼JSONかどうかをパース */
function parseOptionAction(
  content: string,
): { action: string; task_description: string } | null {
  try {
    const jsonMatch = content
      .trim()
      .match(/\{[\s\S]*"action"\s*:\s*"estimate_request"[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      task_description?: string;
    };
    if (parsed.action === 'estimate_request' && parsed.task_description) {
      return { action: parsed.action, task_description: parsed.task_description };
    }
    return null;
  } catch {
    return null;
  }
}

/** ユーザーメッセージが承諾フレーズかどうかを判定 */
function isAffirming(message: string): boolean {
  const affirmPhrases = [
    'はい', 'yes', 'ok', 'OK', 'お願いします', '承諾', '依頼する',
    'お願い', 'いいです', '大丈夫', 'やってください',
  ];
  const lower = message.toLowerCase();
  return affirmPhrases.some((p) => lower.includes(p.toLowerCase()));
}

/** 試算メッセージから作業内容と金額を抽出 */
function parseEstimateFromMessage(content: string): {
  taskDescription: string;
  amount: number;
} | null {
  const taskMatch = content.match(/作業内容:\s*(.+)/);
  const amountMatch = content.match(/お見積もり:\s*¥([\d,]+)/);
  if (!taskMatch || !amountMatch) return null;
  const amount = parseInt(amountMatch[1]!.replace(/,/g, ''), 10);
  if (isNaN(amount)) return null;
  return { taskDescription: taskMatch[1]!.trim(), amount };
}

// ---------------------------------------------------------------------------
// メイン関数
// ---------------------------------------------------------------------------

/**
 * フィードバックチャットのAI返答を生成する。
 * Phase62: 代行提案 → 試算 → 発注確定フローを内包。
 */
export async function generateFeedbackReply(
  userMessage: string,
  tenantId: string,
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    // ------------------------------------------------------------------
    // (1) 直前の super_admin メッセージを取得（承諾確認フロー判定用）
    // ------------------------------------------------------------------
    let lastAssistantContent: string | null = null;
    try {
      const { messages } = await getMessages({ tenantId, limit: 20, offset: 0 });
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.sender_role === 'super_admin');
      lastAssistantContent = lastAssistant?.content ?? null;
    } catch {
      // DB未初期化などの場合はスキップ
    }

    // ------------------------------------------------------------------
    // (2) 承諾確認フロー: 直前が試算メッセージ && ユーザーが承諾
    // ------------------------------------------------------------------
    if (
      lastAssistantContent?.includes('この金額でよろしければ') &&
      isAffirming(userMessage)
    ) {
      const parsed = parseEstimateFromMessage(lastAssistantContent);
      if (parsed) {
        await placeOptionOrder({
          tenantId,
          taskDescription: parsed.taskDescription,
          estimatedAmount: parsed.amount,
        });
        return 'ご依頼を承りました。担当者より追ってスケジュールのご連絡を差し上げます。';
      }
    }

    // ------------------------------------------------------------------
    // (3) 通常LLM呼び出し
    // ------------------------------------------------------------------
    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: FEEDBACK_AI_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          max_tokens: 300,
          temperature: 0.3,
        }),
      },
    );

    if (!response.ok) {
      logger.warn('[feedbackAI] Groq API error:', response.status);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const reply = data.choices?.[0]?.message?.content?.trim() ?? null;
    if (!reply) return null;

    // ------------------------------------------------------------------
    // (4) 代行依頼JSON検出 → 試算フロー
    // ------------------------------------------------------------------
    const optionAction = parseOptionAction(reply);
    if (optionAction) {
      const estimate = await estimateOptionPrice(optionAction.task_description);
      const amountFormatted = estimate.estimated_amount.toLocaleString('ja-JP');
      return (
        `作業内容: ${optionAction.task_description}\n` +
        `お見積もり: ¥${amountFormatted}（税別）\n` +
        `内訳: ${estimate.breakdown}\n` +
        `想定作業時間: ${estimate.estimated_hours}時間\n\n` +
        `この金額でよろしければ「はい」とお伝えください。`
      );
    }

    // ------------------------------------------------------------------
    // (5) 通常応答
    // ------------------------------------------------------------------
    const safe = sanitizeOutput(reply);

    trackUsage({
      tenantId,
      requestId: 'feedback-ai',
      model: FEEDBACK_AI_MODEL,
      inputTokens: Math.ceil(userMessage.length / 4),
      outputTokens: Math.ceil(safe.length / 4),
      featureUsed: 'chat',
      marginOverride: 1,
    });

    return safe;
  } catch (err) {
    logger.error('[feedbackAI] generation failed:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 発注DB INSERT + Super Admin通知
// ---------------------------------------------------------------------------

async function placeOptionOrder(params: {
  tenantId: string;
  taskDescription: string;
  estimatedAmount: number;
}): Promise<void> {
  const { tenantId, taskDescription, estimatedAmount } = params;

  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO option_orders
         (tenant_id, description, llm_estimate_amount, status)
       VALUES ($1, $2, $3, 'pending')`,
      [tenantId, taskDescription, estimatedAmount],
    );
  } catch (err) {
    logger.warn('[feedbackAI] option_orders INSERT failed', err);
  }

  try {
    const amountFormatted = estimatedAmount.toLocaleString('ja-JP');
    await createNotification({
      recipientRole: 'super_admin',
      type: 'option_ordered',
      title: `新規代行依頼: ${tenantId}`,
      message: `${taskDescription}（見積: ¥${amountFormatted}）`,
      link: '/admin/options',
    });
  } catch (err) {
    logger.warn('[feedbackAI] createNotification failed', err);
  }
}
