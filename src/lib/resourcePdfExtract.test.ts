// src/lib/resourcePdfExtract.test.ts
// 非暗号化の資料PDFからのテキスト抽出。抽出失敗を黙って握りつぶさないことを固定する
// （要件書 docs/RESOURCE_OFFER_REQUIREMENTS.md 6.2 §17）。

const mockPdfParse = jest.fn();
jest.mock("pdf-parse", () => (...args: unknown[]) => mockPdfParse(...args));

import { extractResourcePdfText, ResourcePdfExtractError } from "./resourcePdfExtract";

beforeEach(() => {
  mockPdfParse.mockReset();
});

describe("extractResourcePdfText — 正常系", () => {
  it("pdf-parse が返したテキストをtrimして返す", async () => {
    mockPdfParse.mockResolvedValue({ text: "  資料の本文です  \n", numpages: 3 });
    const result = await extractResourcePdfText(Buffer.from("dummy-pdf"));
    expect(result).toBe("資料の本文です");
  });

  it("pdf-parse に渡すバッファをそのまま転送する", async () => {
    mockPdfParse.mockResolvedValue({ text: "本文", numpages: 1 });
    const buffer = Buffer.from("raw-pdf-bytes");
    await extractResourcePdfText(buffer);
    expect(mockPdfParse).toHaveBeenCalledWith(buffer);
  });
});

describe("extractResourcePdfText — 異常系（黙って握りつぶさない）", () => {
  it("pdf-parse が例外を投げたら ResourcePdfExtractError を投げる（呼び出し側がmoderation_statusを『未検査』に倒せるように）", async () => {
    mockPdfParse.mockRejectedValue(new Error("Invalid PDF structure"));
    await expect(extractResourcePdfText(Buffer.from("broken"))).rejects.toThrow(ResourcePdfExtractError);
  });

  it("パスワード付きPDF等の失敗理由を例外メッセージに含める", async () => {
    mockPdfParse.mockRejectedValue(new Error("password required"));
    await expect(extractResourcePdfText(Buffer.from("locked"))).rejects.toThrow(/password required/);
  });

  it("抽出失敗時にフォールバック値（空文字等）を返さない", async () => {
    mockPdfParse.mockRejectedValue(new Error("boom"));
    let thrown: unknown = null;
    try {
      await extractResourcePdfText(Buffer.from("broken"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ResourcePdfExtractError);
  });
});
