import {
  seedTenantsFromEnv,
  getTenantConfig,
  registerTenant,
  updateTenantEnabled,
  updateTenantAllowedOrigins,
  isOriginKnownToAnyTenant,
  getTenantByApiKeyHash,
  setTenantApiKeyExpiry,
  revokeTenantApiKeyIfCurrent,
  revokeTenantApiKey,
  addTenantApiKey,
  revokeAdditionalTenantApiKey,
} from "./tenant-context";

describe("seedTenantsFromEnv — numbered keys", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    // Save env vars we'll mutate
    for (const key of [
      "API_KEY",
      "API_KEY_TENANT_ID",
      "API_KEY_2",
      "API_KEY_2_TENANT_ID",
      "TENANT_CONFIGS_JSON",
    ]) {
      savedEnv[key] = process.env[key];
    }
  });

  afterAll(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it("reads API_KEY_TENANT_ID for the base key", () => {
    process.env.API_KEY = "test-key-base";
    process.env.API_KEY_TENANT_ID = "partner";
    delete process.env.TENANT_CONFIGS_JSON;

    seedTenantsFromEnv();

    const tenant = getTenantConfig("partner");
    expect(tenant).toBeDefined();
    expect(tenant?.tenantId).toBe("partner");
  });

  it("reads API_KEY_2 and API_KEY_2_TENANT_ID", () => {
    process.env.API_KEY_2 = "carnation-api-key-xxxx";
    process.env.API_KEY_2_TENANT_ID = "carnation";
    delete process.env.TENANT_CONFIGS_JSON;

    seedTenantsFromEnv();

    const tenant = getTenantConfig("carnation");
    expect(tenant).toBeDefined();
    expect(tenant?.tenantId).toBe("carnation");
  });
});

describe("updateTenantEnabled — kill-switch in-memory sync", () => {
  const TENANT_ID = "test-kill-switch-tenant";

  beforeEach(() => {
    registerTenant({
      tenantId: TENANT_ID,
      name: "Kill Switch Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "dummyhash", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
  });

  it("disables an existing tenant immediately", () => {
    const result = updateTenantEnabled(TENANT_ID, false);
    expect(result).toBe(true);
    expect(getTenantConfig(TENANT_ID)?.enabled).toBe(false);
  });

  it("re-enables a disabled tenant", () => {
    updateTenantEnabled(TENANT_ID, false);
    updateTenantEnabled(TENANT_ID, true);
    expect(getTenantConfig(TENANT_ID)?.enabled).toBe(true);
  });

  it("returns false for an unknown tenant (DB-only tenant)", () => {
    const result = updateTenantEnabled("non-existent-tenant-xyz", false);
    expect(result).toBe(false);
  });

  it("preserves other TenantConfig fields when updating enabled", () => {
    updateTenantEnabled(TENANT_ID, false);
    const cfg = getTenantConfig(TENANT_ID);
    expect(cfg?.name).toBe("Kill Switch Test");
    expect(cfg?.plan).toBe("starter");
    expect(cfg?.security.apiKeyHash).toBe("dummyhash");
  });
});

describe("updateTenantAllowedOrigins — CORS allowlist in-memory sync (PATCH live reload)", () => {
  const TENANT_ID = "test-origins-live-reload-tenant";

  beforeEach(() => {
    registerTenant({
      tenantId: TENANT_ID,
      name: "Origins Live Reload Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: {
        apiKeyHash: "origins-test-hash",
        hashAlgorithm: "sha256",
        allowedOrigins: ["https://old-shop.example.com"],
        rateLimit: 100,
        rateLimitWindowMs: 60_000,
      },
      enabled: true,
    });
  });

  it("PATCH直後、再起動なしで新規ドメインが isOriginKnownToAnyTenant に反映される", () => {
    expect(isOriginKnownToAnyTenant("https://new-shop.example.com")).toBe(false);

    const result = updateTenantAllowedOrigins(TENANT_ID, ["https://new-shop.example.com"]);

    expect(result).toBe(true);
    expect(isOriginKnownToAnyTenant("https://new-shop.example.com")).toBe(true);
  });

  it("ドメインを外す方向の更新も即座に反映される（旧ドメインが二度と許可されない）", () => {
    expect(isOriginKnownToAnyTenant("https://old-shop.example.com")).toBe(true);

    updateTenantAllowedOrigins(TENANT_ID, []);

    expect(isOriginKnownToAnyTenant("https://old-shop.example.com")).toBe(false);
  });

  it("空配列は「オリジン制限なし」ではなく、DBの値どおりそのまま書き込む（呼び出し元がフィールド省略と区別する責務を持つ）", () => {
    updateTenantAllowedOrigins(TENANT_ID, []);
    expect(getTenantConfig(TENANT_ID)?.security.allowedOrigins).toEqual([]);
  });

  it("存在しないtenantIdに対してもno-opで例外を投げず、falseを返す", () => {
    expect(() => updateTenantAllowedOrigins("non-existent-tenant-xyz", ["https://x.example.com"])).not.toThrow();
    const result = updateTenantAllowedOrigins("non-existent-tenant-xyz", ["https://x.example.com"]);
    expect(result).toBe(false);
  });

  it("allowedOrigins以外のTenantConfigフィールド（apiKeyHash等）を巻き込まない", () => {
    updateTenantAllowedOrigins(TENANT_ID, ["https://new-shop.example.com"]);
    const cfg = getTenantConfig(TENANT_ID);
    expect(cfg?.security.apiKeyHash).toBe("origins-test-hash");
    expect(cfg?.name).toBe("Origins Live Reload Test");
    expect(cfg?.enabled).toBe(true);
  });
});

describe("isOriginKnownToAnyTenant — CORS preflight tenant-domain lookup", () => {
  beforeEach(() => {
    registerTenant({
      tenantId: "origin-test-tenant",
      name: "Origin Test Tenant",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: {
        apiKeyHash: "dummyhash-origin",
        hashAlgorithm: "sha256",
        allowedOrigins: ["https://shop.example.com", "https://*.wildcard-shop.com"],
        rateLimit: 100,
        rateLimitWindowMs: 60_000,
      },
      enabled: true,
    });
  });

  it("returns true for an origin registered on a tenant", () => {
    expect(isOriginKnownToAnyTenant("https://shop.example.com")).toBe(true);
  });

  it("returns true for an origin matching a tenant's wildcard pattern", () => {
    expect(isOriginKnownToAnyTenant("https://sub.wildcard-shop.com")).toBe(true);
  });

  it("returns false for an origin not registered on any tenant", () => {
    expect(isOriginKnownToAnyTenant("https://unregistered-domain.example")).toBe(false);
  });

  it("returns false when checked against a tenant with no allowedOrigins", () => {
    registerTenant({
      tenantId: "no-origin-tenant",
      name: "No Origin Tenant",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "dummyhash-2", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    expect(isOriginKnownToAnyTenant("https://some-random-site.example")).toBe(false);
  });
});

describe("APIキー失効・期限切れの即時反映", () => {
  const TENANT_ID = "test-key-revocation-tenant";
  const KEY_HASH = "revocation-test-key-hash";

  beforeEach(() => {
    registerTenant({
      tenantId: TENANT_ID,
      name: "Revocation Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: KEY_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    setTenantApiKeyExpiry(TENANT_ID, null);
  });

  it("finds the tenant by the currently registered key hash", () => {
    expect(getTenantByApiKeyHash(KEY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKeyIfCurrent invalidates a matching key immediately (no PM2 restart needed)", () => {
    const revoked = revokeTenantApiKeyIfCurrent(TENANT_ID, KEY_HASH);
    expect(revoked).toBe(true);
    expect(getTenantByApiKeyHash(KEY_HASH)).toBeUndefined();
  });

  it("revokeTenantApiKeyIfCurrent does nothing when the hash does not match the current key (e.g. an already-superseded key)", () => {
    const revoked = revokeTenantApiKeyIfCurrent(TENANT_ID, "some-other-old-key-hash");
    expect(revoked).toBe(false);
    expect(getTenantByApiKeyHash(KEY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKeyIfCurrent returns false for an unknown tenant", () => {
    expect(revokeTenantApiKeyIfCurrent("unknown-tenant-xyz", KEY_HASH)).toBe(false);
  });

  it("treats a key as expired once its expiry time has passed", () => {
    setTenantApiKeyExpiry(TENANT_ID, new Date(Date.now() - 1000));
    expect(getTenantByApiKeyHash(KEY_HASH)).toBeUndefined();
  });

  it("still resolves the tenant when the expiry is in the future", () => {
    setTenantApiKeyExpiry(TENANT_ID, new Date(Date.now() + 60_000));
    expect(getTenantByApiKeyHash(KEY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("returns undefined for a hash that has never been registered", () => {
    expect(getTenantByApiKeyHash("never-registered-hash")).toBeUndefined();
  });

  it("境界値: expiresAt がちょうど現在時刻と一致する場合は期限切れ扱いになる（<=境界）", () => {
    const now = Date.now();
    setTenantApiKeyExpiry(TENANT_ID, new Date(now));
    // Date.now() が呼び出し間で1ms進む可能性があるため、明示的に同時刻を再現する
    const spy = jest.spyOn(Date, "now").mockReturnValue(now);
    try {
      expect(getTenantByApiKeyHash(KEY_HASH)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("境界値: expiresAt がわずかでも未来なら有効", () => {
    // 実時間比較のため 1ms 等の極小マージンはテスト実行のオーバーヘッドで
    // フレークになる（Date.now() 取得からアサーションまでの間に経過しうる）。
    // 「期限切れ扱いにならない」という意味を保ったまま、余裕を持たせる。
    setTenantApiKeyExpiry(TENANT_ID, new Date(Date.now() + 5000));
    expect(getTenantByApiKeyHash(KEY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("setTenantApiKeyExpiry を一度も呼んでいない（Map未登録=undefined）テナントは期限切れ扱いにならない", () => {
    const FRESH_TENANT = "test-key-no-expiry-call-tenant";
    const FRESH_HASH = "fresh-hash-no-expiry-call";
    registerTenant({
      tenantId: FRESH_TENANT,
      name: "Fresh",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: FRESH_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    // setTenantApiKeyExpiry を意図的に呼ばない — 起動時DBシード直後などを想定
    expect(getTenantByApiKeyHash(FRESH_HASH)?.tenantId).toBe(FRESH_TENANT);
  });

  it("失効済み(apiKeyHash === '')のテナントは空文字ハッシュでは絶対に引けない（!cfg.security.apiKeyHash ガード）", () => {
    revokeTenantApiKeyIfCurrent(TENANT_ID, KEY_HASH);
    expect(getTenantByApiKeyHash("")).toBeUndefined();
  });

  it("イレギュラー: 同じ失効操作を2回連続で呼んでも例外を投げず、2回目は false（失効済みハッシュはもう current と一致しない）", () => {
    const first = revokeTenantApiKeyIfCurrent(TENANT_ID, KEY_HASH);
    const second = revokeTenantApiKeyIfCurrent(TENANT_ID, KEY_HASH);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("イレギュラー: 失効後に同一テナントへ新キーを再登録すると、旧ハッシュは失敗し新ハッシュのみ有効になる", () => {
    revokeTenantApiKeyIfCurrent(TENANT_ID, KEY_HASH);
    const NEW_HASH = "reissued-key-hash";
    registerTenant({
      tenantId: TENANT_ID,
      name: "Revocation Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: NEW_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    expect(getTenantByApiKeyHash(KEY_HASH)).toBeUndefined();
    expect(getTenantByApiKeyHash(NEW_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKeyIfCurrent は失効時に有効期限マップも削除する（無期限キー再発行時に古い期限が亡霊のように残らない）", () => {
    setTenantApiKeyExpiry(TENANT_ID, new Date(Date.now() + 60_000));
    revokeTenantApiKeyIfCurrent(TENANT_ID, KEY_HASH);
    const NEW_HASH = "reissued-key-hash-2";
    registerTenant({
      tenantId: TENANT_ID,
      name: "Revocation Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: NEW_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    // setTenantApiKeyExpiry を再度呼ばずに新キー登録した場合、失効時にMapが掃除されていなければ
    // 古い期限(60秒後)が誤って新キーに適用されてしまう可能性がある — undefined（無期限扱い）が正しい
    expect(getTenantByApiKeyHash(NEW_HASH)?.tenantId).toBe(TENANT_ID);
  });
});

describe("addTenantApiKey / revokeAdditionalTenantApiKey — 無停止ローテーション", () => {
  const TENANT_ID = "test-multikey-tenant";
  const PRIMARY_HASH = "multikey-primary-hash";
  const ADDITIONAL_HASH = "multikey-additional-hash";

  beforeEach(() => {
    registerTenant({
      tenantId: TENANT_ID,
      name: "Multikey Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: PRIMARY_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    setTenantApiKeyExpiry(TENANT_ID, null);
  });

  it("addTenantApiKey で追加したキーは主キーと同時に有効になる", () => {
    const added = addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    expect(added).toBe(true);
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("addTenantApiKey は tenantStore に存在しない未知テナントには false を返す", () => {
    expect(addTenantApiKey("unknown-tenant-xyz", "some-hash", null)).toBe(false);
  });

  it("追加キーには独立した有効期限を設定できる（主キーの期限には影響しない）", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, new Date(Date.now() - 1000)); // 既に期限切れ
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)).toBeUndefined(); // 追加キーは期限切れ
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID); // 主キーは無期限のまま有効
  });

  it("追加キーが未来の期限なら有効に解決される", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, new Date(Date.now() + 60_000));
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeAdditionalTenantApiKey は追加キーのみ失効させ、主キーは有効なまま", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    const revoked = revokeAdditionalTenantApiKey(TENANT_ID, ADDITIONAL_HASH);
    expect(revoked).toBe(true);
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)).toBeUndefined();
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeAdditionalTenantApiKey は主キーのハッシュを渡しても何もしない（担当範囲外のハッシュ）", () => {
    const revoked = revokeAdditionalTenantApiKey(TENANT_ID, PRIMARY_HASH);
    expect(revoked).toBe(false);
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeAdditionalTenantApiKey は存在しない追加キーに対して false を返す", () => {
    expect(revokeAdditionalTenantApiKey(TENANT_ID, "never-added-hash")).toBe(false);
  });

  it("複数の追加キーを同時に有効化でき、個別に失効させられる", () => {
    const hashB = "multikey-additional-hash-b";
    const hashC = "multikey-additional-hash-c";
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    addTenantApiKey(TENANT_ID, hashB, null);
    addTenantApiKey(TENANT_ID, hashC, null);
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
    expect(getTenantByApiKeyHash(hashB)?.tenantId).toBe(TENANT_ID);
    expect(getTenantByApiKeyHash(hashC)?.tenantId).toBe(TENANT_ID);

    revokeAdditionalTenantApiKey(TENANT_ID, hashB);
    expect(getTenantByApiKeyHash(hashB)).toBeUndefined();
    // 他の2本(主キー含む)は無傷
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
    expect(getTenantByApiKeyHash(hashC)?.tenantId).toBe(TENANT_ID);
  });

  it("主キーを revokeTenantApiKeyIfCurrent で失効させても、追加キーは影響を受けず有効なまま", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    const revoked = revokeTenantApiKeyIfCurrent(TENANT_ID, PRIMARY_HASH);
    expect(revoked).toBe(true);
    expect(getTenantByApiKeyHash(PRIMARY_HASH)).toBeUndefined();
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("同じハッシュを addTenantApiKey で2回登録しても例外にならず、後勝ちの期限で上書きされる", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, new Date(Date.now() + 60_000));
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null); // 無期限に上書き
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("未登録テナントの追加キーMapに対する getTenantByApiKeyHash 探索は例外を投げない", () => {
    expect(getTenantByApiKeyHash("hash-with-no-additional-keys-anywhere")).toBeUndefined();
  });

  it("イレギュラー: 主キー・追加キーを全て失効させるとテナントは完全にロックアウトされる（想定される最悪ケース）", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    revokeTenantApiKeyIfCurrent(TENANT_ID, PRIMARY_HASH);
    revokeAdditionalTenantApiKey(TENANT_ID, ADDITIONAL_HASH);
    expect(getTenantByApiKeyHash(PRIMARY_HASH)).toBeUndefined();
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)).toBeUndefined();
    // client_admin自身の失効操作だけでは復旧経路がない（POST /my-tenant/keysで新規発行するには
    // 依然として認証済みリクエストが必要で、キーで認証するAPI経路からは発行し直せない）。
    // super_adminの registerTenant による強制上書きだけが復旧経路になる。
  });

  it("復旧経路: 全キー失効後もsuper_admin相当のregisterTenant(強制上書き)でテナントを即座に復旧できる", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    revokeTenantApiKeyIfCurrent(TENANT_ID, PRIMARY_HASH);
    revokeAdditionalTenantApiKey(TENANT_ID, ADDITIONAL_HASH);
    expect(getTenantByApiKeyHash(PRIMARY_HASH)).toBeUndefined();

    const RESCUE_HASH = "multikey-rescue-hash";
    registerTenant({
      tenantId: TENANT_ID,
      name: "Multikey Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: RESCUE_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    expect(getTenantByApiKeyHash(RESCUE_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("既知のリスク: super_admin向けPOST /tenants/:id/keysのregisterTenant(上書き)は、client_adminが無停止ローテーションで追加した副キーには影響しないが、旧・主キーはDB側is_active=trueのままin-memoryでは無効化される", () => {
    // client_adminが無停止ローテーションで追加キーを発行済みの状態を再現
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);

    // super_adminが自分のエンドポイント(POST /tenants/:id/keys)で新しい主キーを発行すると、
    // ルート実装は addTenantApiKey ではなく registerTenant を呼ぶ(既存実装のまま)。
    const SUPER_ADMIN_NEW_HASH = "multikey-superadmin-overwrite-hash";
    registerTenant({
      tenantId: TENANT_ID,
      name: "Multikey Test",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: SUPER_ADMIN_NEW_HASH, hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });

    // 新しい主キーは有効
    expect(getTenantByApiKeyHash(SUPER_ADMIN_NEW_HASH)?.tenantId).toBe(TENANT_ID);
    // client_adminが追加した副キーは無停止ローテーションの約束どおり生き残る
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
    // 旧・主キーはtenantStoreから消えるため in-memory では二度と認証できない。
    // DB(tenant_api_keys.is_active)側はこの操作だけでは更新されないため、
    // 「DB上はactiveなのに実際には使えないキー」というdesyncが生まれる。
    // (super_adminが自分のキー発行前に旧キーを明示的にDELETEしていれば起きないが、
    //  ルートの実装はそれを強制していない — 既知のリスクとして報告する)
    expect(getTenantByApiKeyHash(PRIMARY_HASH)).toBeUndefined();
  });

  // --- revokeTenantApiKey: 失効の単一入口（主キー・追加キーを区別せず落とす） ---
  // 以前は呼び出し側が revokeTenantApiKeyIfCurrent と revokeAdditionalTenantApiKey を
  // 個別に呼ぶ形で、super_admin の DELETE が前者しか呼んでいなかった。その結果
  // 「DBは is_active=false なのに in-memory では認証が通り続ける」fail-open が発生していた。

  it("revokeTenantApiKey は追加キーを失効させる（super_adminのDELETEで発生していたfail-openの回帰防止）", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);

    const revoked = revokeTenantApiKey(TENANT_ID, ADDITIONAL_HASH);

    expect(revoked).toBe(true);
    // ここが本丸: 追加キーが in-memory からも落ちていること
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)).toBeUndefined();
    // 主キーは巻き添えにしない
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKey は主キーも失効させる（主キー用の経路も同じ入口で賄える）", () => {
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);

    const revoked = revokeTenantApiKey(TENANT_ID, PRIMARY_HASH);

    expect(revoked).toBe(true);
    expect(getTenantByApiKeyHash(PRIMARY_HASH)).toBeUndefined();
    // 追加キーは巻き添えにしない
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKey は在籍しないハッシュには false を返す（DBだけにある行を失効させた場合）", () => {
    expect(revokeTenantApiKey(TENANT_ID, "hash-that-was-never-in-memory")).toBe(false);
    // 既存キーには影響しない
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("revokeTenantApiKey で複数の追加キーを1本ずつ失効させても、残りは有効なまま", () => {
    const hashB = "revoke-unified-hash-b";
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);
    addTenantApiKey(TENANT_ID, hashB, null);

    revokeTenantApiKey(TENANT_ID, ADDITIONAL_HASH);

    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)).toBeUndefined();
    expect(getTenantByApiKeyHash(hashB)?.tenantId).toBe(TENANT_ID);
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
  });

  it("結線確認: 実際のAPIキー生成(generateApiKey)→ハッシュ化(hashApiKey)→addTenantApiKey→getTenantByApiKeyHashの一連の流れが、POSTルートと同じ手順で成立する", () => {
    // routes.test.ts は tenant-context を丸ごとモックしているため、
    // 「発行された平文キーが実際に認証に使えるか」はモック越しには検証できない。
    // ここでは実際の apiKeyUtils と組み合わせ、ルートが行う手順をそのまま再現して検証する。
    const { generateApiKey, hashApiKey } = jest.requireActual("../api/admin/tenants/apiKeyUtils") as {
      generateApiKey: () => string;
      hashApiKey: (key: string) => string;
    };
    const plainKey = generateApiKey();
    expect(plainKey).toMatch(/^rjc_[0-9a-f]{64}$/);
    const keyHash = hashApiKey(plainKey);

    const added = addTenantApiKey(TENANT_ID, keyHash, null);
    expect(added).toBe(true);

    // 発行された平文キーを再度ハッシュ化して認証する(実際のミドルウェアが行う手順)
    const authHash = hashApiKey(plainKey);
    expect(getTenantByApiKeyHash(authHash)?.tenantId).toBe(TENANT_ID);

    // 失効させれば同じ平文キーはもう認証できない
    revokeAdditionalTenantApiKey(TENANT_ID, keyHash);
    expect(getTenantByApiKeyHash(authHash)).toBeUndefined();
  });
});
