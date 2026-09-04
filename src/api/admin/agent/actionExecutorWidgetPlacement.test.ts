// src/api/admin/agent/actionExecutorWidgetPlacement.test.ts
//
// GID 1218167291123548 (L3-1b) テスト強化。widgetPlacement.test.ts は
// validateWidgetPlacement/buildPlacementAttributes 等の純関数だけを見るのに対し、
// ここでは executeToolCall 経由の配線側の関心事を見る:
//   1. get_widget_placement が本当に読み取り専用か(db.query が SELECT 以外を
//      一切発行しないこと) — 将来の careless な編集で書き込みが混入する回帰を検出する。
//   2. set_widget_theme が境界外の値(フロントのスライダーが本来防ぐはずの値)を
//      ハンドラのレベルで確実に弾き、DBへ書き込ませないこと
//      (フロントが唯一の防波堤ではないことの固定)。
//
// admin-ui 側の __real: 文字列構築(スライダーの値をそのまま埋め込む処理)自体は
// LLM がその文字列をどう解釈して set_widget_theme を呼ぶかに依存しており、
// このテストの対象外(index.test.tsx 側でフロントの文字列構築のみを検証する)。

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Pool } from 'pg';
import { executeToolCall, type ActionResult } from './actionExecutor';

const TENANT = 'acme';
const ACTOR = { role: 'owner', email: 'owner@example.com' };

function makeMockPool(rows: unknown[] = []): Pool {
  return { query: jest.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

function resultText(result: ActionResult): string {
  return typeof result === 'string' ? result : result.text;
}

describe('executeToolCall: get_widget_placement は読み取り専用', () => {
  it('SELECTのみを発行し、UPDATE/INSERT/DELETEを一切呼ばない', async () => {
    const pool = makeMockPool([{ widget_theme: { position: 'bottom-left', offsetX: 10, offsetY: 96 } }]);

    await executeToolCall('get_widget_placement', {}, TENANT, pool, 'session-1', false, ACTOR);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql] = (pool.query as jest.Mock).mock.calls[0]!;
    expect(String(sql)).toMatch(/^\s*SELECT\b/i);
    expect(String(sql)).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });

  it('position/offsetX/offsetY/confirmed 等の書き込み系引数を混ぜても widget_theme を書き換えない', () => {
    return (async () => {
      const pool = makeMockPool([{ widget_theme: null }]);

      await executeToolCall(
        'get_widget_placement',
        { position: 'bottom-left', offsetX: 999, offsetY: -1, confirmed: true, theme: { position: 'bottom-left' } },
        TENANT,
        pool,
        'session-1',
        false,
        ACTOR,
      );

      // 引数が何であれ、get_widget_placement のハンドラは常に1回のSELECTしか出さない
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(String((pool.query as jest.Mock).mock.calls[0]![0])).toMatch(/^\s*SELECT\b/i);
    })();
  });
});

describe('executeToolCall: set_widget_theme はフロントを迂回した不正値を弾く(最後の砦)', () => {
  it.each([
    [{ offsetY: 321 }, 'offsetY'],
    [{ offsetY: -1 }, 'offsetY'],
    [{ position: 'top-left' }, 'position'],
  ])('%o はDBへ書き込まず日本語エラーを返す', async (theme, expectedKeyword) => {
    const pool = makeMockPool();

    const result = await executeToolCall('set_widget_theme', { theme }, TENANT, pool, 'session-1', false, ACTOR);

    expect(pool.query).not.toHaveBeenCalled();
    expect(resultText(result)).toContain(expectedKeyword);
  });

  it('offsetX/offsetY が0(falsy)でも正常値として通し、そのままUPDATEに渡す', async () => {
    const pool = makeMockPool();

    const result = await executeToolCall(
      'set_widget_theme',
      { theme: { position: 'bottom-left', offsetX: 0, offsetY: 0 } },
      TENANT,
      pool,
      'session-1',
      false,
      ACTOR,
    );

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (pool.query as jest.Mock).mock.calls[0]!;
    expect(String(sql)).toMatch(/UPDATE tenants SET widget_theme/);
    expect(JSON.parse((params as unknown[])[0] as string)).toEqual({ position: 'bottom-left', offsetX: 0, offsetY: 0 });
    expect(resultText(result)).toContain('更新しました');
  });
});
