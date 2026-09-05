// src/lib/resourceContentGuard.test.ts
// 資料PDF抽出テキストの著作権侵害/不適切表現モデレーション（imageContentGuard.test.tsと同型）

const mockCallGeminiJudge = jest.fn();
jest.mock("./gemini/client", () => ({
  callGeminiJudge: (...args: unknown[]) => mockCallGeminiJudge(...args),
}));

import { checkResourceTextForInfringement } from "./resourceContentGuard";

const CONTEXT = { tenantId: "tenant-1", requestId: "req-1" };

beforeEach(() => {
  mockCallGeminiJudge.mockClear();
});

describe("checkResourceTextForInfringement — 正常系", () => {
  it("全フラグfalseの判定は許可する", async () => {
    mockCallGeminiJudge.mockResolvedValue(
      JSON.stringify({ copyright_infringement: false, inappropriate_content: false, reason: "" })
    );
    const result = await checkResourceTextForInfringement("これは資料の本文です", CONTEXT);
    expect(result).toEqual({ blocked: false });
  });

  it("callGeminiJudge に tenantId/requestId を渡す（featureUsed/billableは既定のadmin_tuning/falseに委ねる）", async () => {
    mockCallGeminiJudge.mockResolvedValue(JSON.stringify({ copyright_infringement: false }));
    await checkResourceTextForInfringement("本文", CONTEXT);
    expect(mockCallGeminiJudge).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: "tenant-1", requestId: "req-1" })
    );
  });

  it("書籍内容と同じくログ・メトリクスに本文を出さないため、プロンプト長には上限がある", async () => {
    mockCallGeminiJudge.mockResolvedValue(JSON.stringify({ copyright_infringement: false }));
    const longText = "あ".repeat(20000);
    await checkResourceTextForInfringement(longText, CONTEXT);
    const promptArg = mockCallGeminiJudge.mock.calls[0]![0] as string;
    expect(promptArg.length).toBeLessThan(20000);
  });
});

describe("checkResourceTextForInfringement — 各フラグでの拒否", () => {
  it.each(["copyright_infringement", "inappropriate_content"])(
    "%s が true ならブロックし、理由を返す",
    async (flag) => {
      mockCallGeminiJudge.mockResolvedValue(JSON.stringify({ [flag]: true, reason: "検出理由" }));
      const result = await checkResourceTextForInfringement("本文", CONTEXT);
      expect(result).toEqual({ blocked: true, reason: "検出理由" });
    }
  );

  it("reasonが空文字でもブロック時は既定の日本語メッセージを返す", async () => {
    mockCallGeminiJudge.mockResolvedValue(JSON.stringify({ copyright_infringement: true, reason: "" }));
    const result = await checkResourceTextForInfringement("本文", CONTEXT);
    expect(result).toEqual({ blocked: true, reason: "不適切なコンテンツが検出されました" });
  });
});

describe("checkResourceTextForInfringement — 異常系（フェイルオープン）", () => {
  it("Geminiがマークダウンフェンス付きJSONを返しても解析できる", async () => {
    mockCallGeminiJudge.mockResolvedValue("```json\n{\"copyright_infringement\": true, \"reason\": \"盗用\"}\n```");
    const result = await checkResourceTextForInfringement("本文", CONTEXT);
    expect(result).toEqual({ blocked: true, reason: "盗用" });
  });

  it("Gemini呼び出しが例外を投げてもブロックせず許可する（フェイルオープン方針）", async () => {
    mockCallGeminiJudge.mockRejectedValue(new Error("Gemini API error: 429"));
    const result = await checkResourceTextForInfringement("本文", CONTEXT);
    expect(result).toEqual({ blocked: false });
  });

  it("Geminiの応答が不正なJSONでも例外を外に漏らさずフェイルオープンする", async () => {
    mockCallGeminiJudge.mockResolvedValue("これはJSONではありません");
    const result = await checkResourceTextForInfringement("本文", CONTEXT);
    expect(result).toEqual({ blocked: false });
  });

  // 全文モデレーション(Gemini呼び出しの課金・レイテンシ増)とのトレードオフとして、
  // プロンプトに渡す本文は先頭8000字(MAX_MODERATION_TEXT_CHARS)で切り詰める設計を
  // 意図的に採用している。8000字を超えた位置にしか問題箇所が無い文書は現在の設計では
  // 検出できない ―― これは「直すべきバグ」ではなく、既知の制約として明示的に固定する。
  it("既知の制約: 8000字を超えた位置の問題は現在の設計では検出できない(ドキュメント化)", async () => {
    const cleanPrefix = "これは問題のない前置き文章です。".repeat(501); // 8000字超のクリーンな前置き
    expect(cleanPrefix.length).toBeGreaterThan(8000);
    const textWithInfringementAfterWindow = cleanPrefix + "ここから先は書籍からの盗用です";

    // 8000字で切り詰められた後の本文(全てクリーン)しかGeminiに渡らないため、常に非ブロック
    mockCallGeminiJudge.mockResolvedValue(
      JSON.stringify({ copyright_infringement: false, inappropriate_content: false, reason: "" })
    );
    const result = await checkResourceTextForInfringement(textWithInfringementAfterWindow, CONTEXT);
    expect(result).toEqual({ blocked: false });

    // 実際にGeminiへ渡ったプロンプトに「盗用」の一文が含まれていないことを確認する
    // (=ウィンドウの外側にあり、そもそも判定対象になっていないことの証跡)
    const promptArg = mockCallGeminiJudge.mock.calls[0]![0] as string;
    expect(promptArg).not.toContain("ここから先は書籍からの盗用です");
  });
});
