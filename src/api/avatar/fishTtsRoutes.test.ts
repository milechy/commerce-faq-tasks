// src/api/avatar/fishTtsRoutes.test.ts
// POST /api/avatar/tts — FishAudio Phase A の検証
//
// 検証内容:
//   - S2-Pro モデル明示指定 (model: 's2-pro')
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

// ── テスト ────────────────────────────────────────────────────────────────────

describe("POST /api/avatar/tts", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    process.env.FISH_AUDIO_API_KEY = "test-fish-key";
    delete process.env.FISH_AUDIO_REFERENCE_ID;
    mockQuery.mockReset();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("正常系: DB の voice_id を reference_id に使い、model=s2-pro で Fish Audio を呼ぶ", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ voice_id: "db-voice-123" }] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/mpeg");

    // DB 解決クエリが tenant_id + is_active + ORDER BY created_at DESC を含む
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("tenant_id = $1");
    expect(sql).toContain("is_active = true");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(params).toEqual(["tenant-a"]);

    const body = sentBody();
    expect(body.model).toBe("s2-pro");
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
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(sentBody().reference_id).toBe("env-voice-456");
  });

  it("voice 解決: DB にも env にもない場合は reference_id フィールド自体を省略", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    const body = sentBody();
    expect("reference_id" in body).toBe(false);
    expect(body.model).toBe("s2-pro");
  });

  it("voice 解決: DB エラー時は env フォールバックで継続（500 にしない）", async () => {
    process.env.FISH_AUDIO_REFERENCE_ID = "env-voice-456";
    mockQuery.mockRejectedValueOnce(new Error("db down"));
    mockFishAudioOk();

    const res = await request(makeApp("tenant-a"))
      .post("/api/avatar/tts")
      .send({ text: "こんにちは" });

    expect(res.status).toBe(200);
    expect(sentBody().reference_id).toBe("env-voice-456");
  });

  it("テナント越境防止: body の voiceId は無視され DB 解決値が優先される", async () => {
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
});
