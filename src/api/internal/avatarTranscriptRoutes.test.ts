// src/api/internal/avatarTranscriptRoutes.test.ts
// POST /api/internal/avatar-transcript のテスト
// + 内部API HMAC 認証(P0: body.tenantId/sessionId 全信用による他テナント chat_messages 注入の遮断)

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { createHmac } from "node:crypto";
import { registerInternalAvatarTranscriptRoutes } from "./avatarTranscriptRoutes";

jest.mock("../admin/chat-history/chatHistoryRepository", () => ({
  saveMessage: jest.fn(),
}));

import { saveMessage } from "../admin/chat-history/chatHistoryRepository";
const mockSaveMessage = saveMessage as jest.Mock;

const HMAC_SECRET = "test-internal-hmac-secret";
const PATH = "/api/internal/avatar-transcript";

function hmacHeaders(body: unknown, secret: string = HMAC_SECRET, ts?: string) {
  const timestamp = ts ?? Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}:${JSON.stringify(body)}`)
    .digest("hex");
  return {
    "x-internal-request": "1",
    "x-hmac-timestamp": timestamp,
    "x-hmac-signature": signature,
  };
}

function makeApp() {
  process.env.INTERNAL_API_HMAC_SECRET = HMAC_SECRET;
  const app = express();
  app.use(express.json());
  registerInternalAvatarTranscriptRoutes(app);
  return app;
}

/** 正しい HMAC 署名付きで送る。日本語(非ASCII)content でも TS の JSON.stringify と一致する。 */
function signedPost(app: express.Express, body: unknown) {
  return request(app).post(PATH).set(hmacHeaders(body)).send(body as object);
}

const VALID_BODY = {
  tenantId: "carnation",
  sessionId: "rajiuce-carnation-abc123",
  role: "user",
  content: "保証はありますか",
};

beforeEach(() => {
  mockSaveMessage.mockReset();
  mockSaveMessage.mockResolvedValue(undefined);
  process.env.INTERNAL_API_HMAC_SECRET = HMAC_SECRET;
});
afterAll(() => {
  delete process.env.INTERNAL_API_HMAC_SECRET;
});

describe("POST /api/internal/avatar-transcript", () => {
  it("正常系: 正署名 + X-Internal-Requestで202を返し、metadata.source=avatarでsaveMessageを呼ぶ", async () => {
    const res = await signedPost(makeApp(), VALID_BODY);

    expect(res.status).toBe(202);
    expect(mockSaveMessage).toHaveBeenCalledWith({
      tenantId: "carnation",
      sessionId: "rajiuce-carnation-abc123",
      role: "user",
      content: "保証はありますか",
      metadata: { source: "avatar", channel: "livekit" },
    });
  });

  it("認証エラー: X-Internal-Requestヘッダなしは403", async () => {
    const res = await request(makeApp()).post(PATH).send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: tenantId欠落は400", async () => {
    const res = await signedPost(makeApp(), { ...VALID_BODY, tenantId: undefined });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: roleが'user'/'assistant'以外は400", async () => {
    const res = await signedPost(makeApp(), { ...VALID_BODY, role: "system" });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("saveMessage失敗時は500(内部処理は継続、例外は投げない)", async () => {
    mockSaveMessage.mockRejectedValue(new Error("db down"));

    const res = await signedPost(makeApp(), VALID_BODY);

    expect(res.status).toBe(500);
  });

  // ── HMAC 認証(P0) ────────────────────────────────────────────────────────
  describe("HMAC 認証", () => {
    it("X-Internal-Request はあるが HMAC ヘッダ欠落 → 401(署名無しの他テナント注入を拒否)", async () => {
      const res = await request(makeApp())
        .post(PATH)
        .set("X-Internal-Request", "1")
        .send({ ...VALID_BODY, tenantId: "victim-tenant" });

      expect(res.status).toBe(401);
      expect(mockSaveMessage).not.toHaveBeenCalled();
    });

    it("署名が不正(別 secret) → 401", async () => {
      const body = { ...VALID_BODY, tenantId: "victim-tenant" };
      const res = await request(makeApp())
        .post(PATH)
        .set(hmacHeaders(body, "attacker-secret"))
        .send(body);

      expect(res.status).toBe(401);
      expect(mockSaveMessage).not.toHaveBeenCalled();
    });

    it("ボディ改竄(署名は別テナントで生成し、送信で victim にすり替え) → 401", async () => {
      const signedBody = { ...VALID_BODY, tenantId: "attacker-own" };
      const tamperedBody = { ...VALID_BODY, tenantId: "victim-tenant" };
      const res = await request(makeApp())
        .post(PATH)
        .set(hmacHeaders(signedBody))
        .send(tamperedBody);

      expect(res.status).toBe(401);
      expect(mockSaveMessage).not.toHaveBeenCalled();
    });

    it("secret 未設定 → fail-closed 500", async () => {
      const app = makeApp();
      delete process.env.INTERNAL_API_HMAC_SECRET;
      const res = await request(app).post(PATH).set(hmacHeaders(VALID_BODY)).send(VALID_BODY);

      expect(res.status).toBe(500);
      expect(mockSaveMessage).not.toHaveBeenCalled();
    });
  });
});
