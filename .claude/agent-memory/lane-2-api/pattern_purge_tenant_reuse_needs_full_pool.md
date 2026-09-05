---
name: pattern_purge_tenant_reuse_needs_full_pool
description: 既存のpurgeTenantChatData(トランザクション処理)を再利用する新規関数はdb引数をPick<Pool,"query">ではなく完全なPool型にする必要がある
metadata:
  type: project
---

`src/api/admin/chat-history/retentionRepository.ts` の `purgeTenantChatData` は
`pool.connect()`(トランザクション用クライアント取得)を必要とするため、`params.pool` の型は
`Pick<Pool,"query">` ではなく `pg` の完全な `Pool` 型で宣言されている。

一方で本リポジトリの多くのDBアクセス層(`shopifyRepository.ts`等)は「テストのモックPoolと
食い違わないように db を引数で受け取る」原則に従いつつ、型は最小限の `Pick<Pool,"query">`
に絞るのが通例(`tenantHasFeature` が `getPool()` 直呼びで踏んだ穴の再発防止)。

`src/api/widget/shopifyDeletionQueue.ts` の `executeApprovedDeletion` のように、
「承認記録(単純なquery)」と「既存のトランザクション処理(purgeTenantChatData)の再利用」を
1関数内で両方行う場合、db引数の型は素直に `Pool`(pg)にする。`Pool` は `query` も持つため、
`Pick<Pool,"query">` を要求する既存関数(`approveDeletion`等)への受け渡しはそのまま通る
(構造的部分型なので狭い方へは無条件に代入可能)。逆に `Pick<Pool,"query">` のオブジェクトを
`purgeTenantChatData({pool: ...})` に渡そうとすると型エラーになる(`connect` が無いため)。

**Why**: 型を狭めすぎると「既存のテナント削除に相当する処理を再利用する」という
CLAUDE.md の指示(禁止2「共有済みの層を手書きでコピーする」)に従えなくなり、
SQLを書き写す(禁止6の同型)方向に誘導されてしまう。

**How to apply**: 新しい関数がトランザクション系の既存ヘルパー(`purgeTenantChatData`
`purgeExpiredChatData`等、`pool?: Pool`を要求するもの)を呼ぶ必要があるなら、
その関数のdb引数は最初から `Pool` 型で宣言する。テストは
`retentionRepository.test.ts` の `makeClient()`(SQL文字列パターンで応答を出し分ける
`{query, connect: jest.fn(async()=>client)}` 型オブジェクト)と同じ流儀でモックすれば型は通る。
