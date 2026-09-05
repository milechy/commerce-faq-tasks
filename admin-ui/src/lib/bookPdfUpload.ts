// 書籍PDF取り込み(POST /v1/admin/knowledge/book-pdf)のクライアント側ルール。
// 旧UI(components/knowledge/PdfUploadTab.tsx)と新UI(pages/copilot-preview)の双方から
// 参照する。同じ操作を2面に置く以上、受け付ける拡張子・MIME・サイズ上限が片方だけ
// 緩む/厳しくなる事故を型で防ぐため、判定はここだけに置く。
// 文言は面ごとに異なる(旧UIはi18n辞書・新UIは会話体)ため、ここでは持たない。

export const MAX_BOOK_PDF_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_ZIP_SIZE = 50 * 1024 * 1024; // 50MB

const ZIP_TYPES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip"]);

export function isZipFile(file: File): boolean {
  return ZIP_TYPES.has(file.type) || file.name.toLowerCase().endsWith(".zip");
}

export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export type BookPdfRejection = "type" | "pdf_size" | "zip_size";

export type BookPdfValidation =
  | { kind: "pdf" }
  | { kind: "zip" }
  | { kind: "rejected"; reason: BookPdfRejection };

/** ブラウザ側の受付判定。サーバー側の上限(multer 50MB)とは別で、ここは体感を良くするための事前弾き */
export function validateBookPdfFile(file: File): BookPdfValidation {
  const zip = isZipFile(file);
  if (!isPdfFile(file) && !zip) return { kind: "rejected", reason: "type" };
  if (zip) {
    return file.size > MAX_ZIP_SIZE ? { kind: "rejected", reason: "zip_size" } : { kind: "zip" };
  }
  return file.size > MAX_BOOK_PDF_SIZE ? { kind: "rejected", reason: "pdf_size" } : { kind: "pdf" };
}

/** 拡張子を落としたタイトル(サーバーが単体PDFに必須で要求する)。空になる名前ではファイル名をそのまま使う */
export function defaultBookTitle(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "").trim() || fileName;
}

// 資料オファー(docs/RESOURCE_OFFER_REQUIREMENTS.md)のPDF検証。書籍PDF(ZIP可・10MB)とは
// 上限・受付形式が異なる(資料は単体PDFのみ・20MB、src/api/admin/resources/routes.ts の
// MAX_RESOURCE_PDF_SIZE と揃える)ため、isPdfFile を再利用しつつ別関数にする
// (第2の添付経路ではなく、既存ファイルへの追加関数)。
export const MAX_RESOURCE_PDF_SIZE = 20 * 1024 * 1024; // 20MB

export type ResourceFileRejection = "type" | "size";

export type ResourceFileValidation = { kind: "pdf" } | { kind: "rejected"; reason: ResourceFileRejection };

/** ブラウザ側の受付判定。サーバー側の上限(multer 20MB)とは別で、ここは体感を良くするための事前弾き */
export function validateResourceFile(file: File): ResourceFileValidation {
  if (!isPdfFile(file)) return { kind: "rejected", reason: "type" };
  return file.size > MAX_RESOURCE_PDF_SIZE ? { kind: "rejected", reason: "size" } : { kind: "pdf" };
}

export type UploadErrorKind = "auth" | "too_large" | "generic";

/** HTTPステータスを面に依存しないエラー種別へ落とす。文言の組み立ては呼び出し側の責務 */
export function classifyUploadStatus(status: number): UploadErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 413) return "too_large";
  return "generic";
}

export interface UploadResult {
  status: number;
  body: unknown;
  networkError?: boolean;
}

/**
 * FormDataをXHRで送信し、進捗(0-100)をonProgressへ通知する(fetchでは送信進捗が取れない)。
 * method は既定 "POST"(書籍PDF取り込みの既存契約)。資料オファーの PUT /v1/admin/resources
 * のように別メソッドを使うエンドポイントもこの関数をそのまま再利用する(第2のXHRアップロード
 * 実装を作らない)。
 */
export function uploadBookPdfWithProgress(
  url: string,
  form: FormData,
  token: string | null,
  onProgress: (pct: number) => void,
  method: "POST" | "PUT" = "POST",
): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });
    xhr.addEventListener("load", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      resolve({ status: xhr.status, body });
    });
    xhr.addEventListener("error", () => {
      resolve({ status: 0, body: null, networkError: true });
    });
    xhr.open(method, url);
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.send(form);
  });
}
