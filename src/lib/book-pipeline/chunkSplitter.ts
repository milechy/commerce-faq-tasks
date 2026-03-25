// src/lib/book-pipeline/chunkSplitter.ts
// Phase44: テキストチャンク分割モジュール
// 目標: 500–1000 文字、100 文字オーバーラップ、段落区切り優先

import type { PageText } from "./pdfExtractor";

export interface TextChunk {
  chunkIndex: number;
  pageNumber: number;
  text: string;
}

const TARGET_MIN = 500;
const TARGET_MAX = 1000;
const OVERLAP = 100;

/**
 * ページテキスト配列を 500–1000 文字のチャンクに分割する。
 * - 段落区切り（\n\n）優先でスプリット
 * - 100 文字オーバーラップ（前チャンクの末尾を次チャンクの先頭に付加）
 */
export function splitIntoChunks(pages: PageText[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  let chunkIndex = 0;
  let buffer = "";
  let bufferPage = 1;

  const flushBuffer = () => {
    const text = buffer.trim();
    if (text.length > 0) {
      chunks.push({ chunkIndex, pageNumber: bufferPage, text });
      chunkIndex++;
      buffer = text.slice(-OVERLAP);
    }
  };

  for (const page of pages) {
    bufferPage = page.pageNumber;

    const paragraphs = page.text
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
      .filter((p) => p.length > 0);

    for (const para of paragraphs) {
      const candidate = buffer.length > 0 ? `${buffer} ${para}` : para;

      if (candidate.length > TARGET_MAX) {
        if (buffer.length >= TARGET_MIN) {
          // バッファが十分: flush して段落を次バッファに
          flushBuffer();
          buffer = para.length > TARGET_MAX ? para.slice(0, TARGET_MAX) : para;
        } else {
          // バッファが小さい: バッファ + 段落をハードカット
          let remaining = buffer.length > 0 ? `${buffer} ${para}` : para;
          buffer = "";
          while (remaining.length > TARGET_MAX) {
            const cut = remaining.slice(0, TARGET_MAX).trim();
            if (cut.length > 0) {
              chunks.push({ chunkIndex, pageNumber: page.pageNumber, text: cut });
              chunkIndex++;
            }
            remaining = cut.slice(-OVERLAP) + remaining.slice(TARGET_MAX);
          }
          buffer = remaining;
        }
      } else {
        buffer = candidate;
        if (buffer.length >= TARGET_MIN) {
          flushBuffer();
        }
      }
    }
  }

  // 残りバッファを flush（短くても追加）
  const finalText = buffer.trim();
  if (finalText.length > 0) {
    chunks.push({ chunkIndex, pageNumber: bufferPage, text: finalText });
  }

  return chunks;
}
