// src/agent/psychology/principleSearch.test.ts
// id=48: principleSearch.ts の global tenant 対応（他RAG経路と一貫性）回帰テスト

import { Pool } from 'pg';
import { searchPrincipleChunks } from './principleSearch';
import type { StructuredPrinciple } from '../knowledge/bookStructurizer';

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

describe('searchPrincipleChunks', () => {
  it('SQL は tenant_id = $1 OR tenant_id = \'global\' で共有テナントも対象にする', async () => {
    const { pool, query } = makePoolMock([]);
    await searchPrincipleChunks('tenant-A', ['アンカリング効果'], pool);

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/tenant_id = \$1\s+OR\s+tenant_id = 'global'/);
    // パラメータは [tenantId, principles] のまま（global はリテラル）
    expect(query.mock.calls[0][1]).toEqual(['tenant-A', ['アンカリング効果']]);
  });

  it('global テナントの book チャンクを返却できる', async () => {
    const { pool } = makePoolMock([bookRowFixture(SAMPLE_PRINCIPLE)]);
    const result = await searchPrincipleChunks('tenant-A', ['アンカリング効果'], pool);
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
    const result = await searchPrincipleChunks('tenant-A', ['x'], pool);
    expect(result[0].situation.length).toBe(200);
    expect(result[0].example.length).toBe(200);
    expect(result[0].contraindication.length).toBe(200);
  });

  it('principles が空なら DB を叩かず空配列を返す', async () => {
    const { pool, query } = makePoolMock([]);
    const result = await searchPrincipleChunks('tenant-A', [], pool);
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('DB エラー時は空配列を返す（書籍内容をログに出さない）', async () => {
    const query = jest.fn().mockRejectedValue(new Error('db down'));
    const pool = { query } as unknown as InstanceType<typeof Pool>;
    const result = await searchPrincipleChunks('tenant-A', ['x'], pool);
    expect(result).toEqual([]);
  });
});
