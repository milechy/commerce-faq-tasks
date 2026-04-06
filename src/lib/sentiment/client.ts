import { logger } from '../logger';

interface SentimentResult {
  label: "positive" | "negative" | "neutral";
  score: number;
  raw_label: string;
}

export async function analyzeSentiment(text: string): Promise<SentimentResult | null> {
  try {
    const url = process.env.SENTIMENT_SERVICE_URL || "http://localhost:8200";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${url}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    return (await res.json()) as SentimentResult;
  } catch (err) {
    logger.error("[sentiment] analysis failed:", (err as Error).message);
    return null;
  }
}
