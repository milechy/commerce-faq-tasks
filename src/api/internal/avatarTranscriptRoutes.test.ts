// src/api/internal/avatarTranscriptRoutes.test.ts
// POST /api/internal/avatar-transcript のテスト

import express from "express";
import request from "supertest";
import { registerInternalAvatarTranscriptRoutes } from "./avatarTranscriptRoutes";

jest.mock("../admin/chat-history/chatHistoryRepository", () => ({
  saveMessage: jest.fn(),
}));

import { saveMessage } from "../admin/chat-history/chatHistoryRepository";
const mockSaveMessage = saveMessage as jest.Mock;

function makeApp() {
  const app = express();
  app.use(express.json());
  registerInternalAvatarTranscriptRoutes(app);
  return app;
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
});

describe("POST /api/internal/avatar-transcript", () => {
  it("正常系: X-Internal-Request付きで202を返し、metadata.source=avatarでsaveMessageを呼ぶ", async () => {
    const res = await request(makeApp())
      .post("/api/internal/avatar-transcript")
      .set("X-Internal-Request", "1")
      .send(VALID_BODY);

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
    const res = await request(makeApp())
      .post("/api/internal/avatar-transcript")
      .send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: tenantId欠落は400", async () => {
    const res = await request(makeApp())
      .post("/api/internal/avatar-transcript")
      .set("X-Internal-Request", "1")
      .send({ ...VALID_BODY, tenantId: undefined });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("バリデーションエラー: roleが'user'/'assistant'以外は400", async () => {
    const res = await request(makeApp())
      .post("/api/internal/avatar-transcript")
      .set("X-Internal-Request", "1")
      .send({ ...VALID_BODY, role: "system" });

    expect(res.status).toBe(400);
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  it("saveMessage失敗時は500(内部処理は継続、例外は投げない)", async () => {
    mockSaveMessage.mockRejectedValue(new Error("db down"));

    const res = await request(makeApp())
      .post("/api/internal/avatar-transcript")
      .set("X-Internal-Request", "1")
      .send(VALID_BODY);

    expect(res.status).toBe(500);
  });
});
