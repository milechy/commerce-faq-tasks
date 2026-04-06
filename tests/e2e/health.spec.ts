import { test, expect } from '@playwright/test';

const E2E_ENABLED = process.env.E2E_ENABLED === '1' || !!process.env.CI;

test.describe('API Health Check', () => {
  test.skip(!E2E_ENABLED, 'E2E tests require E2E_ENABLED=1 or CI=true');

  test('GET /health returns 200 with status ok', async ({ request }) => {
    const response = await request.get('https://api.r2c.biz/health');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });

  test('GET /widget.js returns 200 with JavaScript content-type', async ({ request }) => {
    const response = await request.get('https://api.r2c.biz/widget.js');
    expect(response.status()).toBe(200);
    const contentType = response.headers()['content-type'] ?? '';
    expect(contentType).toMatch(/javascript/);
  });
});
