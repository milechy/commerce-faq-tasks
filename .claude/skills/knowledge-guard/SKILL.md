---
name: knowledge-guard
description: ナレッジ配線(src/search, src/lib/knowledge, gap検出, 索引同期)の機械ガードだけを --maxWorkers=1 で実行する。フルjestは並列実行時にEADDRNOTAVAIL(一時ポート枯渇)で不安定なため、噛み確認の前にこのスキルで絞り込む。
version: 1.0.0
---

# Knowledge Guard

ナレッジ配線是正の各PRで、噛み確認の前にこのスキルを実行する。
フルの `pnpm test` は並列実行時に一時ポート枯渇(EADDRNOTAVAIL)で不安定なため、
機械ガード(ソース文字列を検査するテスト)だけを `--maxWorkers=1` で絞り込んで回す。

## 対象テストファイル

```bash
pnpm test -- --maxWorkers=1 \
  src/search/excludedIds.test.ts \
  src/search/pgvectorSearchVisibility.test.ts \
  src/search/faqIndexUnify.test.ts \
  src/lib/knowledge/faqIndexSync.test.ts \
  src/api/admin/agent/confirmPolicy.test.ts \
  src/api/admin/analytics/schemaHealth.test.ts
```

新しく追加した機械ガード(例: 5引数 `upsertFaqToEs` 呼び出し禁止のソース走査テスト)は、
このリストに追記する。

## 何を検査しているか

| ファイル | 検査内容 |
|---|---|
| `excludedIds.test.ts` | `FAQ_VISIBILITY_JOIN` / `WHERE` のエイリアスが `fe`/`fd` 固定であること(テンプレート化されていないこと) |
| `pgvectorSearchVisibility.test.ts` | 可視性述語が `pgvectorSearch.ts` で実際に使われていること |
| `faqIndexUnify.test.ts` | 索引同期ヘルパの単一実装性 |
| `faqIndexSync.test.ts` | `faqIndexSync.ts` 各関数の挙動 |
| `confirmPolicy.test.ts` | 書き込みツールが確認ゲートに分類されていること(未分類は失敗) |
| `schemaHealth.test.ts` | `REQUIRED_COLUMNS` が実際の `INSERT INTO` とソース走査で完全一致していること |

## 使い方

1. ナレッジ配線のPRを実装したら、まずこのスキルを実行する
2. 全て green を確認してから、タスクの「噛み確認」手順(意図的に壊して赤くなることを確認)に進む
3. 噛み確認が終わったら元に戻し、再度このスキルで green を確認する
4. 最終確認は `pnpm typecheck && pnpm test -- --maxWorkers=1`(フル)で行う。
   このスキルはフルテストの代替ではなく、開発中の高速フィードバック用

## 噛み確認での使い方

対象コードを一時的に壊して、このスキルのテストが赤くなることを実測する:

```bash
# 例: is_excluded_from_search の引き継ぎを外す
# → confirmPolicy.test.ts または faqIndexSync.test.ts が赤くなることを確認
pnpm test -- --maxWorkers=1 -t "<関連テスト名>"
```

`-t` で自分が書いたテストに絞り込む。既存の flaky テストに埋もれないようにする。
