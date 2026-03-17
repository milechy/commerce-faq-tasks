// src/api/admin/feedback/feedbackAI.ts
// フィードバックチャット LLM 自動返答

import { sanitizeOutput } from "../../../lib/security/inputSanitizer";
import { trackUsage } from "../../../lib/billing/usageTracker";

const FEEDBACK_AI_MODEL = process.env.FEEDBACK_AI_MODEL ?? "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `あなたはRAJIUCE（AIチャットBot管理画面）のサポートアシスタントです。
テナント（加盟店）の管理者からのフィードバックや質問に、丁寧かつ簡潔に返答してください。

対応できること:
- 管理画面の使い方（ナレッジ登録、テキスト/URL/PDF入力、カテゴリ、公開/非公開）
- チャットWidget（埋め込み方法、動作確認）
- チューニングルール（作成、編集、優先度）
- 会話履歴の確認方法
- 請求・使用量の確認方法
- 未回答の質問（ナレッジギャップ）の対応方法
- 改善要望の受け付け

絶対にやらないこと:
- URLを生成・紹介しない
- 外部サービスやツールを推薦しない
- 個人情報を聞かない
- テナントのビジネス内容に関するアドバイスをしない
- 関係ない雑談に応じない（丁寧に断る）

関係ない質問の場合:
「申し訳ございません。こちらはRAJIUCE管理画面のサポート専用です。管理画面の使い方やご要望についてお気軽にどうぞ。」

改善要望の場合:
「ご要望ありがとうございます。開発チームに共有いたします。」のように簡潔に受領を伝える。

回答は200文字以内を目安に簡潔に。`;

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
