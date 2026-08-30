// src/api/admin/knowledge-gaps/suggestAnswerTenantId.test.ts
//
// GID 1217808323836843: POST /v1/admin/knowledge-gaps/:id/suggest-answer は
// gap.tenant_id をスコープに持ちながら callGeminiJudge への引き渡しを忘れており、
// trackUsage が tenant_id='unknown' で計上され続けていた。再発防止テスト。

jest.mock('../../../admin/http/supabaseAuthMiddleware', () => ({
  supabaseAuthMiddleware: (req: any, _res: any, next: any) => {
    req.supabaseUser = req._mockUser ?? null;
    next();
  },
}));

const mockQuery = jest.fn();
jest.mock('../../../lib/db', () => ({
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../../../lib/gemini/client', () => ({
  callGeminiJudge: jest.fn(),
}));

import express from 'express';
import { request } from "../../../../tests/helpers/testServer";
import { registerKnowledgeGapPhase46Routes } from './routes';
import { callGeminiJudge } from '../../../lib/gemini/client';

const mockCallGeminiJudge = callGeminiJudge as jest.MockedFunction<typeof callGeminiJudge>;

function makeApp(user: Record<string, unknown> | null) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req._mockUser = user;
    next();
  });
  registerKnowledgeGapPhase46Routes(app);
  return app;
}

const SUPER_ADMIN = { app_metadata: { role: 'super_admin' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockCallGeminiJudge.mockResolvedValue('回答案です');
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM knowledge_gaps')) {
      return Promise.resolve({
        rows: [{ id: 7, tenant_id: 'carnation', user_question: '営業時間は？', frequency: 3 }],
      });
    }
    if (sql.includes('FROM tenants')) {
      return Promise.resolve({ rows: [{ system_prompt: null }] });
    }
    if (sql.includes('FROM faq_docs')) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
});

describe('POST /v1/admin/knowledge-gaps/:id/suggest-answer', () => {
  it('callGeminiJudge に gap.tenant_id を渡す（tenant_id="unknown" 計上を防ぐ）', async () => {
    const app = makeApp(SUPER_ADMIN);

    const res = await request(app).post('/v1/admin/knowledge-gaps/7/suggest-answer').send({});

    expect(res.status).toBe(200);
    expect(mockCallGeminiJudge).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tenantId: 'carnation', billable: false }),
    );
  });
});
