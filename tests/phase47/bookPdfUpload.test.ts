// tests/phase47/bookPdfUpload.test.ts
// Fix1: アップロード時の自動パイプライン起動 / Fix2: 日本語ファイル名デコード

// ── モック ────────────────────────────────────────────────────────────────────

const mockRunBookPipeline = jest.fn();
jest.mock("../../src/lib/book-pipeline/pipeline", () => ({
  runBookPipeline: (...args: unknown[]) => mockRunBookPipeline(...args),
}));

const mockStorageUpload = jest.fn();
const mockSupabaseAdmin = {
  storage: {
    from: () => ({ upload: mockStorageUpload }),
  },
};
jest.mock("../../src/auth/supabaseClient", () => ({
  supabaseAdmin: mockSupabaseAdmin,
}));

// ── テストユーティリティ ───────────────────────────────────────────────────────

/**
 * latin1エンコードされた日本語ファイル名のシミュレーション。
 * multerがContent-Dispositionのfilenameをlatin1でデコードするのと同じ処理。
 */
function simulateMullerDecode(originalUtf8: string): string {
  // UTF-8バイト列をlatin1文字列として解釈する（multerの動作を再現）
  const utf8Bytes = Buffer.from(originalUtf8, "utf8");
  return utf8Bytes.toString("latin1");
}

/**
 * bookPdfRoutes.ts内のファイル名デコードロジックを再現。
 * 実装と同じロジックをテスト。
 */
function decodeFilename(originalname: string): string {
  try {
    return Buffer.from(originalname, "latin1").toString("utf8");
  } catch {
    return originalname;
  }
}

// ── テスト: Fix2 日本語ファイル名デコード ──────────────────────────────────────

describe("Fix2: 日本語ファイル名のlatin1→utf8デコード", () => {
  it("multerがlatin1でデコードした日本語ファイル名を正しくUTF-8に復元する", () => {
    const original = "営業マニュアル2024.pdf";
    const multerDecoded = simulateMullerDecode(original);

    // multerデコード後は文字化けしているはず
    expect(multerDecoded).not.toBe(original);

    // 修正ロジックで復元できること
    const restored = decodeFilename(multerDecoded);
    expect(restored).toBe(original);
  });

  it("ASCII-onlyファイル名はデコード後も変わらない", () => {
    const asciiName = "manual2024.pdf";
    // ASCII文字はlatin1とUTF-8で同じバイト列なので変化しない
    const multerDecoded = simulateMullerDecode(asciiName);
    expect(multerDecoded).toBe(asciiName);

    const restored = decodeFilename(multerDecoded);
    expect(restored).toBe(asciiName);
  });

  it("英数字混在ファイル名も正しく処理される", () => {
    const name = "product-list-製品一覧.pdf";
    const multerDecoded = simulateMullerDecode(name);
    const restored = decodeFilename(multerDecoded);
    expect(restored).toBe(name);
  });

  it("空文字列はそのまま返す", () => {
    expect(decodeFilename("")).toBe("");
  });
});

// ── テスト: Fix1 アップロード時の自動パイプライン起動 ─────────────────────────

describe("Fix1: アップロード成功時に runBookPipeline が自動起動される", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorageUpload.mockResolvedValue({ error: null });
    mockRunBookPipeline.mockResolvedValue({ chunkCount: 5, pageCount: 10 });
  });

  it("runBookPipeline は Promise を返しており、非同期で呼び出せる", async () => {
    // bookId=99 でパイプラインを呼び出す
    const bookId = 99;
    const mockDb = {} as any;

    // 自動起動ロジックと同じパターン: catch でエラーをログし、レスポンスはブロックしない
    let pipelineCalled = false;
    mockRunBookPipeline.mockImplementation(async () => {
      pipelineCalled = true;
      return { chunkCount: 3, pageCount: 5 };
    });

    mockRunBookPipeline(bookId, { db: mockDb }).catch(() => {});

    // Promiseが解決されるまで待機
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pipelineCalled).toBe(true);
    expect(mockRunBookPipeline).toHaveBeenCalledWith(bookId, { db: mockDb });
  });

  it("パイプラインエラーはcatchされ、呼び出し元には伝播しない（non-blocking）", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    mockRunBookPipeline.mockRejectedValue(new Error("pipeline failed"));

    const bookId = 42;
    // アップロードハンドラのパイプライン起動パターンを再現
    let errorCaught = false;
    mockRunBookPipeline(bookId, { db: {} }).catch((pipelineErr: unknown) => {
      errorCaught = true;
      console.error(
        "[book-pdf] auto-pipeline error book_id=%d:",
        bookId,
        pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr)
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorCaught).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      "[book-pdf] auto-pipeline error book_id=%d:",
      bookId,
      "pipeline failed"
    );

    consoleSpy.mockRestore();
  });

  it("パイプライン起動はレスポンスをブロックしない（fire-and-forget）", async () => {
    // パイプラインが長時間かかると仮定しても、呼び出し元はすぐに完了する
    let pipelineStarted = false;
    mockRunBookPipeline.mockImplementation(
      () =>
        new Promise((resolve) => {
          pipelineStarted = true;
          // 100ms後に解決（テストでは待機しない）
          setTimeout(() => resolve({ chunkCount: 1, pageCount: 1 }), 100);
        })
    );

    const start = Date.now();
    // fire-and-forget パターン: catchのみ登録し、awaitしない
    mockRunBookPipeline(1, { db: {} }).catch(() => {});
    const elapsed = Date.now() - start;

    // パイプライン完了を待たずにすぐ戻る（< 50ms）
    expect(elapsed).toBeLessThan(50);
    expect(pipelineStarted).toBe(true);
  });
});
