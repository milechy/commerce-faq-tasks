import { getPool } from "../db";

export async function buildSentimentHint(sessionId: string): Promise<string> {
  try {
    const pool = getPool();
    const result = await pool.query<{ label: string; score: string }>(
      `SELECT sentiment->>'label' as label, sentiment->>'score' as score
       FROM chat_messages
       WHERE session_id = (
         SELECT id FROM chat_sessions WHERE session_id = $1 LIMIT 1
       )
       AND role = 'user' AND sentiment IS NOT NULL
       ORDER BY created_at DESC LIMIT 3`,
      [sessionId]
    );

    if (result.rows.length === 0) return "";

    const labels = result.rows.map((r: { label: string; score: string }) => r.label);
    const negativeCount = labels.filter((l: string) => l === "negative").length;
    const positiveCount = labels.filter((l: string) => l === "positive").length;

    if (negativeCount >= 2) {
      return "\n【顧客感情: ネガティブ傾向】共感を優先し、押し売りを避けてください。不安や懸念に丁寧に対応してください。";
    } else if (positiveCount >= 2) {
      return "\n【顧客感情: ポジティブ傾向】顧客は前向きです。具体的な提案やクロージングに進めてください。";
    } else if (labels[0] === "negative") {
      return "\n【顧客感情: 直近ネガティブ】前回のメッセージに不満・懸念がありました。まず共感してから対応してください。";
    }
    return "";
  } catch {
    return ""; // エラー時は何も注入しない
  }
}
