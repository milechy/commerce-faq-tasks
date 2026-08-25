// src/lib/ocrPipeline.test.ts
// GID 1216944049264977: Qwen OCR(全ページ) + OpenAI embedding(全チャンク)を
// trackUsageで計測することの検証。ページ/チャンク単位で行を増やさず
// 1回のPDF取り込みにつき1リクエストとして計測されることを確認する。

import fs from 'node:fs';
import path from 'node:path';

const mockBulk = jest.fn();
const mockFromPath = jest.fn((..._args: unknown[]) => ({ bulk: mockBulk }));
jest.mock('pdf2pic', () => ({
  fromPath: (...args: unknown[]) => mockFromPath(...args),
}));

const mockPoolQuery = jest.fn();
const mockPoolEnd = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: (...args: unknown[]) => mockPoolQuery(...args),
    end: (...args: unknown[]) => mockPoolEnd(...args),
  })),
}), { virtual: true });

const mockEmbedTextWithUsage = jest.fn();
jest.mock('../agent/llm/openaiEmbeddingClient', () => ({
  embedTextWithUsage: (...args: unknown[]) => mockEmbedTextWithUsage(...args),
}));

const mockTrackUsage = jest.fn();
jest.mock('./billing/usageTracker', () => ({
  trackUsage: (...args: unknown[]) => mockTrackUsage(...args),
}));

import { runOcrPipeline, splitIntoChunks } from './ocrPipeline';

describe('splitIntoChunks', () => {
  it('空文字は空配列を返す', () => {
    expect(splitIntoChunks('', 500)).toEqual([]);
  });

  it('chunkSize未満のテキストは1チャンク', () => {
    expect(splitIntoChunks('あいうえお', 500)).toEqual(['あいうえお']);
  });

  it('1200文字をchunkSize=500で分割すると3チャンクになる', () => {
    const text = 'あ'.repeat(1200);
    const chunks = splitIntoChunks(text, 500);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(500);
    expect(chunks[1]).toHaveLength(500);
    expect(chunks[2]).toHaveLength(200);
  });
});

describe('runOcrPipeline: trackUsage計測（GID 1216944049264977）', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env = { ...ORIGINAL_ENV, DATABASE_URL: 'postgres://test', QWEN_API_KEY: 'test-qwen-key' };
    mockPoolQuery.mockResolvedValue({});
    mockPoolEnd.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.useRealTimers();
    delete (global as any).fetch;
  });

  /** pdf2picのbulk()モック: fromPathに渡されたsavePathへダミーPNGをpageCount枚書き出す */
  function mockPdfToImages(pageCount: number): void {
    mockBulk.mockImplementation(async () => {
      const lastCallArgs = mockFromPath.mock.calls[mockFromPath.mock.calls.length - 1];
      const opts = lastCallArgs[1] as { savePath: string };
      return Array.from({ length: pageCount }, (_, i) => {
        const p = path.join(opts.savePath, `page.${i + 1}.png`);
        fs.writeFileSync(p, Buffer.from('fake-png-bytes'));
        return { path: p };
      });
    });
  }

  it('3ページ×3チャンクでも1回のPDF取り込みにつきtrackUsageは1回だけ、ocrPages=3・embeddingトークンが合算される', async () => {
    // 1200文字 → CHUNK_SIZE=500 で1ページあたり3チャンクに分割される
    const OCR_TEXT_PER_PAGE = 'あ'.repeat(1200);
    mockPdfToImages(3);

    (global as any).fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: OCR_TEXT_PER_PAGE } }] }),
    });

    // 1チャンックあたり50トークン消費したと仮定（9チャンク合計450トークン）
    mockEmbedTextWithUsage.mockResolvedValue({ embedding: [0.1, 0.2, 0.3], totalTokens: 50 });

    const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content');
    const resultPromise = runOcrPipeline(pdfBuffer, 'tenant-1');
    await jest.runAllTimersAsync(); // ページ間ディレイ(PAGE_DELAY_MS)を進める
    const result = await resultPromise;

    expect(result).toEqual({ pages: 3, chunks: 9 }); // 3ページ × 3チャンク = 9チャンク
    expect(mockEmbedTextWithUsage).toHaveBeenCalledTimes(9);
    // PR-2(2026-08-25収益監査): チャンク単位の埋め込みは skipTracking=true で呼ぶ。
    // トークンは下の extraLlmUsages に合算される1行に内包するため、ここで別行(かつ
    // tenant_id='unknown')を作らせない。
    for (const call of mockEmbedTextWithUsage.mock.calls) {
      expect(call[1]).toEqual({ skipTracking: true });
    }

    // 行数ベース課金のため、ページ/チャンク単位で行を増やさず1回だけ記録する
    expect(mockTrackUsage).toHaveBeenCalledTimes(1);
    expect(mockTrackUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        featureUsed: 'book_analysis',
        ocrPages: 3,
        extraLlmUsages: [{ model: 'openai-embedding', inputTokens: 450, outputTokens: 0 }],
      })
    );
  }, 15000);

  it('0ページ（画像変換結果が空）のときはtrackUsageを呼ばない', async () => {
    mockPdfToImages(0);
    (global as any).fetch = jest.fn();

    const pdfBuffer = Buffer.from('%PDF-1.4 fake pdf content');
    const resultPromise = runOcrPipeline(pdfBuffer, 'tenant-1');
    await jest.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ pages: 0, chunks: 0 });
    expect(mockTrackUsage).not.toHaveBeenCalled();
  }, 15000);

  it('DATABASE_URL未設定は例外を投げる', async () => {
    delete process.env.DATABASE_URL;
    await expect(runOcrPipeline(Buffer.from('x'), 'tenant-1')).rejects.toThrow('DATABASE_URL is not set');
  });

  it('QWEN_API_KEY未設定は例外を投げる', async () => {
    delete process.env.QWEN_API_KEY;
    await expect(runOcrPipeline(Buffer.from('x'), 'tenant-1')).rejects.toThrow('QWEN_API_KEY is not set');
  });
});
