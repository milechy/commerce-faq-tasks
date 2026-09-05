// src/api/admin/agent/actionExecutorResources.test.ts
//
// 資料オファー(docs/RESOURCE_OFFER_REQUIREMENTS.md)の get_resource/upload_resource/
// delete_resource を executeToolCall 経由で検証する。SQL自体の正しさは
// resourcesRepository.test.ts が既に見ているため、ここでは配線側の関心事に絞る:
//   1. get_resource は未登録時も exists:false のカードを返す(禁止15: 動線が閉じない)
//   2. upload_resource の著作権確認(rights_confirmed)・登録確認(confirmed)の
//      ハードゲートがモデルの自己申告だけで突破できないこと
//   3. upload_resource が SSRF ガード(isValidExternalResourceUrl)を通していること
//   4. delete_resource の confirmed ゲートと「不存在」の扱い

jest.mock('../../../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Pool } from 'pg';
import { executeToolCall, type ActionResult, type ActionCardPayload } from './actionExecutor';

const TENANT = 'acme';
const ACTOR = { role: 'owner', email: 'owner@example.com' };

function makeMockPool(...responses: Array<{ rows?: unknown[]; rowCount?: number }>): Pool {
  const query = jest.fn();
  for (const r of responses) {
    query.mockResolvedValueOnce({ rows: r.rows ?? [], rowCount: r.rowCount ?? (r.rows?.length ?? 0) });
  }
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  return { query } as unknown as Pool;
}

function resultText(result: ActionResult): string {
  return typeof result === 'string' ? result : result.text;
}

function resultCard(result: ActionResult): ActionCardPayload | undefined {
  return typeof result === 'string' ? undefined : result.card;
}

const EXISTING_RESOURCE_ROW = {
  id: 'res-1',
  tenant_id: TENANT,
  title: '既存資料',
  description: null,
  storage_path: null,
  external_url: 'https://example.com/whitepaper.pdf',
  file_type: 'external_url',
  moderation_status: 'approved',
  moderation_reason: null,
  rights_confirmed: true,
  is_published: false,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

describe('executeToolCall: get_resource', () => {
  it('未登録テナントでも exists:false のカードを返す(動線を閉じない)', async () => {
    const pool = makeMockPool({ rows: [] });

    const result = await executeToolCall('get_resource', {}, TENANT, pool, 'session-1', false, ACTOR);

    const card = resultCard(result);
    expect(card?.kind).toBe('resource');
    expect(card).toMatchObject({ kind: 'resource', exists: false, id: null });
  });

  it('登録済みなら現在の状態をカードで返す', async () => {
    const pool = makeMockPool({ rows: [EXISTING_RESOURCE_ROW] });

    const result = await executeToolCall('get_resource', {}, TENANT, pool, 'session-1', false, ACTOR);

    const card = resultCard(result);
    expect(card).toMatchObject({
      kind: 'resource',
      exists: true,
      id: 'res-1',
      title: '既存資料',
      fileType: 'external_url',
      moderationStatus: 'approved',
      isPublished: false,
    });
  });
});

describe('executeToolCall: upload_resource のハードゲート', () => {
  it('rights_confirmed が無いと登録せず日本語で断る', async () => {
    const pool = makeMockPool();

    const result = await executeToolCall(
      'upload_resource',
      { title: '資料', external_url: 'https://example.com/a.pdf', confirmed: true },
      TENANT,
      pool,
      'session-1',
      false,
      ACTOR,
    );

    expect(pool.query).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('著作権');
  });

  it('confirmed が無いと登録しない(rights_confirmed=trueだけでは実行されない)', async () => {
    const pool = makeMockPool();

    const result = await executeToolCall(
      'upload_resource',
      { title: '資料', external_url: 'https://example.com/a.pdf', rights_confirmed: true },
      TENANT,
      pool,
      'session-1',
      false,
      ACTOR,
    );

    expect(pool.query).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('確認が必要');
  });

  it.each(['http://localhost/a.pdf', 'http://127.0.0.1/a.pdf', 'http://192.168.1.1/a.pdf', 'ftp://example.com/a.pdf'])(
    '%s のような内部・非http(s)アドレスはSSRFガードで拒否する',
    async (externalUrl) => {
      const pool = makeMockPool();

      const result = await executeToolCall(
        'upload_resource',
        { title: '資料', external_url: externalUrl, rights_confirmed: true, confirmed: true },
        TENANT,
        pool,
        'session-1',
        false,
        ACTOR,
      );

      expect(pool.query).not.toHaveBeenCalled();
      expect(resultText(result)).toContain('URL');
    },
  );

  it('全ゲートを満たすと登録し、is_published=falseのままカードを返す', async () => {
    const pool = makeMockPool(
      { rows: [] }, // getResource(既存なし)
      { rows: [{ ...EXISTING_RESOURCE_ROW, id: 'new-id', title: '新しい資料', moderation_status: 'pending', is_published: false }] }, // upsertResource
    );

    const result = await executeToolCall(
      'upload_resource',
      { title: '新しい資料', external_url: 'https://example.com/new.pdf', rights_confirmed: true, confirmed: true },
      TENANT,
      pool,
      'session-1',
      false,
      ACTOR,
    );

    expect(pool.query).toHaveBeenCalledTimes(2);
    const [insertSql] = (pool.query as jest.Mock).mock.calls[1]!;
    expect(String(insertSql)).toMatch(/INSERT INTO tenant_resources/);
    const card = resultCard(result);
    expect(card).toMatchObject({ kind: 'resource', exists: true, isPublished: false, title: '新しい資料' });
  });
});

describe('executeToolCall: delete_resource', () => {
  it('confirmed=false では削除しない', async () => {
    const pool = makeMockPool();

    const result = await executeToolCall('delete_resource', {}, TENANT, pool, 'session-1', false, ACTOR);

    expect(pool.query).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('確認が必要');
  });

  it('資料が無いテナントでは「見つかりません」を返す(誤って成功と言わない)', async () => {
    const pool = makeMockPool({ rows: [], rowCount: 0 });

    const result = await executeToolCall('delete_resource', { confirmed: true }, TENANT, pool, 'session-1', false, ACTOR);

    expect(resultText(result)).toContain('見つかりません');
  });

  it('confirmed=true かつ資料が存在すれば削除する', async () => {
    const pool = makeMockPool({ rows: [], rowCount: 1 });

    const result = await executeToolCall('delete_resource', { confirmed: true }, TENANT, pool, 'session-1', false, ACTOR);

    expect(String((pool.query as jest.Mock).mock.calls[0]![0])).toMatch(/DELETE FROM tenant_resources/);
    expect(resultText(result)).toContain('削除しました');
  });
});
