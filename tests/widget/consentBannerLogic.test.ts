// tests/widget/consentBannerLogic.test.ts
// S5a: 消費者向けデータ共有開示バナーの表示判定ロジック。
//
// 方針: 他の tests/widget/*.test.ts と同じく、実際の widget.js を eval せず
// 同一ロジックを抽出して検証する。実ファイル側との乖離は
// tests/widget/widgetSourceInvariants.test.ts が正規表現で機械的に検知する。
//
// このバナーは「会話とページ閲覧情報が外部の分析パートナー(Hermes VPS)へ渡る」
// ことを消費者に知らせる唯一の面であり、出るべきときに出ないことが
// そのまま開示漏れになる。したがって「出す/出さない」の境界を厚く固定する。

/** widget.js: function hasConsentAck() と consentAckKey() の抽出 */
function makeConsentAck(opts: {
  tenantId: string | null | undefined;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}) {
  function consentAckKey(): string {
    return 'r2c_consent_ack_' + (opts.tenantId || 'unknown');
  }
  function hasConsentAck(): boolean {
    try {
      if (!opts.storage) throw new Error('storage unavailable');
      return opts.storage.getItem(consentAckKey()) === '1';
    } catch {
      return false;
    }
  }
  function recordConsentAck(): void {
    try {
      if (!opts.storage) throw new Error('storage unavailable');
      opts.storage.setItem(consentAckKey(), '1');
    } catch {
      /* ストレージ不可でも表示だけは閉じる(呼び出し側の責務) */
    }
  }
  return { consentAckKey, hasConsentAck, recordConsentAck };
}

/** widget.js: if (cfg.data_shared_externally && !hasConsentAck()) の抽出 */
function shouldShowConsentBanner(cfg: unknown, alreadyAcked: boolean): boolean {
  const c = cfg as { data_shared_externally?: unknown } | null | undefined;
  return Boolean(c && c.data_shared_externally) && !alreadyAcked;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    getItem: (k: string) => (k in store ? store[k]! : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    _dump: () => store,
  };
}

describe('S5a 開示バナー — 表示判定(正常系)', () => {
  it('share=true かつ 未同意 → 表示する', () => {
    expect(shouldShowConsentBanner({ data_shared_externally: true }, false)).toBe(true);
  });

  it('share=true かつ 同意済み → 表示しない(再訪問で毎回出さない)', () => {
    expect(shouldShowConsentBanner({ data_shared_externally: true }, true)).toBe(false);
  });

  it('share=false → 未同意でも表示しない(共有していないのに開示文を出さない)', () => {
    expect(shouldShowConsentBanner({ data_shared_externally: false }, false)).toBe(false);
  });
});

describe('S5a 開示バナー — 境界値・異常系', () => {
  it('data_shared_externally が欠落した応答では表示しない(古いサーバ/失敗フォールバック)', () => {
    expect(shouldShowConsentBanner({ event_tracking: false }, false)).toBe(false);
  });

  it('cfg が null/undefined でも例外を投げず表示しない', () => {
    expect(() => shouldShowConsentBanner(null, false)).not.toThrow();
    expect(shouldShowConsentBanner(null, false)).toBe(false);
    expect(shouldShowConsentBanner(undefined, false)).toBe(false);
  });

  it('文字列 "false" は truthy なので表示される(サーバがJSON boolean以外を返してはいけない契約の明示)', () => {
    // これは「望ましい挙動」ではなく現状の契約を可視化するテスト。
    // サーバ(src/index.ts)は必ず boolean を返すため、ここが問題になるのは
    // 応答形式を崩したときだけ。崩したことに気付けるようにしておく。
    expect(shouldShowConsentBanner({ data_shared_externally: 'false' }, false)).toBe(true);
  });

  it('数値0・空文字は falsy として表示しない', () => {
    expect(shouldShowConsentBanner({ data_shared_externally: 0 }, false)).toBe(false);
    expect(shouldShowConsentBanner({ data_shared_externally: '' }, false)).toBe(false);
  });
});

describe('S5a 開示バナー — 同意状態の永続化', () => {
  it('同意キーはテナントごとに分かれる(別テナントの同意を引き継がない)', () => {
    const storage = memoryStorage();
    const a = makeConsentAck({ tenantId: 'tenant-a', storage });
    const b = makeConsentAck({ tenantId: 'tenant-b', storage });

    a.recordConsentAck();

    expect(a.hasConsentAck()).toBe(true);
    expect(b.hasConsentAck()).toBe(false);
  });

  it('tenantId 未設定のウィジェットは unknown キーに集約される(キー衝突の可視化)', () => {
    const storage = memoryStorage();
    const w = makeConsentAck({ tenantId: '', storage });
    expect(w.consentAckKey()).toBe('r2c_consent_ack_unknown');
    w.recordConsentAck();
    expect(storage._dump()['r2c_consent_ack_unknown']).toBe('1');
  });

  it('localStorage が使えない環境(プライベートブラウズ等)でも例外を投げない', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    const w = makeConsentAck({ tenantId: 'tenant-a', storage: throwing });

    expect(() => w.hasConsentAck()).not.toThrow();
    expect(() => w.recordConsentAck()).not.toThrow();
  });

  it('localStorage が使えないときは「未同意」に倒れる(=開示を出す側。黙って隠さない)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => undefined,
    };
    const w = makeConsentAck({ tenantId: 'tenant-a', storage: throwing });

    expect(w.hasConsentAck()).toBe(false);
    expect(shouldShowConsentBanner({ data_shared_externally: true }, w.hasConsentAck())).toBe(true);
  });

  it('保存値が "1" 以外(改ざん・別バージョンの値)なら未同意として扱う', () => {
    const storage = memoryStorage({ 'r2c_consent_ack_tenant-a': 'true' });
    const w = makeConsentAck({ tenantId: 'tenant-a', storage });
    expect(w.hasConsentAck()).toBe(false);
  });
});

describe('S5a 開示バナー — 既知の残存リスク(意図的に現状を固定する)', () => {
  // /api/widget/features の取得に失敗すると cfg に data_shared_externally が
  // 含まれず、share=true のテナントでもバナーが出ない。一方でチャット自体は
  // 別 fetch (/api/chat) で成立し、export はサーバ側のフラグで進むため、
  // 「開示なしで会話が共有される」状態が起こりうる(fail-open)。
  //
  // バナーを fail-safe 側(出す)に倒すと、共有していないテナントの利用者にまで
  // 誤った開示文を見せることになるため、単純な反転では解決しない。
  // ここでは「事故ではなく既知の状態」として固定し、方針が決まったら
  // このテストごと書き換える。
  it('features取得が失敗した形(event_trackingのみのフォールバック)では表示されない', () => {
    const failFallback = { event_tracking: false };
    expect(shouldShowConsentBanner(failFallback, false)).toBe(false);
  });

  it('ネットワーク例外時に cfg 自体が渡らない場合も表示されない', () => {
    expect(shouldShowConsentBanner(undefined, false)).toBe(false);
  });
});
