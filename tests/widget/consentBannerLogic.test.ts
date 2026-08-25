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

describe('S5a 開示バナー — /api/widget/features 単体では埋まらない残存リスク', () => {
  // /api/widget/features の取得に失敗すると cfg に data_shared_externally が
  // 含まれず、この応答単体では share=true のテナントでもバナーが出せない。
  // S6でこの経路自体は /api/chat 応答をバックストップとして使う形で塞いだ
  // (下の describe('S6 バックストップ...') 参照)。ここでは「features単体の
  // フォールバックだけを見た場合は出ない」という部分挙動を固定する
  // (バックストップ抜きにこの応答だけで判断するとどうなるか、を明示するため)。
  it('features取得が失敗した形(event_trackingのみのフォールバック)では表示されない', () => {
    const failFallback = { event_tracking: false };
    expect(shouldShowConsentBanner(failFallback, false)).toBe(false);
  });

  it('ネットワーク例外時に cfg 自体が渡らない場合も表示されない', () => {
    expect(shouldShowConsentBanner(undefined, false)).toBe(false);
  });
});

describe('S6 バックストップ — /api/chat応答でも同じ判定を評価できる', () => {
  // shouldShowConsentBanner は features/chat どちらの応答オブジェクトを渡しても
  // 同じ判定になる(cfg.data_shared_externally しか見ていないため)。
  // widget.js側は features 取得成功時点で既に表示していれば hasConsentAck() が
  // true を返さない限り再度 display='flex' を書き込むだけ(冪等)なので、
  // 「両方の経路が同時に発火しても二重表示や表示状態の巻き戻りは起きない」
  // ことをロジックレベルで保証する。
  it('/api/chat の ChatMessage 相当のオブジェクトでも表示判定できる(features取得失敗時のバックストップ)', () => {
    const chatMessageLike = { id: 'm1', role: 'assistant', content: 'こんにちは', data_shared_externally: true };
    expect(shouldShowConsentBanner(chatMessageLike, false)).toBe(true);
  });

  it('features側が先に同意済みにしていれば、chat応答側は再表示しない(hasConsentAckで既に閉じている)', () => {
    // features側のコールバックで hasConsentAck()=false のうちに表示 → ユーザーが
    // 同意 → localStorage記録済み。その後 /api/chat の応答が届いても
    // shouldShowConsentBanner は alreadyAcked=true を渡された時点で false になる。
    expect(shouldShowConsentBanner({ data_shared_externally: true }, true)).toBe(false);
  });

  it('features取得が失敗(または未到達)でも、chat応答にdata_shared_externally=trueがあれば表示する', () => {
    // これが fail-open 是正の核心: features単体では出せなかったケースが
    // chat応答経由では出せる。
    const failFallback = undefined; // features側は届いていない体
    const chatBackstop = { data_shared_externally: true };
    expect(shouldShowConsentBanner(failFallback, false)).toBe(false); // features単体では出ない(既存挙動)
    expect(shouldShowConsentBanner(chatBackstop, false)).toBe(true); // chat応答側では出る
  });
});

describe('S6 同意キーの分離是正 — サーバ解決済みtenantIdの優先', () => {
  // widget.js: consentAckKey() は _resolvedTenantId(サーバ解決値) → tenantId(DOM由来
  // data-tenant属性) → 'unknown' の順で解決する。data-tenant が欠落/誤設定された
  // 複数テナントが同一オリジンに同居すると、'unknown' キーへ同意状態が集約され
  // 他テナントの同意を誤って引き継ぐ可能性があった。
  function makeConsentAckWithResolution(opts: {
    domTenantId: string | null | undefined;
    resolvedTenantId: string | null;
    storage: Pick<Storage, 'getItem' | 'setItem'>;
  }) {
    // widget.js の _resolvedTenantId は let 相当(再代入可能なモジュール変数)。
    // テストでは呼び出し毎に渡す簡易版として関数引数化する。
    function consentAckKey(): string {
      return 'r2c_consent_ack_' + (opts.resolvedTenantId || opts.domTenantId || 'unknown');
    }
    function hasConsentAck(): boolean {
      try {
        return opts.storage.getItem(consentAckKey()) === '1';
      } catch {
        return false;
      }
    }
    return { consentAckKey, hasConsentAck };
  }

  it('サーバ解決値(_resolvedTenantId)がある場合はそちらを優先する(data-tenant属性より信頼できるため)', () => {
    const w = makeConsentAckWithResolution({
      domTenantId: 'wrong-or-missing',
      resolvedTenantId: 'carnation',
      storage: memoryStorage(),
    });
    expect(w.consentAckKey()).toBe('r2c_consent_ack_carnation');
  });

  it('サーバ応答がまだ届いていない間はDOMのdata-tenant属性を暫定値として使う(初回表示を空白にしない)', () => {
    const w = makeConsentAckWithResolution({
      domTenantId: 'carnation',
      resolvedTenantId: null,
      storage: memoryStorage(),
    });
    expect(w.consentAckKey()).toBe('r2c_consent_ack_carnation');
  });

  it('サーバ解決値もdata-tenant属性も無ければ unknown に倒れる(以前と同じfail-safe)', () => {
    const w = makeConsentAckWithResolution({ domTenantId: '', resolvedTenantId: null, storage: memoryStorage() });
    expect(w.consentAckKey()).toBe('r2c_consent_ack_unknown');
  });

  it('data-tenantが欠落した2テナントでも、サーバ解決値が届けば同意状態が分離される(以前は両方unknownに集約されていた)', () => {
    const storage = memoryStorage();
    const tenantA = makeConsentAckWithResolution({ domTenantId: '', resolvedTenantId: 'tenant-a', storage });
    const tenantB = makeConsentAckWithResolution({ domTenantId: '', resolvedTenantId: 'tenant-b', storage });

    storage.setItem(tenantA.consentAckKey(), '1');

    expect(tenantA.hasConsentAck()).toBe(true);
    expect(tenantB.hasConsentAck()).toBe(false); // tenant-bはtenant-aの同意を引き継がない
  });
});
