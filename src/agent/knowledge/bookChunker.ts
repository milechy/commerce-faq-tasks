// src/agent/knowledge/bookChunker.ts
// Phase47 Stream A: PDF抽出テキストをオーバーラップ付きチャンクに分割

export interface BookChunk {
  text: string;
  chunkIndex: number;
  pageHint?: number;
}

const DEFAULT_MAX_CHARS = 750;
const OVERLAP_CHARS = 50;

/**
 * PDF抽出済みテキストを ~maxChars 文字のチャンクに分割する。
 *
 * 分割優先順:
 * 1. 段落区切り (\n\n)
 * 2. 句点 (。)
 * 3. 文字数強制分割
 *
 * チャンク間に50文字のオーバーラップを付与して文脈の連続性を維持する。
 */
export function splitIntoChunks(
  fullText: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): BookChunk[] {
  if (!fullText || fullText.trim().length === 0) return [];

  const normalised = fullText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // まず段落（\n\n）で粗く分割
  const paragraphs = normalised
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // 各段落を maxChars 以下のセグメントに細分化
  const segments: string[] = [];
  for (const para of paragraphs) {
    if (para.length <= maxChars) {
      segments.push(para);
      continue;
    }
    // 句点で分割
    const sentences = para.split(/(?<=。)/).filter((s) => s.length > 0);
    let current = '';
    for (const sent of sentences) {
      if (current.length + sent.length <= maxChars) {
        current += sent;
      } else {
        if (current.length > 0) segments.push(current);
        // 1文自体が maxChars を超える場合は文字数で強制分割
        if (sent.length > maxChars) {
          for (let i = 0; i < sent.length; i += maxChars) {
            segments.push(sent.slice(i, i + maxChars));
          }
          current = '';
        } else {
          current = sent;
        }
      }
    }
    if (current.length > 0) segments.push(current);
  }

  if (segments.length === 0) return [];

  // オーバーラップ付きチャンクを組み立て
  const chunks: BookChunk[] = [];
  for (let i = 0; i < segments.length; i++) {
    const overlap =
      i > 0 ? segments[i - 1]!.slice(-OVERLAP_CHARS) : '';
    const text = (overlap + segments[i]!).trim();
    chunks.push({ text, chunkIndex: i });
  }

  return chunks;
}
