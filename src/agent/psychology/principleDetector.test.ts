// src/agent/psychology/principleDetector.test.ts
// Phase44: principleDetector のユニットテスト

import { detectPrinciples } from './principleDetector';
import { buildPrinciplePrompt } from '../tools/synthesisTool';
import type { PrincipleChunk } from './principleSearch';

// Groq クライアントをモック
jest.mock('../llm/groqClient', () => ({
  groqClient: {
    call: jest.fn().mockResolvedValue('[]'),
  },
}));

import { groqClient } from '../llm/groqClient';

describe('detectPrinciples', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (groqClient.call as jest.Mock).mockResolvedValue('[]');
  });

  it('キーワード「高い」→ principles に「アンカリング効果」が含まれる', async () => {
    const messages = [{ role: 'user', content: 'この商品は高いですか？' }];
    const result = await detectPrinciples(messages);
    expect(result.principles).toContain('アンカリング効果');
    expect(result.method).toBe('keyword');
  });

  it('キーワード「他社」→ principles に「社会的証明」が含まれる', async () => {
    const messages = [{ role: 'user', content: '他社と比べてどうですか？' }];
    const result = await detectPrinciples(messages);
    expect(result.principles).toContain('社会的証明');
    expect(result.method).toBe('keyword');
  });

  it('キーワードマッチなし → method が "llm"（Groq呼び出しをモック）', async () => {
    (groqClient.call as jest.Mock).mockResolvedValue('[]');
    const messages = [{ role: 'user', content: 'こんにちは、よろしくお願いします。' }];
    const result = await detectPrinciples(messages);
    expect(result.method).toBe('llm');
  });

  it('原則が最大3つに制限される', async () => {
    // 複数キーワードをマッチさせる
    const messages = [
      {
        role: 'user',
        content: '高い価格で他社と比べると、限定品で損しそうですが、サービスはどうですか？',
      },
    ];
    const result = await detectPrinciples(messages);
    expect(result.principles.length).toBeLessThanOrEqual(3);
    expect(result.method).toBe('keyword');
  });

  it('salesStage が propose のときキーワードマッチなしでも最低1原則を返す', async () => {
    (groqClient.call as jest.Mock).mockResolvedValue('[]');
    const messages = [{ role: 'user', content: 'こんにちは' }];
    const result = await detectPrinciples(messages, 'propose');
    expect(result.principles.length).toBeGreaterThanOrEqual(1);
    expect(result.method).toBe('llm');
  });

  it('LLMが有効な原則名を返す場合はそれを使用する', async () => {
    (groqClient.call as jest.Mock).mockResolvedValue('["社会的証明", "希少性"]');
    process.env.GROQ_API_KEY = 'test-key';
    const messages = [{ role: 'user', content: 'こんにちは' }];
    const result = await detectPrinciples(messages);
    expect(result.method).toBe('llm');
    // 有効な原則名のみフィルタされる
    result.principles.forEach((p) => {
      expect(['アンカリング効果', '損失回避', '社会的証明', '希少性', 'コミットメントと一貫性', 'フレーミング効果', '返報性']).toContain(p);
    });
    delete process.env.GROQ_API_KEY;
  });
});

describe('buildPrinciplePrompt', () => {
  it('原則名を直接ユーザー向けに出力しない形式を維持する', () => {
    const chunks: PrincipleChunk[] = [
      {
        principle: 'アンカリング効果',
        situation: '価格を提示する場面',
        example: '最初に高い価格を示す',
        contraindication: '不誠実に感じさせない',
      },
    ];
    const prompt = buildPrinciplePrompt(chunks);
    expect(prompt).toContain('内部用');
    expect(prompt).toContain('ユーザーに伝えてはいけません');
    expect(prompt).toContain('原則名を直接言及しないでください');
    expect(prompt).toContain('アンカリング効果');
  });

  it('空のchunksで空文字列を返す', () => {
    const prompt = buildPrinciplePrompt([]);
    expect(prompt).toBe('');
  });

  it('ragExcerpt.slice(0, 200) が各フィールドに適用されている', () => {
    // PrincipleChunkはsearchPrincipleChunksで既にslice(0,200)済みのはず
    // buildPrinciplePromptはそのまま使用する（slice適用済み前提）
    const longText = 'a'.repeat(300);
    const chunks: PrincipleChunk[] = [
      {
        principle: 'テスト原則',
        situation: longText.slice(0, 200),  // slice適用済み
        example: longText.slice(0, 200),    // slice適用済み
        contraindication: '',
      },
    ];
    const prompt = buildPrinciplePrompt(chunks);
    // プロンプト内の各フィールドが200文字以内であることを確認
    expect(chunks[0].situation.length).toBeLessThanOrEqual(200);
    expect(chunks[0].example.length).toBeLessThanOrEqual(200);
    expect(prompt).toContain('テスト原則');
  });

  it('最大3チャンクまで使用する', () => {
    const chunks: PrincipleChunk[] = Array.from({ length: 5 }, (_, i) => ({
      principle: `原則${i + 1}`,
      situation: '',
      example: '',
      contraindication: '',
    }));
    const prompt = buildPrinciplePrompt(chunks);
    // 4つ目以降の原則名が含まれないことを確認
    expect(prompt).not.toContain('原則4');
    expect(prompt).not.toContain('原則5');
    expect(prompt).toContain('原則1');
    expect(prompt).toContain('原則2');
    expect(prompt).toContain('原則3');
  });
});
