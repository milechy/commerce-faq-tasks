// src/api/middleware/e2eWriteGuard.test.ts
// E2E由来の書き込みを管理APIで拒否するガードの回帰テスト。
// このガードが黙って無効化されると、CIに置いたsuper_admin認証情報で
// 本番の他テナントデータを壊せる状態に戻るため、境界を明示的に固定する。

import express from "express";
import { request } from "../../../tests/helpers/testServer";
import { e2eWriteGuard, shouldBlockE2eWrite } from "./e2eWriteGuard";
import { TRAFFIC_SOURCE_HEADER } from "../../lib/traffic/trafficSource";

describe("shouldBlockE2eWrite (純関数)", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get", "head", "options"])(
    "読み取りメソッド(%s)はE2E由来でも通す",
    (method) => {
      expect(shouldBlockE2eWrite(method, "e2e")).toBe(false);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "delete"])(
    "書き込みメソッド(%s)はE2E由来なら拒否する",
    (method) => {
      expect(shouldBlockE2eWrite(method, "e2e")).toBe(true);
    },
  );

  it("大文字小文字が違うヘッダ値(E2E / E2e)も拒否する", () => {
    expect(shouldBlockE2eWrite("POST", "E2E")).toBe(true);
    expect(shouldBlockE2eWrite("POST", "E2e")).toBe(true);
  });

  it.each([
    ["ヘッダ未設定(undefined)", undefined],
    ["null", null],
    ["空文字列", ""],
    ["別の値(user)", "user"],
    ["別の値(demo)", "demo"],
    ["部分一致を狙った値(e2e-like)", "e2e-like"],
    ["配列(重複ヘッダ)", ["e2e"]],
    ["数値", 1],
  ])("%s の場合は書き込みでも通す(正規ユーザーを巻き込まない)", (_label, headerValue) => {
    expect(shouldBlockE2eWrite("POST", headerValue)).toBe(false);
  });

  // UAベースの判定を採用していないことの確認。
  // trafficSource.resolveTrafficSource は HeadlessChrome を e2e と見なすが、
  // ここでそれを流用すると正規テナントの運用まで書き込み拒否になりうるため
  // 明示ヘッダのみで判定している。その設計を固定する。
  it("User-Agentがヘッドレスでも、明示ヘッダが無ければ書き込みを通す", () => {
    expect(shouldBlockE2eWrite("POST", "HeadlessChrome/120.0.0.0")).toBe(false);
  });
});

describe("e2eWriteGuard (Expressミドルウェア)", () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(["/v1/admin", "/admin"], e2eWriteGuard);
    app.get("/v1/admin/tenants", (_req, res) => res.json({ ok: true, read: true }));
    app.post("/v1/admin/tenants", (_req, res) => res.status(201).json({ ok: true, created: true }));
    app.delete("/v1/admin/knowledge/faq/bulk", (_req, res) => res.json({ ok: true, deleted: true }));
    // ガードの対象外(ウィジェット等の公開API)。E2Eの書き込みでも素通りすること。
    app.post("/api/chat/escalate", (_req, res) => res.json({ ok: true, escalated: true }));
    return app;
  }

  it("E2Eヘッダ付きのGETは通る(画面到達性の検証は妨げない)", async () => {
    const res = await request(makeApp())
      .get("/v1/admin/tenants")
      .set(TRAFFIC_SOURCE_HEADER, "e2e");

    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
  });

  it("E2Eヘッダ付きのPOSTは403で拒否される", async () => {
    const res = await request(makeApp())
      .post("/v1/admin/tenants")
      .set(TRAFFIC_SOURCE_HEADER, "e2e")
      .send({ name: "evil" });

    expect(res.status).toBe(403);
    // 専門用語(403/権限/ヘッダ名等)を出さない、優しい日本語であること
    expect(res.body.error).not.toMatch(/403|権限|ヘッダ|header/i);
  });

  it("E2Eヘッダ付きのDELETE(FAQ一括削除)は403で拒否される", async () => {
    const res = await request(makeApp())
      .delete("/v1/admin/knowledge/faq/bulk")
      .set(TRAFFIC_SOURCE_HEADER, "e2e");

    expect(res.status).toBe(403);
    expect(res.body.deleted).toBeUndefined();
  });

  it("ヘッダ無しのPOSTは通る(通常のテナント運用を止めない)", async () => {
    const res = await request(makeApp()).post("/v1/admin/tenants").send({ name: "normal" });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
  });

  it("管理API以外(公開API)はE2Eヘッダ付きの書き込みでも通る", async () => {
    // ウィジェット側のE2E(qa-irregular-3roles.spec.ts の Role A/B)が
    // POST /api/chat/escalate を実行しており、これを巻き込んで壊さないこと。
    const res = await request(makeApp())
      .post("/api/chat/escalate")
      .set(TRAFFIC_SOURCE_HEADER, "e2e")
      .send({ sessionId: "x" });

    expect(res.status).toBe(200);
    expect(res.body.escalated).toBe(true);
  });

  it("/admin(レガシーFAQ管理)配下もガードの対象になる", async () => {
    const app = express();
    app.use(express.json());
    app.use(["/v1/admin", "/admin"], e2eWriteGuard);
    app.delete("/admin/faqs/:id", (_req, res) => res.json({ ok: true }));

    const res = await request(app)
      .delete("/admin/faqs/1")
      .set(TRAFFIC_SOURCE_HEADER, "e2e");

    expect(res.status).toBe(403);
  });
});
