// src/agent/psychology/principleSearch.test.ts
// id=48: principleSearch.ts の global tenant 対応（他RAG経路と一貫性）回帰テスト
// 2026-08-29: 原則名の完全一致からベクトル近傍検索へ変更したことに追随。

jest.mock('../llm/openaiEmbeddingClient', () => ({
  embedText: jest.fn(),
}));

import { Pool } from 'pg';
import { searchPrincipleChunks } from './principleSearch';
import { embedText } from '../llm/openaiEmbeddingClient';
import type { StructuredPrinciple } from '../knowledge/bookStructurizer';

const mockEmbedText = embedText as jest.MockedFunction<typeof embedText>;
const DUMMY_VECTOR = [0.1, 0.2, 0.3];

// pg Pool を db 引数注入でモック（外部依存はモックする方針）
function makePoolMock(rows: Array<Record<string, string | null>>) {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as InstanceType<typeof Pool>, query };
}

// 2026-08-29 継ぎ目バグ対策: 以前はDB行を「あるべき理想の行」として自作しており、
// bookStructurizer.ts が実際に書くフィールド名とのズレ(example欠落等)を検出できなかった。
// ここでは bookStructurizer.ts の StructuredPrinciple 型からプロパティアクセスで
// 行を組み立て、principleSearch.ts が SELECT する4列(principle/situation/example/
// contraindication)だけを取り出す。StructuredPrinciple のフィールド名が変われば
// このファイルもコンパイルエラーになる。
function bookRowFixture(p: StructuredPrinciple): Record<string, string> {
  return {
    principle: p.principle,
    situation: p.situation,
    example: p.example,
    contraindication: p.contraindication,
  };
}

const SAMPLE_PRINCIPLE: StructuredPrinciple = {
  situation: '価格提示の前に基準値を示す',
  resistance: '価格が高いと感じている',
  principle: 'アンカリング効果',
  contraindication: '誇大広告は禁止',
  example: '通常価格を先に見せる',
  failure_example: '過大なアンカーは不信感を招く',
};

beforeEach(() => {
  mockEmbedText.mockReset();
  mockEmbedText.mockResolvedValue(DUMMY_VECTOR);
});

describe('searchPrincipleChunks', () => {
  it('SQL は tenant_id = $1 OR tenant_id = \'global\' で共有テナントも対象にする', async () => {
    const { pool, query } = makePoolMock([]);
    await searchPrincipleChunks('tenant-A', '受付で断られてしまいます', pool);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/tenant_id = \$1\s+OR\s+tenant_id = 'global'/);
    // パラメータは [tenantId, ベクトルリテラル, topK]（global はリテラル）
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('tenant-A');
    expect(params[1]).toBe(`[${DUMMY_VECTOR.join(',')}]`);
  });

  it('ベクトル近傍検索で引く（原則名の完全一致に戻らない）', async () => {
    const { pool, query } = makePoolMock([]);
    await searchPrincipleChunks('tenant-A', '受付で断られてしまいます', pool);

    const sql = query.mock.calls[0][0] as string;
    // 本番91件の principle は統制語彙と1件も一致しないため、完全一致に戻すと永久に0件になる
    expect(sql).not.toMatch(/= ANY\(/);
    expect(sql).toMatch(/ORDER BY embedding <-> \$2::vector/);
    expect(sql).toMatch(/metadata->>'principle' IS NOT NULL/);
  });

  // 2026-08-29: 書籍スキーマは contentAnalyzer.ts が書籍ごとに選ぶ。psychology_book の
  // キー名を SQL に直書きしていたため、sales_manual と判定された本番 book_id=6 の
  // 81件が丸ごと原則注入から外れていた(管理画面は「登録完了」と表示するため無言で壊れる)。
  it('psychology_book 以外のスキーマ(sales_manual)のキーも読む', async () => {
    const { pool, query } = makePoolMock([]);
    await searchPrincipleChunks('tenant-A', 'セールストークの組み立て方', pool);
    const sql = query.mock.calls[0][0] as string;

    // 打ち手: principle(psychology_book) と solution(sales_manual) の両方
    expect(sql).toMatch(/COALESCE\(metadata->>'principle', metadata->>'solution'\) AS principle/);
    // 状況: situation と problem
    expect(sql).toMatch(/COALESCE\(metadata->>'situation', metadata->>'problem'\) AS situation/);
    // 注意: contraindication と objection_handling
    expect(sql).toMatch(
      /COALESCE\(metadata->>'contraindication', metadata->>'objection_handling'\) AS contraindication/,
    );
  });

  it('WHERE は打ち手を持つ全スキーマを対象にする(principle 決め打ちに戻らない)', async () => {
    const { pool, query } = makePoolMock([]);
    await searchPrincipleChunks('tenant-A', 'x', pool);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(
      /\(metadata->>'principle' IS NOT NULL OR metadata->>'solution' IS NOT NULL\)/,
    );
  });

  it('sales_manual 形状の行も PrincipleChunk として返す', async () => {
    // DB は COALESCE の別名で返すため、行の形は psychology_book と同じになる。
    // 本番 book_id=6 の実データ由来の値を使う。
    const { pool } = makePoolMock([
      {
        principle: '顧客の心理を把握し、顧客満足度と契約率を上げる', // ← solution
        situation: '営業が主導権を握ることが困難', // ← problem
        example: null, // sales_manual には対応フィールドが無い
        contraindication: '顧客の反論に対処するために、顧客の心理を把握する', // ← objection_handling
      },
    ]);
    const result = await searchPrincipleChunks('tenant-A', '主導権が握れません', pool);
    expect(result).toHaveLength(1);
    expect(result[0].principle).toBe('顧客の心理を把握し、顧客満足度と契約率を上げる');
    expect(result[0].situation).toBe('営業が主導権を握ることが困難');
    // null は空文字に落とす(buildPrinciplePrompt が行ごと省く)
    expect(result[0].example).toBe('');
  });

  it('検索対象から is_excluded_from_search の行を除外する', async () => {
    const { pool, query } = makePoolMock([]);
    await searchPrincipleChunks('tenant-A', 'x', pool);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/is_excluded_from_search IS NULL OR is_excluded_from_search = false/);
  });

  it('global テナントの book チャンクを返却できる', async () => {
    const { pool } = makePoolMock([bookRowFixture(SAMPLE_PRINCIPLE)]);
    const result = await searchPrincipleChunks('tenant-A', '値段が高いと言われた', pool);
    expect(result).toHaveLength(1);
    expect(result[0].principle).toBe('アンカリング効果');
    // bookStructurizer が書く example がそのまま読めていることの確認
    // (継ぎ目バグ: 以前は example が metadata に書かれておらず常に空文字だった)。
    expect(result[0].example).toBe('通常価格を先に見せる');
  });

  it('全テキストフィールドに slice(0, 200) を適用する（書籍内容漏洩防止）', async () => {
    const long = 'あ'.repeat(500);
    const longPrinciple: StructuredPrinciple = {
      ...SAMPLE_PRINCIPLE,
      principle: long,
      situation: long,
      example: long,
      contraindication: long,
    };
    const { pool } = makePoolMock([bookRowFixture(longPrinciple)]);
    const result = await searchPrincipleChunks('tenant-A', 'x', pool);
    expect(result[0].situation.length).toBe(200);
    expect(result[0].example.length).toBe(200);
    expect(result[0].contraindication.length).toBe(200);
  });

  it('queryText が空なら DB も埋め込みも叩かず空配列を返す', async () => {
    const { pool, query } = makePoolMock([]);
    const result = await searchPrincipleChunks('tenant-A', '   ', pool);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(mockEmbedText).not.toHaveBeenCalled();
  });

  it('埋め込み失敗時は空配列を返す（回答生成を止めない）', async () => {
    mockEmbedText.mockRejectedValue(new Error('openai down'));
    const { pool, query } = makePoolMock([]);
    const result = await searchPrincipleChunks('tenant-A', 'x', pool);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('DB エラー時は空配列を返す（書籍内容をログに出さない）', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db down'));
    const pool = { query } as unknown as InstanceType<typeof Pool>;
    const result = await searchPrincipleChunks('tenant-A', 'x', pool);
    expect(result).toEqual([]);
  });
});
