// tests/helpers/testServer.ts のガード回帰テスト。
//
// このヘルパーの導入目的そのもの(ポート枯渇の解消)は、keep-alive の
// http.Agent(`keepAliveAgent`, `{ keepAlive: true, maxSockets: 4 }`)を
// 全リクエストで使い回し、TCPコネクションを再利用することで実現されている。
// もし`.agent(keepAliveAgent)`の付与が壊れて毎回新規コネクションを張るように
// 戻ってしまうと、テストのアサーションは全て通ったまま(レスポンスの内容は
// 変わらないため)ポート枯渇問題だけが静かに再発する — つまりこのヘルパーの
// 存在意義そのものが失われても、他のテストからは検出できない。
//
// これを検出できる形にするため、サーバ側で受信した接続の remotePort
// (クライアント側の送信元エフェメラルポート)を記録し、逐次2回のリクエストで
// 同一のremotePort(=同一のTCPコネクション)が使われたことを直接確認する。
// コネクションが使い回されていなければ、2回のリクエストで異なる一時ポートが
// 割り当てられるはずなので、この観測は「再利用されているか否か」を機械的に
// 区別できる。
import express from "express";
import { request } from "./testServer";

it("逐次リクエストがkeep-alive agentにより同一のTCPコネクションを再利用する", async () => {
  const remotePorts: Array<number | undefined> = [];
  const app = express();
  app.get("/x", (req, res) => {
    remotePorts.push(req.socket.remotePort);
    res.json({ ok: true });
  });

  await request(app).get("/x");
  await request(app).get("/x");
  await request(app).get("/x");

  expect(remotePorts).toHaveLength(3);
  expect(remotePorts.every((p) => typeof p === "number")).toBe(true);
  // keep-alive で再利用されていれば、3回とも同じ送信元ポート(=同じソケット)。
  // 再利用されていなければ、リクエストごとに異なる一時ポートが観測されるはず。
  expect(new Set(remotePorts).size).toBe(1);
});
