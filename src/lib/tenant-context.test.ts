const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock("./db", () => ({
  pool: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));
jest.mock("./logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

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
  seedTenantsFromDB,
  type SeedTenantRow,
} from "./tenant-context";
import { logger as mockedLogger } from "./logger";

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

  // この関数は cors.ts の isKnownTenantOrigin に配線されており、true を返すと
  // Access-Control-Allow-Origin に当該オリジンが credentials 付きで反射される。
  // 1テナントが `https://*` を保存するだけで全テナント分のCORSが緩む越境影響があったため、
  // 照合側(originCheck.ts)でこの形を無効化した。その遮断がここで効くことを固定する。
  it("does not leak a bare https://* wildcard into the cross-tenant CORS lookup", () => {
    registerTenant({
      tenantId: "greedy-wildcard-tenant",
      name: "Greedy Wildcard Tenant",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: {
        apiKeyHash: "dummyhash-greedy",
        hashAlgorithm: "sha256",
        allowedOrigins: ["https://*"],
        rateLimit: 100,
        rateLimitWindowMs: 60_000,
      },
      enabled: true,
    });

    expect(isOriginKnownToAnyTenant("https://attacker.example")).toBe(false);
    expect(isOriginKnownToAnyTenant("https://unrelated-tenant-site.example")).toBe(false);
    // 正規に登録された他テナントのオリジンは引き続き通る
    expect(isOriginKnownToAnyTenant("https://shop.example.com")).toBe(true);
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

  it("super_admin のキー発行後も旧・主キーと副キーが有効なまま（DB上activeなのに認証できないキーを作らない）", () => {
    // client_adminが無停止ローテーションで追加キーを発行済みの状態を再現
    addTenantApiKey(TENANT_ID, ADDITIONAL_HASH, null);

    // super_adminのPOST /tenants/:id/keysは、in-memory登録済みテナントに対しては
    // registerTenant(上書き)ではなく addTenantApiKey(追加)を使う。
    // DBのINSERT・UIのキー一覧・client_admin側POSTと同じ「追加」の意味論。
    const SUPER_ADMIN_NEW_HASH = "multikey-superadmin-added-hash";
    const added = addTenantApiKey(TENANT_ID, SUPER_ADMIN_NEW_HASH, null);
    expect(added).toBe(true);

    // 新しいキーは有効
    expect(getTenantByApiKeyHash(SUPER_ADMIN_NEW_HASH)?.tenantId).toBe(TENANT_ID);
    // client_adminが追加した副キーも生き残る
    expect(getTenantByApiKeyHash(ADDITIONAL_HASH)?.tenantId).toBe(TENANT_ID);
    // 旧・主キーも生き残る。DB側は is_active=true のままなので、
    // in-memory だけが先に消えて「DB上はactiveなのに401」になる desync が起きない。
    expect(getTenantByApiKeyHash(PRIMARY_HASH)?.tenantId).toBe(TENANT_ID);
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

describe("seedTenantsFromDB — 起動時のin-memory復元", () => {
  // このパスは従来テストが1本も無く、PM2再起動のたびに
  // 「テナントごと1本のキーしか復元されない」バグが検出されないままだった。

  // seedTenantsFromDB が読むDB行の型は tenant-context.ts の SeedTenantRow を
  // そのまま使う(2026-09-04レビュー是正: 以前はここに同じ形の型を再定義して
  // おり、片方だけ列を追加してもう片方を直し忘れるドリフトの温床だった)。
  const row = (over: Partial<SeedTenantRow> & Pick<SeedTenantRow, "tenant_id" | "key_hash">): SeedTenantRow => ({
    name: over.tenant_id,
    plan: "starter",
    is_active: true,
    features: { avatar: false, voice: false, rag: true },
    allowed_origins: [],
    rate_limit: null,
    expires_at: null,
    ...over,
  });

  /** pool.query だけを持つ最小のフェイク（seedTenantsFromDB が使うのはこれだけ） */
  const fakePool = (rows: SeedTenantRow[]) =>
    ({ query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }) }) as unknown as Parameters<typeof seedTenantsFromDB>[0];

  // このdescribe配下の既存テストは全て retryDelayMs=0 で呼ぶ(二重読み取りの
  // 待機時間をテストで待たない)。二重読み取り自体の挙動は専用のテストで検証する。
  const seed = (
    pool: Parameters<typeof seedTenantsFromDB>[0],
    logger?: Parameters<typeof seedTenantsFromDB>[1],
  ) => seedTenantsFromDB(pool, logger, 0);

  it("1テナントに複数のアクティブキーがある場合、全キーを復元する（再起動でローテーションキーが消えない）", async () => {
    const TENANT = "seed-multi-key-tenant";
    await seed(
      fakePool([
        row({ tenant_id: TENANT, key_hash: "seed-key-newest" }),
        row({ tenant_id: TENANT, key_hash: "seed-key-older" }),
        row({ tenant_id: TENANT, key_hash: "seed-key-oldest" }),
      ])
    );

    // 3本すべてが認証に使える = 無停止ローテーションが再起動を跨いで成立する
    expect(getTenantByApiKeyHash("seed-key-newest")?.tenantId).toBe(TENANT);
    expect(getTenantByApiKeyHash("seed-key-older")?.tenantId).toBe(TENANT);
    expect(getTenantByApiKeyHash("seed-key-oldest")?.tenantId).toBe(TENANT);
  });

  it("SQLの先頭行(ORDER BYで最新)が主キーになる — 復元後の主キーが非決定的にならない", async () => {
    const TENANT = "seed-primary-order-tenant";
    await seed(
      fakePool([
        row({ tenant_id: TENANT, key_hash: "seed-primary-expected" }),
        row({ tenant_id: TENANT, key_hash: "seed-primary-not-expected" }),
      ])
    );

    expect(getTenantConfig(TENANT)?.security.apiKeyHash).toBe("seed-primary-expected");
  });

  // free_ad プラン追加時に発見・修正した箇所: 起動時DB同期の plan フォールバックが
  // ["starter","growth","enterprise"] の三値allowlistのままだと、free_ad行を
  // 読み込んだ際にstarterへ「昇格」してしまう(CLAUDE.md 絶対にやってはいけないこと37と
  // 同型のバグ)。fail-safeの落とし先が最も制限の強い free_ad になっていることを固定する。
  it("plan='free_ad'の行はそのままfree_adとして復元される（starterへ昇格しない）", async () => {
    const TENANT = "seed-free-ad-tenant";
    await seed(
      fakePool([row({ tenant_id: TENANT, key_hash: "seed-free-ad-key", plan: "free_ad" })])
    );

    expect(getTenantConfig(TENANT)?.plan).toBe("free_ad");
  });

  it("未知のplan文字列は最も制限の強いfree_adへ倒れる（starterへ昇格しない）", async () => {
    const TENANT = "seed-unknown-plan-tenant";
    await seed(
      fakePool([row({ tenant_id: TENANT, key_hash: "seed-unknown-plan-key", plan: "typo-plan" })])
    );

    expect(getTenantConfig(TENANT)?.plan).toBe("free_ad");
  });

  it("plan列がnull/未設定の行もfree_adへ倒れる", async () => {
    const TENANT = "seed-null-plan-tenant";
    await seed(
      fakePool([row({ tenant_id: TENANT, key_hash: "seed-null-plan-key", plan: null as unknown as string })])
    );

    expect(getTenantConfig(TENANT)?.plan).toBe("free_ad");
  });

  it("既知の4値(free_ad/starter/growth/enterprise)はすべてそのまま復元される", async () => {
    for (const plan of ["free_ad", "starter", "growth", "enterprise"] as const) {
      const TENANT = `seed-plan-${plan}-tenant`;
      await seed(fakePool([row({ tenant_id: TENANT, key_hash: `seed-${plan}-key`, plan })]));
      expect(getTenantConfig(TENANT)?.plan).toBe(plan);
    }
  });

  it("複数テナントを取り違えずに復元する（キーがテナント間で混ざらない）", async () => {
    await seed(
      fakePool([
        row({ tenant_id: "seed-tenant-a", key_hash: "seed-a-key1" }),
        row({ tenant_id: "seed-tenant-a", key_hash: "seed-a-key2" }),
        row({ tenant_id: "seed-tenant-b", key_hash: "seed-b-key1" }),
      ])
    );

    expect(getTenantByApiKeyHash("seed-a-key1")?.tenantId).toBe("seed-tenant-a");
    expect(getTenantByApiKeyHash("seed-a-key2")?.tenantId).toBe("seed-tenant-a");
    expect(getTenantByApiKeyHash("seed-b-key1")?.tenantId).toBe("seed-tenant-b");
  });

  it("追加キーは行ごとの expires_at を保持する（期限切れの追加キーは復元後も認証できない）", async () => {
    const TENANT = "seed-expiry-tenant";
    await seed(
      fakePool([
        row({ tenant_id: TENANT, key_hash: "seed-expiry-primary" }),
        row({ tenant_id: TENANT, key_hash: "seed-expiry-valid", expires_at: new Date(Date.now() + 600_000).toISOString() }),
        row({ tenant_id: TENANT, key_hash: "seed-expiry-stale", expires_at: new Date(Date.now() - 1_000).toISOString() }),
      ])
    );

    expect(getTenantByApiKeyHash("seed-expiry-valid")?.tenantId).toBe(TENANT);
    // 期限切れの行がDBの WHERE をすり抜けて届いても、in-memory側で弾く
    expect(getTenantByApiKeyHash("seed-expiry-stale")).toBeUndefined();
  });

  it("env由来で登録済みのテナントはDBで上書きしない（キーも足さない — envが唯一の情報源）", async () => {
    const TENANT = "seed-env-precedence-tenant";
    registerTenant({
      tenantId: TENANT,
      name: "From Env",
      plan: "enterprise",
      features: { avatar: true, voice: true, rag: true },
      security: { apiKeyHash: "env-key-hash", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });

    await seed(
      fakePool([
        row({ tenant_id: TENANT, key_hash: "db-key-should-be-ignored", name: "From DB", plan: "starter" }),
      ])
    );

    expect(getTenantConfig(TENANT)?.name).toBe("From Env");
    expect(getTenantConfig(TENANT)?.security.apiKeyHash).toBe("env-key-hash");
    expect(getTenantByApiKeyHash("db-key-should-be-ignored")).toBeUndefined();
  });

  it("DB接続に失敗しても例外を投げずに起動を継続する（起動をブロックしない）", async () => {
    const failingPool = {
      query: jest.fn().mockRejectedValue(new Error("connection refused")),
    } as unknown as Parameters<typeof seedTenantsFromDB>[0];

    await expect(seed(failingPool)).resolves.toBeUndefined();
  });

  it("0件でも例外を投げない", async () => {
    await expect(seed(fakePool([]))).resolves.toBeUndefined();
  });

  // GID 1218171750803663是正: 2026-09-04に本番で「DBは正しいのに起動直後の
  // 読み取りだけ件数が減る」事象が実測された。二重読み取りで多い方を採用し、
  // 食い違いをerrorログに残すことを固定する。
  describe("二重読み取り(2026-09-04是正)", () => {
    /** 呼び出しごとに異なる行配列を返すフェイクpool(1回目と2回目で結果を変える) */
    const flakyPool = (firstRows: SeedTenantRow[], secondRows: SeedTenantRow[]) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: firstRows, rowCount: firstRows.length })
        .mockResolvedValueOnce({ rows: secondRows, rowCount: secondRows.length });
      return { query } as unknown as Parameters<typeof seedTenantsFromDB>[0];
    };

    it("1回目が少なく2回目が正しい件数なら、2回目(多い方)を採用して復元する", async () => {
      const TENANT_A = "seed-flaky-tenant-a";
      const TENANT_B = "seed-flaky-tenant-b";
      const full = [
        row({ tenant_id: TENANT_A, key_hash: "seed-flaky-a-key" }),
        row({ tenant_id: TENANT_B, key_hash: "seed-flaky-b-key" }),
      ];
      const partial = [row({ tenant_id: TENANT_A, key_hash: "seed-flaky-a-key" })];

      await seedTenantsFromDB(flakyPool(partial, full), undefined, 0);

      expect(getTenantByApiKeyHash("seed-flaky-a-key")?.tenantId).toBe(TENANT_A);
      expect(getTenantByApiKeyHash("seed-flaky-b-key")?.tenantId).toBe(TENANT_B);
    });

    it("1回目が正しく2回目が少ない件数でも、多い方(1回目)を採用して復元する", async () => {
      const TENANT_A = "seed-flaky-reverse-tenant-a";
      const TENANT_B = "seed-flaky-reverse-tenant-b";
      const full = [
        row({ tenant_id: TENANT_A, key_hash: "seed-flaky-reverse-a-key" }),
        row({ tenant_id: TENANT_B, key_hash: "seed-flaky-reverse-b-key" }),
      ];
      const partial = [row({ tenant_id: TENANT_A, key_hash: "seed-flaky-reverse-a-key" })];

      await seedTenantsFromDB(flakyPool(full, partial), undefined, 0);

      expect(getTenantByApiKeyHash("seed-flaky-reverse-a-key")?.tenantId).toBe(TENANT_A);
      expect(getTenantByApiKeyHash("seed-flaky-reverse-b-key")?.tenantId).toBe(TENANT_B);
    });

    it("2回の件数が食い違った場合、errorログに両方の件数を残す", async () => {
      const errorSpy = jest.fn();
      const testLogger = { warn: jest.fn(), info: jest.fn(), error: errorSpy } as unknown as Parameters<typeof seedTenantsFromDB>[1];
      const TENANT = "seed-flaky-log-tenant";
      const full = [row({ tenant_id: TENANT, key_hash: "seed-flaky-log-key" })];

      await seedTenantsFromDB(flakyPool([], full), testLogger, 0);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ firstCount: 0, secondCount: 1 }),
        expect.stringContaining("食い違った")
      );
    });

    it("2回とも同じ件数なら、errorログを出さない", async () => {
      const errorSpy = jest.fn();
      const testLogger = { warn: jest.fn(), info: jest.fn(), error: errorSpy } as unknown as Parameters<typeof seedTenantsFromDB>[1];
      const TENANT = "seed-stable-log-tenant";
      const rows = [row({ tenant_id: TENANT, key_hash: "seed-stable-log-key" })];

      await seedTenantsFromDB(flakyPool(rows, rows), testLogger, 0);

      expect(errorSpy).not.toHaveBeenCalled();
    });

    // 既知のトレードオフ(2026-09-04レビュー是正): 件数が同じでも中身(テナント
    // 集合)が異なる場合、現在の実装はsize比較だけで判定するため常に2回目を
    // 採用する。1回目と2回目の間に正当な同時実行の変更(例: あるテナントが
    // 無効化され、別の新規テナントが同時に有効化された)が起きても、より新しい
    // 状態である2回目を採用するのは意図どおりの挙動。この挙動を明示的に固定する
    // (「多い方を採用」というsize比較だけのロジックが暗黙に持つ、この場合の
    // 判断基準を可視化する目的)。
    it("イレギュラー: 件数は同じだが中身(テナント集合)が異なる場合、2回目(より新しい方)を採用する", async () => {
      const TENANT_OLD = "seed-tie-old-tenant";
      const TENANT_NEW = "seed-tie-new-tenant";
      const first = [row({ tenant_id: TENANT_OLD, key_hash: "seed-tie-old-key" })];
      const second = [row({ tenant_id: TENANT_NEW, key_hash: "seed-tie-new-key" })];

      await seedTenantsFromDB(flakyPool(first, second), undefined, 0);

      expect(getTenantByApiKeyHash("seed-tie-new-key")?.tenantId).toBe(TENANT_NEW);
      expect(getTenantByApiKeyHash("seed-tie-old-key")).toBeUndefined();
    });

    // 壊れやすいポイント: 1回目が成功した後、2回目の読み取り自体が例外を投げる
    // (起動直後のDB瞬断・接続プール競合)場合。単純な二重読み取りの実装だと
    // 全体が1つのtry/catchに包まれているため、1回目の正しい結果ごと握りつぶされ、
    // 「DBは正しいのに読み取れなかった」という本来直したかった障害モードを
    // 二重読み取りの導入自体が新しい形で再現してしまう(1回目が成功していたのに
    // 2回目の例外で0テナント登録になる)。1回目の結果は2回目の成否に関わらず
    // 活かされなければならない。
    const poolWithFailingSecondRead = (firstRows: SeedTenantRow[]) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rows: firstRows, rowCount: firstRows.length })
        .mockRejectedValueOnce(new Error("connection reset during startup"));
      return { query } as unknown as Parameters<typeof seedTenantsFromDB>[0];
    };

    it("1回目が成功し2回目が例外を投げても、1回目の結果で復元する(1回目の成功を握りつぶさない)", async () => {
      const TENANT = "seed-second-read-fails-tenant";
      const first = [row({ tenant_id: TENANT, key_hash: "seed-second-read-fails-key" })];

      await seedTenantsFromDB(poolWithFailingSecondRead(first), undefined, 0);

      expect(getTenantByApiKeyHash("seed-second-read-fails-key")?.tenantId).toBe(TENANT);
    });

    it("1回目が成功し2回目が例外を投げた場合、2回目の失敗をwarnログに残す(黙って握りつぶさない)", async () => {
      const warnSpy = jest.fn();
      const testLogger = { warn: warnSpy, info: jest.fn(), error: jest.fn() } as unknown as Parameters<typeof seedTenantsFromDB>[1];
      const TENANT = "seed-second-read-fails-log-tenant";
      const first = [row({ tenant_id: TENANT, key_hash: "seed-second-read-fails-log-key" })];

      await seedTenantsFromDB(poolWithFailingSecondRead(first), testLogger, 0);

      expect(warnSpy).toHaveBeenCalled();
    });

    it("1回目が例外を投げた場合は、2回目を試さずに例外を投げずfalseへfail-safe(既存動作を維持)", async () => {
      const query = jest.fn().mockRejectedValueOnce(new Error("connection refused on first read"));
      const failingFirstReadPool = { query } as unknown as Parameters<typeof seedTenantsFromDB>[0];

      await expect(seedTenantsFromDB(failingFirstReadPool, undefined, 0)).resolves.toBeUndefined();
      // 2回目は試みられない(1回目が失敗した時点で全体をfail-safeにフォールバックする)
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});

describe("getTenantByApiKeyHash — last_used_at の非同期更新", () => {
  beforeEach(() => {
    mockPoolQuery.mockClear();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    jest.useRealTimers();
    let now = Date.now();
    jest.spyOn(Date, "now").mockImplementation(() => now);
    (global as unknown as { __advanceMockNow: (ms: number) => void }).__advanceMockNow = (ms: number) => {
      now += ms;
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function advanceMockNow(ms: number): void {
    (global as unknown as { __advanceMockNow: (ms: number) => void }).__advanceMockNow(ms);
  }

  it("有効なキーで認証成功すると last_used_at のUPDATEが発火する", () => {
    registerTenant({
      tenantId: "last-used-tenant-1",
      name: "t",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "lu-key-1", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });

    const cfg = getTenantByApiKeyHash("lu-key-1");

    expect(cfg?.tenantId).toBe("last-used-tenant-1");
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0]?.[0]).toMatch(/UPDATE tenant_api_keys SET last_used_at/);
    expect(mockPoolQuery.mock.calls[0]?.[1]).toEqual(["lu-key-1"]);
  });

  it("認証失敗（キー不一致）では last_used_at を更新しない", () => {
    registerTenant({
      tenantId: "last-used-tenant-2",
      name: "t",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "lu-key-2", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });

    const cfg = getTenantByApiKeyHash("wrong-key");

    expect(cfg).toBeUndefined();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it("デバウンス窓内（5分未満）の連続リクエストは1回しかUPDATEしない", () => {
    registerTenant({
      tenantId: "last-used-tenant-3",
      name: "t",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "lu-key-3", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });

    getTenantByApiKeyHash("lu-key-3");
    advanceMockNow(60_000); // 1分後
    getTenantByApiKeyHash("lu-key-3");
    advanceMockNow(60_000); // 2分後（累計3分、まだデバウンス窓内）
    getTenantByApiKeyHash("lu-key-3");

    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
  });

  it("デバウンス窓（5分）を超えると再度UPDATEする", () => {
    registerTenant({
      tenantId: "last-used-tenant-4",
      name: "t",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "lu-key-4", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });

    getTenantByApiKeyHash("lu-key-4");
    advanceMockNow(6 * 60 * 1000); // 6分後（デバウンス窓超過）
    getTenantByApiKeyHash("lu-key-4");

    expect(mockPoolQuery).toHaveBeenCalledTimes(2);
  });

  it("DB書き込みが失敗しても認証結果には影響せず、warnログに落ちる", async () => {
    registerTenant({
      tenantId: "last-used-tenant-5",
      name: "t",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "lu-key-5", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    mockPoolQuery.mockRejectedValueOnce(new Error("write failed"));

    const cfg = getTenantByApiKeyHash("lu-key-5");
    expect(cfg?.tenantId).toBe("last-used-tenant-5"); // 同期的な認証結果は即座に返る（DB書き込みは待たない）

    // fire-and-forgetのPromise rejectionが処理されるのを待つ
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockedLogger.warn).toHaveBeenCalled();
  });

  it("追加キー（無停止ローテーション）経由の認証成功でも last_used_at が更新される", () => {
    registerTenant({
      tenantId: "last-used-tenant-6",
      name: "t",
      plan: "starter",
      features: { avatar: false, voice: false, rag: true },
      security: { apiKeyHash: "lu-key-6-primary", hashAlgorithm: "sha256", allowedOrigins: [], rateLimit: 100, rateLimitWindowMs: 60_000 },
      enabled: true,
    });
    addTenantApiKey("last-used-tenant-6", "lu-key-6-additional", null);

    const cfg = getTenantByApiKeyHash("lu-key-6-additional");

    expect(cfg?.tenantId).toBe("last-used-tenant-6");
    expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    expect(mockPoolQuery.mock.calls[0]?.[1]).toEqual(["lu-key-6-additional"]);
  });
});
