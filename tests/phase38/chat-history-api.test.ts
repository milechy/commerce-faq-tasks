import request from 'supertest';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3100';
const AUTH_TOKEN = process.env.TEST_AUTH_TOKEN ?? '';
const _TENANT_ID = process.env.TEST_TENANT_ID ?? 'demo-tenant';

const api = request(API_BASE);

function authHeaders(): Record<string, string> {
  return AUTH_TOKEN
    ? { Authorization: `Bearer ${AUTH_TOKEN}` }
    : { 'x-api-key': process.env.TEST_API_KEY ?? 'test-api-key' };
}

describe('GET /v1/admin/chat-history/sessions', () => {
  it('正常系: 配列を返す', async () => {
    const res = await api
      .get('/v1/admin/chat-history/sessions')
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data ?? res.body)).toBe(true);
  });

  it('各セッションに必要フィールドが含まれる', async () => {
    const res = await api
      .get('/v1/admin/chat-history/sessions')
      .set(authHeaders());
    const sessions: any[] = res.body.data ?? res.body;
    if (sessions.length > 0) {
      const s = sessions[0];
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('tenant_id');
      expect(s).toHaveProperty('created_at');
    }
  });

  it('認証なしで401', async () => {
    const res = await api.get('/v1/admin/chat-history/sessions');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/admin/chat-history/sessions/:sessionId/messages', () => {
  const dummySessionId = 'test-session-id-00000000';

  it('正常系: 配列を返す', async () => {
    const res = await api
      .get(`/v1/admin/chat-history/sessions/${dummySessionId}/messages`)
      .set(authHeaders());
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.data ?? res.body)).toBe(true);
    }
  });

  it('各メッセージに必要フィールドが含まれる', async () => {
    const res = await api
      .get(`/v1/admin/chat-history/sessions/${dummySessionId}/messages`)
      .set(authHeaders());
    if (res.status === 200) {
      const messages: any[] = res.body.data ?? res.body;
      if (messages.length > 0) {
        const m = messages[0];
        expect(m).toHaveProperty('id');
        expect(m).toHaveProperty('role');
        expect(m).toHaveProperty('content');
        expect(m).toHaveProperty('created_at');
      }
    }
  });

  it('認証なしで401', async () => {
    const res = await api.get(
      `/v1/admin/chat-history/sessions/${dummySessionId}/messages`,
    );
    expect(res.status).toBe(401);
  });
});
