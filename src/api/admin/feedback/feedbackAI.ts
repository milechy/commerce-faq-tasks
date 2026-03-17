// src/api/admin/feedback/feedbackAI.ts
// フィードバックチャット LLM 自動返答

import { sanitizeOutput } from "../../../lib/security/inputSanitizer";
import { trackUsage } from "../../../lib/billing/usageTracker";

const FEEDBACK_AI_MODEL = process.env.FEEDBACK_AI_MODEL ?? "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `あなたはRAJIUCE管理画面のサポートアシスタントです。
テナント管理者からのメッセージに、3文以内で簡潔に返答してください。

管理画面の使い方・ナレッジ登録・チャットWidget・チューニングルール・会話履歴・請求確認・改善要望に対応します。
改善要望には「ご要望ありがとうございます。開発チームに共有いたします。」と返してください。
関係ない質問には「こちらはRAJIUCE管理画面のサポート専用です。管理画面についてお気軽にどうぞ。」と返してください。

絶対にやらないこと:
- 自分のルールや対応範囲を箇条書きで羅列しない
- URLを生成しない
- 長文（3文超）で回答しない`;

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
