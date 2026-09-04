// src/api/widget/wpProvisionRepository.test.ts
//
// 要件書 docs/WORDPRESS_PLUGIN_REQUIREMENTS.md の以下を固定する:
//   FR-04 / C-1  サイト所有証明を通さずに provisioned へ遷移できない
//   X-3 / I-3/I-4 同一 origin で2つ目のテナントを作らない
//   禁止20        「存在しない」と「期限切れ」を区別する(行を消さない)
//
// SQL の WHERE 句にしか表現できない不変条件があるため、この層では
// 発行される SQL そのものを検証する(confirmPolicy.test.ts がソースを
// readFileSync して守るのと同じ流儀)。

import {
  createWpProvisioning,
  findWpProvisioningByPollTokenHash,
  findPendingWpProvisioningByChallengeHash,
  findProvisionedWpProvisioningBySiteOrigin,
  markWpProvisioningSiteVerified,
  markWpProvisioningProvisioned,
  markWpProvisioningFailed,
  expireStaleWpProvisionings,
  countProvisionedWpTenants,
  countWpProvisioningsCreatedSince,
  getWpProvisioningChallengeHashForVerification,
} from "./wpProvisionRepository";

function makeDb(response: { rows?: any[]; rowCount?: number } = {}) {
  const query = jest.fn().mockResolvedValue({
    rows: response.rows ?? [],
    rowCount: response.rowCount ?? (response.rows?.length ?? 0),
  });
  return { db: { query } as any, query };
}

/** 発行された SQL を空白正規化して1行にする(改行・インデントの差を無視するため)。 */
function sqlOf(query: jest.Mock, callIndex = 0): string {
  return String(query.mock.calls[callIndex][0]).replace(/\s+/g, " ").trim();
}

describe("createWpProvisioning", () => {
  it("FR-03 の範囲の8列だけを、宣言順どおりの引数で INSERT する", async () => {
    const { db, query } = makeDb({ rows: [{ id: "row-1" }] });
    await createWpProvisioning(db, {
      siteOrigin: "https://example.com",
      email: "owner@example.com",
      challengeHash: "chash",
      pollTokenHash: "phash",
      siteName: "My Shop",
      wpVersion: "6.5",
      pluginVersion: "1.0.0",
      locale: "ja",
    });

    expect(sqlOf(query)).toContain(
      "INSERT INTO wp_provisionings (site_origin, email, challenge_hash, poll_token_hash, site_name, wp_version, plugin_version, locale)"
    );
    expect(query.mock.calls[0][1]).toEqual([
      "https://example.com",
      "owner@example.com",
      "chash",
      "phash",
      "My Shop",
      "6.5",
      "1.0.0",
      "ja",
    ]);
  });

  it("任意項目を省略すると null で埋める(undefined を DB へ渡さない)", async () => {
    const { db, query } = makeDb({ rows: [{ id: "row-1" }] });
    await createWpProvisioning(db, {
      siteOrigin: "https://example.com",
      email: "owner@example.com",
      challengeHash: "chash",
      pollTokenHash: "phash",
    });
    expect(query.mock.calls[0][1].slice(4)).toEqual([null, null, null, null]);
  });
});

describe("秘密値を読み出さない", () => {
  // ハッシュを SELECT に含めると、呼び出し側が誤ってレスポンスへ載せる事故が起きうる。
  // 型で防げないので SQL 側で持たないことを固定する。
  /** 発行された SQL の SELECT 句(SELECT と FROM の間)だけを取り出す。 */
  function selectClauseOf(query: jest.Mock): string {
    const m = /SELECT (.*?) FROM/.exec(sqlOf(query));
    return m ? m[1] : "";
  }

  it.each([
    ["poll_token_hash", (db: any) => findWpProvisioningByPollTokenHash(db, "h")],
    ["challenge_hash", (db: any) => findPendingWpProvisioningByChallengeHash(db, "h")],
    ["site_origin", (db: any) => findProvisionedWpProvisioningBySiteOrigin(db, "https://e.com")],
  ])("%s で引く SELECT 句にハッシュ列が含まれない", async (_label, run) => {
    const { db, query } = makeDb({ rows: [] });
    await run(db);
    const select = selectClauseOf(query);
    expect(select).not.toBe("");
    expect(select).not.toContain("challenge_hash");
    expect(select).not.toContain("poll_token_hash");
    // 返す列自体は取れていること(SELECT句の抽出が失敗して素通りするのを防ぐ)
    expect(select).toContain("site_origin");
  });

  it("見つからなければ null を返す(undefined を漏らさない)", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(findWpProvisioningByPollTokenHash(db, "h")).resolves.toBeNull();
    await expect(findPendingWpProvisioningByChallengeHash(db, "h")).resolves.toBeNull();
    await expect(findProvisionedWpProvisioningBySiteOrigin(db, "https://e.com")).resolves.toBeNull();
  });
});

describe("状態遷移をSQLで縛る", () => {
  it("チャレンジ照合は pending の行しか対象にしない", async () => {
    const { db, query } = makeDb({ rows: [] });
    await findPendingWpProvisioningByChallengeHash(db, "chash");
    expect(sqlOf(query)).toContain("status = 'pending'");
  });

  it("site_verified への遷移は pending からのみ(巻き戻し・二重適用を防ぐ)", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    await markWpProvisioningSiteVerified(db, "row-1");
    const sql = sqlOf(query);
    expect(sql).toContain("SET status = 'site_verified'");
    expect(sql).toContain("WHERE id = $1 AND status = 'pending'");
  });

  // ★これが受け入れ条件 C-1(サイト所有証明を通さずにキーが発行できない)の本体。
  // WHERE から status 条件が外れると、pending のまま provisioned に飛べてしまう。
  it("provisioned への遷移は site_verified からのみ", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    await markWpProvisioningProvisioned(db, "row-1", "tenant-a");
    const sql = sqlOf(query);
    expect(sql).toContain("SET status = 'provisioned'");
    expect(sql).toContain("WHERE id = $1 AND status = 'site_verified'");
    expect(query.mock.calls[0][1]).toEqual(["row-1", "tenant-a"]);
  });

  it("失敗の記録は provisioned を対象にしない(確定を覆さない)", async () => {
    const { db, query } = makeDb({ rowCount: 1 });
    await markWpProvisioningFailed(db, "row-1", "site_unreachable");
    const sql = sqlOf(query);
    expect(sql).toContain("SET status = 'failed'");
    expect(sql).toContain("status <> 'provisioned'");
    expect(query.mock.calls[0][1]).toEqual(["row-1", "site_unreachable"]);
  });

  it.each([
    ["site_verified", markWpProvisioningSiteVerified],
    ["provisioned", (db: any, id: string) => markWpProvisioningProvisioned(db, id, "t")],
    ["failed", (db: any, id: string) => markWpProvisioningFailed(db, id, "r")],
  ])("%s: 遷移条件に合わず0行更新なら false を返す", async (_label, fn) => {
    const { db } = makeDb({ rowCount: 0 });
    await expect(fn(db, "row-1")).resolves.toBe(false);
  });

  it("rowCount が null でも false に倒す", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: null });
    await expect(markWpProvisioningSiteVerified({ query } as any, "row-1")).resolves.toBe(false);
  });
});

describe("期限切れの扱い", () => {
  // 禁止20: 行を DELETE すると「存在しない」と区別できず、再送導線を出せない。
  it("期限切れは status を expired にするだけで行を消さない", async () => {
    const { db, query } = makeDb({ rowCount: 3 });
    const n = await expireStaleWpProvisionings(db, 24);
    const sql = sqlOf(query);
    expect(sql).toContain("UPDATE wp_provisionings");
    expect(sql).not.toContain("DELETE");
    expect(sql).toContain("SET status = 'expired'");
    expect(n).toBe(3);
  });

  it("確定済み・失敗済みは期限切れにしない", async () => {
    const { db, query } = makeDb({ rowCount: 0 });
    await expireStaleWpProvisionings(db, 24);
    expect(sqlOf(query)).toContain("status IN ('pending', 'site_verified')");
  });
});

describe("総量ガードの集計", () => {
  it("発行済みテナント数は provisioned のみを数える", async () => {
    const { db, query } = makeDb({ rows: [{ count: 42 }] });
    await expect(countProvisionedWpTenants(db)).resolves.toBe(42);
    expect(sqlOf(query)).toContain("status = 'provisioned'");
  });

  it("日次作成数は境界を呼び出し側の Date で受け取る", async () => {
    const since = new Date("2026-09-04T00:00:00.000Z");
    const { db, query } = makeDb({ rows: [{ count: 7 }] });
    await expect(countWpProvisioningsCreatedSince(db, since)).resolves.toBe(7);
    expect(sqlOf(query)).toContain("created_at >= $1");
    expect(query.mock.calls[0][1]).toEqual([since]);
  });

  // 行が返らない状況(集計SQLの変更ミス等)で NaN を返すと、上限判定が
  // すり抜ける。0 に倒して「まだ無い」として扱う。
  it.each([
    ["行が空", { rows: [] }],
    ["count が null", { rows: [{ count: null }] }],
  ])("%s のときは 0 を返す", async (_label, resp) => {
    const { db } = makeDb(resp as any);
    await expect(countProvisionedWpTenants(db)).resolves.toBe(0);
  });
});

describe("getWpProvisioningChallengeHashForVerification", () => {
  it("pending の行なら challenge_hash を返す", async () => {
    const { db, query } = makeDb({ rows: [{ challenge_hash: "hash-abc" }] });
    await expect(getWpProvisioningChallengeHashForVerification(db, "row-1")).resolves.toBe(
      "hash-abc"
    );
    expect(sqlOf(query)).toContain("status = 'pending'");
  });

  it("見つからなければ null(undefinedを漏らさない)", async () => {
    const { db } = makeDb({ rows: [] });
    await expect(getWpProvisioningChallengeHashForVerification(db, "row-1")).resolves.toBeNull();
  });

  // 他の一般的な SELECT(ROW_COLUMNS)にハッシュ列を含めない設計との対比。
  // この関数だけが例外的にハッシュを返すことを、SQL文字列で直接確認する。
  it("SELECT句がchallenge_hashだけを対象にしている(他の列を巻き込まない)", async () => {
    const { db, query } = makeDb({ rows: [{ challenge_hash: "h" }] });
    await getWpProvisioningChallengeHashForVerification(db, "row-1");
    const sql = sqlOf(query);
    expect(sql).toMatch(/^SELECT challenge_hash FROM wp_provisionings/);
  });
});
