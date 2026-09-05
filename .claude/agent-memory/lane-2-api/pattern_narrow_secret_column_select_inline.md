---
name: pattern-narrow-secret-column-select-inline
description: 既存リポジトリ層の一般SELECTが秘密列を除外している場合、2ファイル制約下では新規ファイル内に閉じた最小SELECTを書く
metadata:
  type: project
---

`wpProvisionRepository.ts` の `getWpProvisioningChallengeHashForVerification`(「検証専用、他のSELECTに絶対に混ぜない」)と同じ設計が
`shopifyRepository.ts`(`findTenantByShopDomain` は `shopify_access_token_encrypted` を意図的に除外)にも存在する。

タスク制約が「新規ファイルは実装+テストの2つのみ」の場合、秘密列(暗号化済みアクセストークン等)を
読む必要が新たに出ても、既存リポジトリファイルには追加せず、新規ファイル内にスコープを閉じた
最小 `SELECT`(例: `SELECT id, shopify_access_token_encrypted FROM tenants WHERE shopify_shop_domain = $1`)を
直接書いてよい。これは「DBアクセス層を再実装している」のではなく、既存リポジトリが意図的に
公開していない値への専用アクセサを、制約内で最小サイズで用意しているだけ。

**Why:** 既存の共有リポジトリファイル(他PRのテストが既に緑で依存している)を触ると
レビュー面積・conflict リスクが増える。タスクが明示的に「2ファイルのみ」と言っている場合、
それを文字通り守りつつ、既存の「秘密値は一般SELECTに混ぜない」という設計思想だけ踏襲するのが
最も安全。

**How to apply:** 新規のDBアクセスが必要になったとき、まず対象カラムが既存リポジトリの
`ROW_COLUMNS` 的な定数から意図的に除外されていないか確認する(除外されていれば秘密値の可能性が高い)。
除外されていれば、新規ファイル内に `Pick<Pool, "query">` 型のローカル `Db` 型を定義し、
用途特化の1〜2クエリだけを直接書く。テストでは `decryptText`(平文フォールバック、
`KNOWLEDGE_ENCRYPTION_KEY` 未設定時は NODE_ENV=test で素通り)を使えば暗号化セットアップ不要で
DBモックの `rows` にそのまま平文トークンを入れてテストできる([[project_shopify_settings_routes_stopgap_auth]] と同系統の認証まわりの暫定設計)。
