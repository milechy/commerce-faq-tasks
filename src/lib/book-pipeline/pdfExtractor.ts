// src/lib/book-pipeline/pdfExtractor.ts
// Phase44: PDF復号 + テキスト抽出モジュール
// セキュリティ: 復号後のPDFバイナリをファイルシステムに書き出さない（メモリ上のみ）

import crypto from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buffer: Buffer, options?: Record<string, unknown>) => Promise<{ text: string; numpages: number }> = require("pdf-parse");

export interface PageText {
  pageNumber: number;
  text: string;
}

// ── AES-256-GCM バッファ復号 ────────────────────────────────────────────────
// P0 の encryptBuffer と対応: [encrypted_data || authTag(16bytes)]
function decryptBuffer(encryptedWithTag: Buffer, keyHex: string, ivHex: string): Buffer {
  const key = Buffer.from(keyHex, "hex");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = encryptedWithTag.slice(encryptedWithTag.length - 16);
  const data = encryptedWithTag.slice(0, encryptedWithTag.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export interface PdfExtractorDeps {
  /** Supabase Admin クライアント（book-pdfs バケットのダウンロード用） */
  supabase: {
    storage: {
      from: (bucket: string) => {
        download: (path: string) => Promise<{ data: Blob | null; error: { message: string } | null }>;
      };
    };
  };
}

/**
 * book_uploads テーブルの情報を使い、Supabase Storage から暗号化PDFを
 * ダウンロード・復号してページ単位のテキストを返す。
 *
 * @param storagePath  book_uploads.storage_path
 * @param encryptionIv book_uploads.encryption_iv (hex文字列、nullなら平文)
 * @returns { pages: PageText[], pageCount: number }
 */
export async function extractPdfText(
  deps: PdfExtractorDeps,
  storagePath: string,
  encryptionIv: string | null
): Promise<{ pages: PageText[]; pageCount: number }> {
  // 1. Supabase Storage からダウンロード
  const { data, error } = await deps.supabase.storage
    .from("book-pdfs")
    .download(storagePath);

  if (error || !data) {
    throw new Error(`Supabase Storage ダウンロード失敗: ${error?.message ?? "no data"}`);
  }

  const encryptedBuffer = Buffer.from(await data.arrayBuffer());

  // 2. 復号（encryption_iv が null の場合は平文）
  let pdfBuffer: Buffer;
  const encKey = process.env.KNOWLEDGE_ENCRYPTION_KEY;

  if (encryptionIv && encKey) {
    pdfBuffer = decryptBuffer(encryptedBuffer, encKey, encryptionIv);
  } else if (encryptionIv && !encKey) {
    throw new Error("KNOWLEDGE_ENCRYPTION_KEY が設定されていないため復号できません");
  } else {
    // 平文保存フォールバック
    pdfBuffer = encryptedBuffer;
  }

  // 3. pdf-parse でテキスト抽出（ページ単位）
  const pages: PageText[] = [];
  let pageCount = 0;

  await pdfParse(pdfBuffer, {
    pagerender: (pageData: { pageIndex: number; getTextContent: () => Promise<{ items: { str: string }[] }> }) => {
      return pageData.getTextContent().then((content) => {
        const text = content.items
          .map((item) => item.str)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        // 書籍内容をログに含めない（Anti-Slopルール）
        if (text.length > 0) {
          pages.push({ pageNumber: pageData.pageIndex + 1, text });
        }
        pageCount = pageData.pageIndex + 1;
        return text;
      });
    },
  }).catch(async () => {
    // pagerender が使えない環境のフォールバック: 全文テキストを1ページとして扱う
    const result = await pdfParse(pdfBuffer);
    const fullText = result.text.trim();
    pageCount = result.numpages;
    if (fullText) {
      pages.push({ pageNumber: 1, text: fullText });
    }
  });

  // pagerender フォールバック: pages が空で pdfBuffer が有効な場合
  if (pages.length === 0 && pdfBuffer.length > 0) {
    const result = await pdfParse(pdfBuffer);
    const fullText = result.text.trim();
    pageCount = result.numpages;
    if (fullText) {
      pages.push({ pageNumber: 1, text: fullText });
    }
  }

  return { pages, pageCount: pageCount || pages.length };
}
