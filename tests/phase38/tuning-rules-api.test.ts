import request from 'supertest';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3100';
const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN ?? '';

const api = request(API_BASE);

function authHeaders(): Record<string, string> {
  return AUTH_TOKEN
    ? { Authorization: `Bearer ${AUTH_TOKEN}` }
    : { 'x-api-key': process.env.TEST_API_KEY ?? 'test-api-key' };
}

const fixture = {
  trigger_pattern: 'テスト,test-trigger',
  expected_behavior: 'テスト用の期待動作',
  priority: 50,
  is_active: true,
};

describe('GET /v1/admin/tuning-rules', () => {
  it('正常系: 配列を返す', async () => {
    const res = await api
      .get('/v1/admin/tuning-rules')
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data ?? res.body)).toBe(true);
  });

  it('認証なしで401', async () => {
    const res = await api.get('/v1/admin/tuning-rules');
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/admin/tuning-rules', () => {
  it('正常系: ルール作成', async () => {
    const res = await api
      .post('/v1/admin/tuning-rules')
      .set(authHeaders())
      .send(fixture);
    expect([200, 201]).toContain(res.status);
    const rule = res.body.data ?? res.body;
    expect(rule).toHaveProperty('id');
    expect(rule.trigger_pattern).toBe(fixture.trigger_pattern);
  });

  it('認証なしで401', async () => {
    const res = await api
      .post('/v1/admin/tuning-rules')
      .send(fixture);
    expect(res.status).toBe(401);
  });
});

describe('PUT /v1/admin/tuning-rules/:id', () => {
  it('正常系: ルール更新', async () => {
    // まず作成
    const createRes = await api
      .post('/v1/admin/tuning-rules')
      .set(authHeaders())
      .send(fixture);
    if (createRes.status !== 200 && createRes.status !== 201) return;

    const id = (createRes.body.data ?? createRes.body).id;
    const res = await api
      .put(`/v1/admin/tuning-rules/${id}`)
      .set(authHeaders())
      .send({ ...fixture, expected_behavior: '更新後の期待動作' });
    expect([200, 204]).toContain(res.status);
  });
});

describe('DELETE /v1/admin/tuning-rules/:id', () => {
  it('正常系: ルール削除', async () => {
    const createRes = await api
      .post('/v1/admin/tuning-rules')
      .set(authHeaders())
      .send(fixture);
    if (createRes.status !== 200 && createRes.status !== 201) return;

    const id = (createRes.body.data ?? createRes.body).id;
    const res = await api
      .delete(`/v1/admin/tuning-rules/${id}`)
      .set(authHeaders());
    expect([200, 204]).toContain(res.status);
  });
});
