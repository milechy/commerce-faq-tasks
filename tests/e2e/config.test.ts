// tests/e2e/config.test.ts

import {
  resolveE2eBaseUrls,
  ADMIN_BASE_URL,
  API_BASE_URL,
  DEMO_BASE_URL,
  DEMO_INDEX_URL,
} from './config';

const PROD = { adminBaseUrl: 'https://admin.r2c.biz', apiBaseUrl: 'https://api.r2c.biz' };

describe('resolveE2eBaseUrls — 正常系', () => {
  it('env未設定 → 本番URLがデフォルトになる', () => {
    expect(resolveE2eBaseUrls({})).toEqual(PROD);
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

  it('管理画面とAPIが同一ホストでも許容される(単一ホスト構成のステージング)', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'https://staging.example.com',
        E2E_API_URL: 'https://staging.example.com',
      }),
    ).toEqual({
      adminBaseUrl: 'https://staging.example.com',
      apiBaseUrl: 'https://staging.example.com',
    });
  });

  it('http(ローカル/自前ステージング)も許容される — https限定にしない', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'http://localhost:5173',
        E2E_API_URL: 'http://localhost:3100',
      }),
    ).toEqual({
      adminBaseUrl: 'http://localhost:5173',
      apiBaseUrl: 'http://localhost:3100',
    });
  });

  it('パス付きのbase URL(サブパス配信)でもパスが保持される', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'https://example.com/admin-app',
        E2E_API_URL: 'https://example.com/api',
      }).apiBaseUrl,
    ).toBe('https://example.com/api');
  });

  it('大文字スキーム(HTTPS://)も受け付ける', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'HTTPS://staging-admin.example.com',
        E2E_API_URL: 'HTTPS://staging-api.example.com',
      }).adminBaseUrl,
    ).toBe('HTTPS://staging-admin.example.com');
  });
});

describe('resolveE2eBaseUrls — 片側のみ設定(向き先の食い違い防止)', () => {
  it('E2E_BASE_URL のみ設定 → 欠けている側の変数名を含めて throw する', () => {
    expect(() => resolveE2eBaseUrls({ E2E_BASE_URL: 'https://staging-admin.example.com' })).toThrow(
      /E2E_API_URL/,
    );
  });

  it('E2E_API_URL のみ設定 → 欠けている側の変数名を含めて throw する', () => {
    expect(() => resolveE2eBaseUrls({ E2E_API_URL: 'https://staging-api.example.com' })).toThrow(
      /E2E_BASE_URL/,
    );
  });

  // 「片方を空文字にすれば無効化できる」と誤解した操作。空文字は未設定と同義に倒れるため
  // 「もう片方だけ設定された」状態になり、本番混在ではなく throw で止まる必要がある。
  it('片方が空文字・もう片方が実URL → 未設定扱いになり throw する(本番と混在させない)', () => {
    expect(() =>
      resolveE2eBaseUrls({ E2E_BASE_URL: '', E2E_API_URL: 'https://staging-api.example.com' }),
    ).toThrow(/E2E_BASE_URL/);
  });

  // 空白のみの値は「見た目は設定済み・実質未設定」。trim しないと truthy のまま通過し、
  // 片側ガードもすり抜けて adminBaseUrl='   ' のまま全specへ配られてしまう。
  it('片方が空白のみ・もう片方が実URL → 空白は未設定扱いになり throw する', () => {
    expect(() =>
      resolveE2eBaseUrls({ E2E_BASE_URL: '   ', E2E_API_URL: 'https://staging-api.example.com' }),
    ).toThrow(/E2E_BASE_URL/);
  });

  it('両方とも空白のみ → 両方未設定扱いで本番にフォールバックする(throwしない)', () => {
    expect(resolveE2eBaseUrls({ E2E_BASE_URL: '  ', E2E_API_URL: '\n' })).toEqual(PROD);
  });

  it('両方未設定は正常系(throwしない)', () => {
    expect(() => resolveE2eBaseUrls({})).not.toThrow();
  });
});

describe('resolveE2eBaseUrls — 値の正規化', () => {
  it('空文字列は本番にフォールバックする', () => {
    expect(resolveE2eBaseUrls({ E2E_BASE_URL: '', E2E_API_URL: '' })).toEqual(PROD);
  });

  // CI Secrets / .env は末尾に改行が混入しやすい。trim しないと
  // `https://example.com\n/health` のような一見正しく見えるURLになる。
  it.each([
    ['末尾改行', 'https://staging-admin.example.com\n', 'https://staging-api.example.com\n'],
    ['末尾スペース', 'https://staging-admin.example.com ', 'https://staging-api.example.com '],
    ['前後スペース', '  https://staging-admin.example.com  ', '  https://staging-api.example.com  '],
    ['タブ+CRLF', '\thttps://staging-admin.example.com\r\n', '\thttps://staging-api.example.com\r\n'],
  ])('%s は trim される', (_label, admin, api) => {
    expect(resolveE2eBaseUrls({ E2E_BASE_URL: admin, E2E_API_URL: api })).toEqual({
      adminBaseUrl: 'https://staging-admin.example.com',
      apiBaseUrl: 'https://staging-api.example.com',
    });
  });

  it('末尾スラッシュが1つでも複数でも除去される', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'https://staging-admin.example.com/',
        E2E_API_URL: 'https://staging-api.example.com///',
      }),
    ).toEqual({
      adminBaseUrl: 'https://staging-admin.example.com',
      apiBaseUrl: 'https://staging-api.example.com',
    });
  });

  it('末尾スラッシュとその後ろの空白が併存しても両方除去される', () => {
    expect(
      resolveE2eBaseUrls({
        E2E_BASE_URL: 'https://staging-admin.example.com/ ',
        E2E_API_URL: 'https://staging-api.example.com/ ',
      }).adminBaseUrl,
    ).toBe('https://staging-admin.example.com');
  });

  // これが破れると DEMO_BASE_URL の合成で `//carnation-demo` が生まれる。
  // 個別ケースではなく不変条件として押さえる。
  it.each([
    'https://a.example.com',
    'https://a.example.com/',
    'https://a.example.com///',
    'https://a.example.com/sub/',
    'https://a.example.com/sub  ',
  ])('戻り値は末尾スラッシュを持たない: %s', (input) => {
    const { adminBaseUrl, apiBaseUrl } = resolveE2eBaseUrls({
      E2E_BASE_URL: input,
      E2E_API_URL: input,
    });
    expect(adminBaseUrl.endsWith('/')).toBe(false);
    expect(apiBaseUrl.endsWith('/')).toBe(false);
  });
});

describe('resolveE2eBaseUrls — URLとして壊れた値の早期検出', () => {
  // 検証が無いと、これらが黙って103テスト全部に配られ「向き先が壊れている」と
  // 気付けないまま原因不明の失敗が並ぶ。
  it.each([
    ['スラッシュのみ', '/'],
    ['スキーム無し', 'not-a-url'],
    ['ホスト名なし', 'https://'],
    ['対応外スキーム', 'ftp://example.com'],
    ['相対パス', '/admin'],
    ['スキームのtypo', 'htps://example.com'],
  ])('%s は throw する', (_label, bad) => {
    expect(() => resolveE2eBaseUrls({ E2E_BASE_URL: bad, E2E_API_URL: bad })).toThrow(/URL/);
  });

  it('壊れているのがAPI側だけでも、どちらの変数かを名指しして throw する', () => {
    expect(() =>
      resolveE2eBaseUrls({ E2E_BASE_URL: 'https://ok.example.com', E2E_API_URL: 'not-a-url' }),
    ).toThrow(/E2E_API_URL/);
  });

  it('壊れているのが管理画面側だけでも、どちらの変数かを名指しして throw する', () => {
    expect(() =>
      resolveE2eBaseUrls({ E2E_BASE_URL: 'not-a-url', E2E_API_URL: 'https://ok.example.com' }),
    ).toThrow(/E2E_BASE_URL/);
  });

  it('エラーメッセージに実際の解決値が含まれる(原因特定を早めるため)', () => {
    expect(() =>
      resolveE2eBaseUrls({ E2E_BASE_URL: 'not-a-url', E2E_API_URL: 'https://ok.example.com' }),
    ).toThrow(/not-a-url/);
  });
});

describe('ADMIN_BASE_URL / API_BASE_URL', () => {
  it('本番URLの文字列としてexportされている(export名の消失検知)', () => {
    expect(ADMIN_BASE_URL).toMatch(/^https:\/\//);
    expect(API_BASE_URL).toMatch(/^https:\/\//);
  });

  it('末尾スラッシュを持たない(パス連結で // を作らない)', () => {
    expect(ADMIN_BASE_URL.endsWith('/')).toBe(false);
    expect(API_BASE_URL.endsWith('/')).toBe(false);
  });
});

describe('DEMO_BASE_URL / DEMO_INDEX_URL', () => {
  it('DEMO_BASE_URL が API_BASE_URL + "/carnation-demo" になる', () => {
    expect(DEMO_BASE_URL).toBe(`${API_BASE_URL}/carnation-demo`);
  });

  it('DEMO_INDEX_URL が DEMO_BASE_URL + "/index.html" になる', () => {
    expect(DEMO_INDEX_URL).toBe(`${DEMO_BASE_URL}/index.html`);
  });

  it('パス部分に二重スラッシュを含まない', () => {
    const path = DEMO_INDEX_URL.replace(/^https?:\/\//i, '');
    expect(path).not.toContain('//');
  });

  // spec側は DEMO_BASE_URL に対して `${DEMO_BASE}/inquiry.html` のように
  // 先頭スラッシュ付きで連結する。ここが末尾スラッシュを持つと `//inquiry.html` になる。
  it('DEMO_BASE_URL は末尾スラッシュを持たない(spec側の連結規約)', () => {
    expect(DEMO_BASE_URL.endsWith('/')).toBe(false);
  });
});
