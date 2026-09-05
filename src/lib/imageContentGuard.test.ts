// src/lib/imageContentGuard.test.ts
// COPY-1: アバター参照画像アップロードの著作権/NSFWモデレーション

const mockCallGeminiVisionJudge = jest.fn();
jest.mock("./gemini/client", () => ({
  callGeminiVisionJudge: (...args: unknown[]) => mockCallGeminiVisionJudge(...args),
}));

import { checkImageForInfringement } from "./imageContentGuard";

const DATA_URL = "data:image/png;base64,QUJD"; // "ABC"
const CONTEXT = { tenantId: "tenant-1", requestId: "req-1" };

beforeEach(() => {
  mockCallGeminiVisionJudge.mockClear();
});

describe("checkImageForInfringement — 正常系", () => {
  it("data: URLでない場合はチェックせず許可する（既にホスティング済みの生成画像URL等）", async () => {
    const result = await checkImageForInfringement("https://example.com/avatar.png", CONTEXT);
    expect(result).toEqual({ blocked: false });
    expect(mockCallGeminiVisionJudge).not.toHaveBeenCalled();
  });

  it("全フラグfalseの判定は許可する", async () => {
    mockCallGeminiVisionJudge.mockResolvedValue(
      JSON.stringify({ nsfw: false, copyrighted_character: false, celebrity_likeness: false, trademarked_logo: false, reason: "" })
    );
    const result = await checkImageForInfringement(DATA_URL, CONTEXT);
    expect(result).toEqual({ blocked: false });
  });

  it("data: URLをmime typeとbase64本体に分解してGeminiへ渡す", async () => {
    mockCallGeminiVisionJudge.mockResolvedValue(JSON.stringify({ nsfw: false }));
    await checkImageForInfringement(DATA_URL, CONTEXT);
    expect(mockCallGeminiVisionJudge).toHaveBeenCalledWith(
      expect.any(String),
      "QUJD",
      "image/png",
      expect.objectContaining({ tenantId: "tenant-1", requestId: "req-1", featureUsed: "avatar_image_moderation", billable: false })
    );
  });
});

describe("checkImageForInfringement — 各フラグでの拒否", () => {
  it.each(["nsfw", "copyrighted_character", "celebrity_likeness", "trademarked_logo"])(
    "%s が true ならブロックし、理由を返す",
    async (flag) => {
      mockCallGeminiVisionJudge.mockResolvedValue(JSON.stringify({ [flag]: true, reason: "検出理由" }));
      const result = await checkImageForInfringement(DATA_URL, CONTEXT);
      expect(result).toEqual({ blocked: true, reason: "検出理由" });
    }
  );

  it("reasonが空文字でもブロック時は既定の日本語メッセージを返す", async () => {
    mockCallGeminiVisionJudge.mockResolvedValue(JSON.stringify({ nsfw: true, reason: "" }));
    const result = await checkImageForInfringement(DATA_URL, CONTEXT);
    expect(result).toEqual({ blocked: true, reason: "不適切なコンテンツが検出されました" });
  });
});

describe("checkImageForInfringement — 異常系（フェイルオープン）", () => {
  it("Geminiがマークダウンフェンス付きJSONを返しても解析できる", async () => {
    mockCallGeminiVisionJudge.mockResolvedValue("```json\n{\"nsfw\": true, \"reason\": \"裸体\"}\n```");
    const result = await checkImageForInfringement(DATA_URL, CONTEXT);
    expect(result).toEqual({ blocked: true, reason: "裸体" });
  });

  it("Gemini呼び出しが例外を投げてもブロックせず許可する（フェイルオープン方針）", async () => {
    mockCallGeminiVisionJudge.mockRejectedValue(new Error("Gemini API error: 429"));
    const result = await checkImageForInfringement(DATA_URL, CONTEXT);
    expect(result).toEqual({ blocked: false });
  });

  it("Geminiの応答が不正なJSONでも例外を外に漏らさずフェイルオープンする", async () => {
    mockCallGeminiVisionJudge.mockResolvedValue("これはJSONではありません");
    const result = await checkImageForInfringement(DATA_URL, CONTEXT);
    expect(result).toEqual({ blocked: false });
  });
});
