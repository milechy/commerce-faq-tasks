---
name: knowledge
description: R2C ナレッジ配線の不変ルール — 読み側の可視性述語、書き込み経路の実数、索引同期の正典
version: 1.0.0
paths:
  - "src/search/**"
  - "src/lib/knowledge/**"
  - "src/api/admin/knowledge/**"
  - "src/api/admin/knowledge-gaps/**"
  - "src/agent/gap/**"
  - "src/agent/tools/synthesisTool.ts"
  - "src/agent/flow/searchAgent.ts"
  - "src/agent/tools/searchTool.ts"
  - "src/admin/http/faqAdminRoutes.ts"
  - "src/lib/book-pipeline/**"
  - "src/lib/ocrPipeline.ts"
  - "src/agent/knowledge/**"
  - "src/agent/memory/**"
  - "src/agent/config/ragLimits.ts"
  - "src/agent/psychology/**"
  - "config/bookStructurizerPrompt.md"
---

# ナレッジ配線ルール

2026-08-25 の配線監査(4系統並列調査 + 本番 .env 実測)で確定した事実。
再調査せず、ここを一次情報として実装する。

## 読み側: 可視性述語は1箇所だけ

`src/search/pgvector.ts` の `FAQ_VISIBILITY_JOIN` / `FAQ_VISIBILITY_WHERE` が唯一の実装。
`src/search/pgvectorSearch.ts` がこれを import して使う(2実装ではなく1実装の共有)。

- エイリアスは `fe`(faq_embeddings)/ `fd`(faq_docs)に固定する。
  `excludedIds.test.ts` が本ファイルの SQL 文字列をそのまま検査するため、
  テンプレート化・引数化すると機械的ガードが空振りする。
- `faq_id` を持つ行(`metadata->>'faq_id'` が数値)は `faq_docs.is_published` に従う。
- `faq_id` を持たない行(book / OCR / learned_memory 由来)は公開判定の対象外で、
  常に検索される。書籍知識を非公開にする手段は現状 `is_excluded_from_search` のみ。
- global 知識の実体は `tenant_id = 'global'` / `'r2c_docs'`。
  `faq_docs.is_global` 列は読み手も書き手もない死列(削除予定)。

## 書き込み経路は「4系統」ではなく10系統ある

CLAUDE.md の禁止6 が挙げる4系統(`faqCrudRoutes` / レガシー `faqAdminRoutes` /
`knowledge-gaps/add-knowledge` / `actionExecutor`)は実装の一部にすぎない。
実際には以下も含めて10系統が faq_docs / faq_embeddings / ES のいずれかに書く:

1. `src/api/admin/knowledge/faqCrudRoutes.ts` — 正典。CRUD 全て
2. `src/admin/http/faqAdminRoutes.ts` — レガシー admin
3. `src/lib/knowledge/faqImport.ts` — text/scrape commit
4. `src/api/admin/knowledge-gaps/routes.ts` — gap→FAQ
5. `src/api/admin/agent/actionExecutor.ts` — チャットツール群
6. `src/api/admin/knowledge/bookPdfRoutes.ts` — 書籍PDF管理
7. `src/lib/book-pipeline/embedAndStore.ts` — 書籍チャンク投入(faq_docs 無し)
8. `src/agent/knowledge/bookStructurizer.ts` — 書籍構造化(faq_docs 無し)
9. `src/lib/ocrPipeline.ts` — OCR取込(faq_docs 無し)
10. `SCRIPTS/` の seed/offline スクリプト群

**5系統目・11系統目を増やさない。** 新しい書き込みが必要になったときは、
既存のどれかに機能を足すか、正典ヘルパ(下記)を呼ぶ形にする。

## 索引同期の正典は faqIndexSync.ts

`src/lib/knowledge/faqIndexSync.ts` が embedding + ES 同期の唯一の共有実装。

- ES doc id は `faqEsDocId(tenantId, faqId)` で決定的に導出する。
  `faq_docs.es_doc_id` 列は常にNULLで一度も埋まらない死列(削除予定)。
  この列に依存した削除ガードは実質的に無効化される。
- `upsertFaqToEs` / `upsertToEsAsync` は**必ず6引数で呼ぶ**。
  5引数で呼ぶと `is_excluded_from_search` が渡らず、通常の編集のたびに
  ES 側の検索除外フラグが false へ黙って巻き戻る(2026-08-25 に発見・一部修正)。
- 削除は `deleteFaqFromEs(tenantId, faqId)` を必ず呼ぶ。faq_docs / faq_embeddings だけを
  消して ES を残すと、削除したはずのFAQが BM25 経由で回答に出続ける。
- 書籍/OCR チャンクは faq_docs 行を持たないため、上記ヘルパの対象外。
  削除・除外の手段が経路ごとに異なる(bookPdfRoutes は pgvector 行のみ削除、ES は残る)。

## アバターは知識経路を通す(CLAUDE.md 91-93行は陳腐化)

lemonslice 経由のアバターは `/api/chat` の回答を TTS するだけで、RAG・tuning_rules を
経由した回答をそのまま読み上げる(`avatar-agent/agent.py` に LLM 呼び出しは無い)。
知識を通さないのは Anam の `chat-stream` 経路のみで、既定で503封鎖されている。
「アバターに知識連動を足す」提案が出たら、まず `/api/chat` 側を疑う(禁止46)。

## 3層モデル(事実 / 方針 / 文体)を混ぜない

| 層 | 役割 |
|---|---|
| FAQ / 知識データ(RAG) | 事実の単一情報源 |
| `tuning_rules.expected_behavior` | 方針(どう振る舞うか) |
| `tuning_rules.approved_responses` | 文体・言い回しの見本(逐語コピー強制ではない) |

検索0件でも tuning_rules が一致すれば LLM は呼ばれる。このとき **事実の主張をさせない**。
`expected_behavior` は内部の方針文であり、顧客向けの文面としてそのまま返してはならない。

## 学習ループの点火は「フラグが両方ONに見えても交差ゼロ」がありうる

`JUDGE_SWEEP_TENANTS`(既定 `r2c_default`)と `LEARNED_MEMORY_TENANTS` は独立した allowlist。
両方が「有効」と表示されていても、対象テナントの交差が空なら learned_memory は永久に0件になる。
点火状態を確認するときは、個別のフラグではなく交差を見る。

## 生産者と消費者が別のリテラルを持たない

2026-08-29、心理学原則の注入経路で3件の継ぎ目バグが見つかった。いずれも「書く側」と
「読む側」が同じ値・同じキー名を独立に持っており、一方だけ変更されて他方が追随して
いなかった:

- `principleDetector.ts` の語彙(`KEYWORD_MAP`)と `bookStructurizerPrompt.md` の
  few-shot例が独立に原則名を持ち、「返報性」と「返報性の原理」のように揺れていた
  (`principleSearch.ts` は完全一致検索のため永久にヒットしない)
- `bookStructurizer.ts` が metadata に書くキーと `principleSearch.ts` が読むキーが
  一致していなかった(`example` が書かれず常に空文字)
- `bookStructurizer.ts` の `page_hint` と `bookPdfRoutes.ts` の `page_number` が
  同じ値を指す別名で、結合できていなかった

各ファイルの単体テストは自分で「理想の行」を用意しており、生産側が実際に何を書くかを
見ないため、この種のバグを検出できない。**原則名の語彙は `principleVocabulary.ts`
1箇所を出どころにし**(`principleDetector.ts`・`bookStructurizer.ts`・
`bookStructurizerPrompt.md` の3箇所はすべてここを参照する)、**metadataのキー名は
`principleContract.test.ts` がソース走査で生産側・消費側を突き合わせる**。
新しい生産者・消費者ペアを追加するときは、ここにモックではなくソース走査の契約テストを足す。
