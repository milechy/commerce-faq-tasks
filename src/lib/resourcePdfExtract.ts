// src/lib/resourcePdfExtract.ts
//
// 資料PDF（非暗号化）からテキストを抽出する薄いラッパー。
// src/lib/book-pipeline/pdfExtractor.ts の extractPdfText() は書籍PDFの
// Supabase Storageダウンロード + AES-256-GCM復号に結合しているため、
// 暗号化されていない資料PDFには使えない（流用しない）。

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }> = require("pdf-parse");

export class ResourcePdfExtractError extends Error {}

/**
 * 非暗号化PDFバッファからテキストを抽出する。
 *
 * 失敗（壊れたPDF・パスワード付きPDF等）は例外を投げる。黙ってフォールバック値を
 * 返さないのは、呼び出し側が抽出失敗を検知して moderation_status を「未検査」に
 * 倒すため（要件書6.2 §17: 抽出失敗を「通過」扱いにしない）。
 *
 * 画像のみ（スキャン）のPDFは pdf-parse が例外を投げず空文字を返すため、それも
 * 同じ「未検査」経路に倒す（空のテキストをモデレーション「通過」扱いにしない）。
 */
export async function extractResourcePdfText(buffer: Buffer): Promise<string> {
  let text: string;
  try {
    const result = await pdfParse(buffer);
    text = result.text.trim();
  } catch (err) {
    throw new ResourcePdfExtractError(
      `資料PDFのテキスト抽出に失敗しました: ${(err as Error).message}`
    );
  }
  if (text.length === 0) {
    throw new ResourcePdfExtractError(
      "資料PDFからテキストを抽出できませんでした（画像のみのPDFの可能性があります）"
    );
  }
  return text;
}
