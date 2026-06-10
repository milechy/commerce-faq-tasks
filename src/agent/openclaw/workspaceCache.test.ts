// src/agent/openclaw/workspaceCache.test.ts
// Phase47-C: WorkspaceFiles メモリキャッシュのテスト

import { getOrBuildWorkspace, invalidateWorkspaceCache } from "./workspaceCache";
import { getPool } from "../../lib/db";

jest.mock("../../lib/db", () => ({
  getPool: jest.fn(),
}));

const mockQuery = jest.fn();
(getPool as jest.Mock).mockReturnValue({ query: mockQuery });

beforeEach(() => {
  jest.clearAllMocks();
  (getPool as jest.Mock).mockReturnValue({ query: mockQuery });
  invalidateWorkspaceCache(); // テスト間のキャッシュ漏れ防止
  process.env.OPENCLAW_ENABLED = "true";
  process.env.OPENCLAW_TENANTS = "carnation";
});

afterEach(() => {
  delete process.env.OPENCLAW_ENABLED;
  delete process.env.OPENCLAW_TENANTS;
});

describe("getOrBuildWorkspace", () => {
  it("Feature Flag オフは null を返し DB query を呼ばない", async () => {
    process.env.OPENCLAW_ENABLED = "false";

    const result = await getOrBuildWorkspace("carnation");

    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("carnation テナントは tenants から system_prompt を取得し WorkspaceFiles を返す", async () => {
    mockQuery.mockResolvedValue({
      rows: [{ system_prompt: "あなたは中古車販売のアシスタントです" }],
    });

    const result = await getOrBuildWorkspace("carnation");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      "SELECT system_prompt FROM tenants WHERE id = $1",
      ["carnation"],
    );
    expect(result).not.toBeNull();
    expect(result?.soul).toContain("あなたは中古車販売のアシスタントです");
    expect(result?.identity).toContain("carnation");
  });

  it("2回目の呼び出しはキャッシュヒット（pool.query は1回のみ）", async () => {
    mockQuery.mockResolvedValue({ rows: [{ system_prompt: "test prompt" }] });

    const first = await getOrBuildWorkspace("carnation");
    const second = await getOrBuildWorkspace("carnation");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // 同一オブジェクト参照
  });

  it("invalidateWorkspaceCache('carnation') 後は再ビルドする（query 2回目発生）", async () => {
    mockQuery.mockResolvedValue({ rows: [{ system_prompt: "test prompt" }] });

    await getOrBuildWorkspace("carnation");
    invalidateWorkspaceCache("carnation");
    await getOrBuildWorkspace("carnation");

    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("invalidateWorkspaceCache() 引数なしは全テナントをクリアする", async () => {
    process.env.OPENCLAW_TENANTS = "carnation,daisy";
    mockQuery.mockResolvedValue({ rows: [{ system_prompt: "test prompt" }] });

    await getOrBuildWorkspace("carnation");
    await getOrBuildWorkspace("daisy");
    expect(mockQuery).toHaveBeenCalledTimes(2);

    invalidateWorkspaceCache();

    await getOrBuildWorkspace("carnation");
    await getOrBuildWorkspace("daisy");
    expect(mockQuery).toHaveBeenCalledTimes(4); // 両方とも再ビルド
  });
});
