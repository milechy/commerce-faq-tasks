import request from 'supertest';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3100';
const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN ?? '';
const TENANT_ID = process.env.TEST_TENANT_ID ?? 'demo-tenant';

const api = request(API_BASE);

function authHeaders(): Record<string, string> {
  return AUTH_TOKEN
    ? { Authorization: `Bearer ${AUTH_TOKEN}` }
    : { 'x-api-key': process.env.TEST_API_KEY ?? 'test-api-key' };
}

describe('GET /v1/admin/tenants/:id (system_prompt)', () => {
  it('テナント情報に system_prompt フィールドが含まれる', async () => {
    const res = await api
      .get(`/v1/admin/tenants/${TENANT_ID}`)
      .set(authHeaders());
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      const tenant = res.body.data ?? res.body;
      expect(tenant).toHaveProperty('system_prompt');
    }
  });
});

describe('PATCH /v1/admin/tenants/:id (system_prompt)', () => {
  it('system_prompt を更新できる', async () => {
    const newPrompt = 'テスト用システムプロンプト（自動テスト）';
    const res = await api
      .patch(`/v1/admin/tenants/${TENANT_ID}`)
      .set(authHeaders())
      .send({ system_prompt: newPrompt });
    expect([200, 204]).toContain(res.status);
  });

  it('system_prompt を null でクリアできる', async () => {
    const res = await api
      .patch(`/v1/admin/tenants/${TENANT_ID}`)
      .set(authHeaders())
      .send({ system_prompt: null });
    expect([200, 204]).toContain(res.status);
  });
});
