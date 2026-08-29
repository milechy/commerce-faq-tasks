// src/api/avatar/fishTtsRoutes.test.ts
// POST /api/avatar/tts — FishAudio Phase A の検証
//
// 検証内容:
//   - S2.1 Pro (Free) モデル明示指定 (model: 's2.1-pro-free')
//   - ハードコード reference_id 撤去 → テナント voice_id を DB 解決
//   - DB に voice_id がない場合は env FISH_AUDIO_REFERENCE_ID へフォールバック
//   - 両方ない場合は reference_id フィールド自体を省略
//   - body から voiceId を受けない（テナント越境防止）

import express from "express";
import request from "supertest";
import { registerFishTtsRoutes } from "./fishTtsRoutes";

// ── モック ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();
jest.mock("../../lib/db", () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function makeApp(tenantId: string | null = "tenant-a") {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    if (tenantId) req.tenantId = tenantId;
    next();
  });
  const apiStack: any[] = [];
  registerFishTtsRoutes(app, apiStack);
  return app;
}

function mockFishAudioOk(audio = "mp3-bytes") {
  const chunks = [Buffer.from(audio)];
  let i = 0;
  mockFetch.mockResolvedValueOnce({
    ok: true,
    body: {
      getReader: () => ({
        read: jest.fn(async () =>
          i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined },
        ),
      }),
    },
  });
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[0][1].body as string);
}

// プランゲート追加により、ハンドラは先に `SELECT plan FROM tenants`(plan query)を
// 引いてから avatar_configs の voice_id を引く。200 系のテストは plan を先にキューする。
function mockPlan(plan = "standard") {
  mockQuery.mockResolvedValueOnce({ rows: [{ plan }] });
}

// ── テスト ────────────────────────────────────────────────────────────────────

describe("POST /api/avatar/tts", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.FISH_AUDIO_API_KEY = "test-fish-key";
    delete process.env.FISH_AUDIO_REFERENCE_ID;
    delete process.env.FISH_AUDIO_TTS_MODEL;
    mockQuery.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("正常系: DB の voice_id を reference_id に使い、model=s2.1-pro-free で Fish Audio を呼ぶ", async () => {
    mockPlan("standard");
    mockQuery.mockResolvedValueOnce({ rows: [{ voice_id: "db-voice-123" }] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");

    // DB 解決クエリが tenant_id + is_active + ORDER BY created_at DESC を含む
    // (calls[0] は plan query。voice_id 解決は calls[1])
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toContain("tenant_id = $1");
    expect(sql).toContain("is_active = true");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(params).toEqual(["tenant-a"]);

    const body = sentBody();
    expect(body.model).toBe("s2.1-pro-free");
    expect(body.reference_id).toBe("db-voice-123");
    // ハードコード ID が復活していないこと
    expect(JSON.stringify(body)).not.toContain("63bc41e652214372b15d9416a30a60b4");
  });

  it("認証エラー: tenantId なしは 401", async () => {
    const res = await request(makeApp(null))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: text なしは 400", async () => {
    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({});

    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("voice 解決: DB に voice_id がない場合は env FISH_AUDIO_REFERENCE_ID にフォールバック", async () => {
    process.env.FISH_AUDIO_REFERENCE_ID = "env-voice-456";
    mockPlan("standard");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(sentBody().reference_id).toBe("env-voice-456");
  });

  it("voice 解決: DB にも env にもない場合は reference_id フィールド自体を省略", async () => {
    mockPlan("standard");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    const body = sentBody();
    expect("reference_id" in body).toBe(false);
    expect(body.model).toBe("s2.1-pro-free");
  });

  it("voice 解決: DB エラー時は env フォールバックで継続（500 にしない）", async () => {
    process.env.FISH_AUDIO_REFERENCE_ID = "env-voice-456";
    mockPlan("standard");
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(sentBody().reference_id).toBe("env-voice-456");
  });

  it("GID 1217083837550852: env FISH_AUDIO_TTS_MODEL 未設定時は s2.1-pro-free を使う", async () => {
    mockPlan("standard");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(sentBody().model).toBe("s2.1-pro-free");
  });

  it("GID 1217083837550852: env FISH_AUDIO_TTS_MODEL 設定時はその値を Fish への body に使う", async () => {
    process.env.FISH_AUDIO_TTS_MODEL = "s2.1-pro";
    mockPlan("standard");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(sentBody().model).toBe("s2.1-pro");
  });

  it("テナント越境防止: body の voiceId は無視され DB 解決値が優先される", async () => {
    mockPlan("standard");
    mockQuery.mockResolvedValueOnce({ rows: [{ voice_id: "db-voice-123" }] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは", voiceId: "attacker-voice-999" });

    expect(res.status).toBe(200);
    const body = sentBody();
    expect(body.reference_id).toBe("db-voice-123");
    expect(JSON.stringify(body)).not.toContain("attacker-voice-999");
  });

  // ── プランゲート（原価保護 / 匿名コスト増幅DoS 対策） ──────────────────────
  it("プランゲート: free_ad は 403 で Fish Audio を呼ばない（請求不能な原価を発生させない）", async () => {
    mockPlan("free_ad");

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("plan_upgrade_required");
    expect(res.body.feature).toBe("voice");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("プランゲート: starter も 403（voice は Standard 以上）", async () => {
    mockPlan("starter");

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("プランゲート: DB取得失敗時も fail-closed で 403（free_ad へ倒れる）", async () => {
    // plan query 自体が reject → queryTenantPlan の catch が free_ad を返す
    mockQuery.mockRejectedValueOnce(new Error("db down"));

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ── テキスト長上限（TTS 原価上限） ───────────────────────────────────────
  it("バイト長上限: 上限超過の text は 413 で Fish Audio を呼ばず、plan query も引かない（検証が先）", async () => {
    process.env.TTS_MAX_INPUT_BYTES = "10";
    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "あいうえおかきくけこ" }); // 30 bytes (UTF-8) > 10

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("text_too_long");
    expect(res.body.maxBytes).toBe(10);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("バイト長上限: 既定 2000 byte 以内の text は通過する", async () => {
    mockPlan("standard");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "あ".repeat(500) }); // 1500 bytes < 2000

    expect(res.status).toBe(200);
  });
});
