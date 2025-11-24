// src/agent/llm/openaiEmbeddingClient.ts
// OpenAI Embeddings を REST API 経由で呼ぶラッパー（SDK 不使用）

export async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const model = process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const snippet = body.length > 300 ? `${body.slice(0, 300)}...` : body;
    throw new Error(`OpenAI embeddings failed: ${res.status} ${snippet}`);
  }

  const json: any = await res.json();
  const embedding = json?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("OpenAI embedding not found in response");
  }

  // 念のため number 配列に正規化
  return embedding.map((v: any) =>
    typeof v === "number" ? v : Number(v) || 0
  );
}
