// src/lib/research/queryBuilder.ts
// Phase60-C: Perplexityリサーチクエリ生成ヘルパー

export function buildResearchQuery(context: {
  userMessage: string;
  tenantIndustry?: string;
}): string {
  const parts: string[] = [];
  if (context.tenantIndustry) {
    parts.push(context.tenantIndustry);
  }
  // ユーザーメッセージからキーワード（最初の100文字）
  parts.push(context.userMessage.slice(0, 100));
  parts.push('消費者心理 最新トレンド 効果的なアプローチ');
  return parts.join(' ');
}
