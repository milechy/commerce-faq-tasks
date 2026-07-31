// src/api/middleware/e2eWriteGuard.ts
//
// E2E(Playwright)由来のリクエストから管理APIへの書き込みを拒否する。
//
// 背景: E2E は専用のステージング環境を持たず、playwright.config.ts の baseURL 経由で
// 本番(https://admin.r2c.biz)を直接叩く。CIには super_admin の認証情報を置く構想があるが、
// super_admin は他テナントへの越境書き込み・削除・Stripe実課金・APIキー発行・ユーザー招待が
// 全部できてしまい、read-only 相当の中間ロールはこのコードベースに存在しない
// (roleAuth.ts の UserRole は super_admin / client_admin / anonymous の3値のみ)。
//
// そこでサーバ側で「E2E由来の書き込みは受け付けない」という境界を1本引く。
// E2E の検証対象は画面到達性・表示の出し分けであって副作用ではないため、
// 読み取り(GET/HEAD/OPTIONS)は従来どおり通す。
//
// 限界(意図的に受け入れている点):
//   - ヘッダは攻撃者が外せる。これは「認証情報漏洩そのもの」への対策ではなく、
//     CI経由の事故(テストの書き換えミス・想定外のリトライ等)で本番データが壊れるのを防ぐもの。
//   - 根本対策はステージング環境(E2E_BASE_URL)であり、これはその代替ではなく併用する緩和策。

import type { Request, Response, NextFunction } from "express";
import { TRAFFIC_SOURCE_HEADER } from "../../lib/traffic/trafficSource";

/** 副作用を持たない(と見なす)HTTPメソッド。 */
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * E2E由来かつ書き込みメソッドなら true(=拒否すべき)。
 *
 * 判定はヘッダの明示のみで行い、User-Agent による推測はしない。
 * trafficSource.ts の resolveTrafficSource は UA も見て 'e2e' と判定するが、
 * ここで UA 判定を採用すると「HeadlessChrome を名乗る正規のテナント運用」まで
 * 書き込み拒否になりうる。誤って本番運用を止めるより、E2Eの明示ヘッダに限定して
 * 取りこぼす方を選ぶ(Playwright側は extraHTTPHeaders で常時付与している)。
 */
export function shouldBlockE2eWrite(method: string, headerValue: unknown): boolean {
  if (READ_ONLY_METHODS.has(method.toUpperCase())) return false;
  return typeof headerValue === "string" && headerValue.toLowerCase() === "e2e";
}

/**
 * 管理API(/v1/admin, /admin)より前に app.use() で挿す。
 * 拒否時は 403 と、専門用語を避けた日本語メッセージを返す。
 */
export function e2eWriteGuard(req: Request, res: Response, next: NextFunction): void {
  if (shouldBlockE2eWrite(req.method, req.headers[TRAFFIC_SOURCE_HEADER])) {
    res.status(403).json({
      error: "テスト用の接続からは、内容を変更する操作を受け付けていません。",
    });
    return;
  }
  next();
}
