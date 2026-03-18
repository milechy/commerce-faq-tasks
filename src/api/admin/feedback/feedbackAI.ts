// src/api/admin/feedback/feedbackAI.ts
// フィードバックチャット LLM 自動返答

import { sanitizeOutput } from "../../../lib/security/inputSanitizer";
import { trackUsage } from "../../../lib/billing/usageTracker";

const FEEDBACK_AI_MODEL = process.env.FEEDBACK_AI_MODEL ?? "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `あなたはRAJIUCE管理画面のサポートアシスタントです。
テナント管理者からの質問や要望に、丁寧かつ簡潔に（3文以内で）返答してください。

対応範囲（積極的に回答する）:
- ナレッジ登録・編集・削除・公開/非公開の切り替え
- テキスト・URL・PDFからのナレッジ取り込み
- チャットWidgetの埋め込み・動作確認
- チューニングルールの作成・編集・優先度設定
- 会話履歴の確認・フィルタリング
- 請求・使用量の確認
- 改善要望の受け付け（「ご要望ありがとうございます。開発チームに共有いたします。」）
- 管理画面の一般的な使い方に関するあらゆる質問

不明な点や管理画面と無関係な質問には、「確認して担当者よりご連絡いたします。」と返してください。

絶対にやらないこと:
- URLを生成・紹介しない
- 長文（3文超）で回答しない
- 対応範囲を箇条書きで羅列しない`;

export async function generateFeedbackReply(
  userMessage: string,
  tenantId: string
): Promise<string | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: FEEDBACK_AI_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        max_tokens: 200,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      console.warn("[feedbackAI] Groq API error:", response.status);
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const reply = data.choices?.[0]?.message?.content?.trim() ?? null;
    if (!reply) return null;

    // 出力サニタイズ（URLが含まれていたら除去）
    const safe = sanitizeOutput(reply);

    // 課金トラッキング（fire-and-forget）
    trackUsage({
      tenantId,
      requestId: "feedback-ai",
      model: FEEDBACK_AI_MODEL,
      inputTokens: Math.ceil(userMessage.length / 4),
      outputTokens: Math.ceil(safe.length / 4),
      featureUsed: "chat",
    });

    return safe;
  } catch (err) {
    console.error("[feedbackAI] generation failed:", err);
    return null;
  }
}
