---
name: pattern_stateless_oauth_csrf_state
description: 未認証OAuth系エンドポイントでDBテーブルを新設できない/したくない場合のstate(CSRF)設計パターン
metadata:
  type: project
---

R2C の未認証 OAuth 系フロー(例: Shopify `/v1/public/shopify/install` → `/callback`)で
CSRF対策の `state` パラメータを実装する際、新規テーブルを作らずに済ませる標準パターンとして
「自己完結・署名付きトークン」を採用した(`src/api/widget/shopifyOAuthRoutes.ts`)。

構造: `base64url(JSON({shop, nonce, iat}))` + `.` + `HMAC-SHA256(secret, purposeTag + "." + payload)`。
- secret は外部プラットフォームが要求する既存の連携シークレット(Shopify なら Client Secret =
  `SHOPIFY_API_SECRET`)をそのまま使う。CLAUDE.md 禁止27(公開配布物と管理APIで同じ署名鍵を使うな)は
  「内部管理鍵を外部配布物に漏らす」ケースの話であり、外部プラットフォーム自身が発行し
  その OAuth フローのためだけに使う秘密値を、同じアプリの同じフローの CSRF token 署名に
  再利用するのはこの禁止の対象ではない、と判断した。
- purposeTag(例 `"shopify_oauth_state_v1"`)を署名対象文字列に混ぜることで、同じ secret を
  将来別用途(Webhook HMAC等)で使っても署名の使い回しにならないようにする(domain separation)。
- サーバ側は何も保持しない(wp_provisionings のような「ランダム値を発行してハッシュをDB保存」方式
  とは異なる)。PM2 が `instances: 1` である前提とも独立に動く(再起動・複数インスタンスでも壊れない)。

**Why**: wpProvisionToken.ts の「ランダム値+DBにハッシュ保存」パターンは正しいが、今回のタスクは
「新規ファイルは実装+テストの2つのみ」という制約があり、新規テーブル/migrationを追加できなかった。
自己完結トークンなら新規永続化なしで同等のCSRF耐性(改ざん検知・TTL失効)が得られる。

**How to apply**: 今後、承認/連携フローで「サーバ側に短命な状態を持たせたいが新規テーブルを
追加したくない」場面(他プラットフォーム連携の OAuth 等)では、このパターン(JSON payload を
base64url + purposeTag付きHMAC)を再現してよい。ただし「往復する値」であり得る限り短命(このタスクは
10分)にし、`timingSafeEqual` で比較すること(生の `===` 比較はタイミング攻撃に弱い)。
