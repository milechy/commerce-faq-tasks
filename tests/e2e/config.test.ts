// tests/e2e/config.test.ts

import { resolveE2eBaseUrls, ADMIN_BASE_URL, API_BASE_URL, DEMO_BASE_URL, DEMO_INDEX_URL } from './config';

describe('resolveE2eBaseUrls', () => {
  it('env未設定 → 本番URLがデフォルトになる', () => {
    expect(resolveE2eBaseUrls({})).toEqual({
      adminBaseUrl: 'https://admin.r2c.biz',
      apiBaseUrl: 'https://api.r2c.biz',
    });
  });

  it('両方設定時 → 両方とも上書きされる', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'https://staging-admin.example.com',
        E2E_API_URL: 'https://staging-api.example.com',
      }),
    ).toEqual({
      adminBaseUrl: 'https://staging-admin.example.com',
      apiBaseUrl: 'https://staging-api.example.com',
    });
  });

  it('E2E_BASE_URL のみ設定 → throw する', () => {
    expect(() => resolveE2eBaseUrls({ E2E_BASE_URL: 'https://staging-admin.example.com' })).toThrow(
      /E2E_API_URL/,
    );
  });

  it('E2E_API_URL のみ設定 → throw する', () => {
    expect(() => resolveE2eBaseUrls({ E2E_API_URL: 'https://staging-api.example.com' })).toThrow(
      /E2E_BASE_URL/,
    );
  });

  it('末尾スラッシュ付き(E2E_BASE_URL)が正規化される', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'https://staging-admin.example.com/',
        E2E_API_URL: 'https://staging-api.example.com',
      }).adminBaseUrl,
    ).toBe('https://staging-admin.example.com');
  });

  it('末尾スラッシュ付き(E2E_API_URL)が正規化される', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'https://staging-admin.example.com',
        E2E_API_URL: 'https://staging-api.example.com/',
      }).apiBaseUrl,
    ).toBe('https://staging-api.example.com');
  });

  it('空文字列は本番にフォールバックする', () => {
    expect(resolveE2eBaseUrls({ E2E_BASE_URL: '', E2E_API_URL: '' })).toEqual({
      adminBaseUrl: 'https://admin.r2c.biz',
      apiBaseUrl: 'https://api.r2c.biz',
    });
  });
});

describe('ADMIN_BASE_URL / API_BASE_URL', () => {
  it('本番URLの文字列としてexportされている(export名の消失検知)', () => {
    expect(ADMIN_BASE_URL).toMatch(/^https:\/\//);
    expect(API_BASE_URL).toMatch(/^https:\/\//);
  });
});

describe('DEMO_BASE_URL / DEMO_INDEX_URL', () => {
  it('DEMO_BASE_URL が API_BASE_URL + "/carnation-demo" になる', () => {
    expect(DEMO_BASE_URL).toBe(`${API_BASE_URL}/carnation-demo`);
  });

  it('DEMO_INDEX_URL が DEMO_BASE_URL + "/index.html" になる', () => {
    expect(DEMO_INDEX_URL).toBe(`${DEMO_BASE_URL}/index.html`);
  });

  it('末尾スラッシュ付きのAPI_BASE_URLでも // が混入しない(合成後のパス部分に二重スラッシュが無い)', () => {
    const path = DEMO_INDEX_URL.replace(/^https?:\/\//, '');
    expect(path).not.toContain('//');
  });
});
