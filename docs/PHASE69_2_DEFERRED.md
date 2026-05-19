# Phase69-2 スコープアウト・積み残し

## 1. tenants.default_excluded_ids — ロード未実装

### 現状

`src/migrations/phase69_2_excluded_ids.sql` で以下のカラムを追加済み：

```sql
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_excluded_ids TEXT[] DEFAULT '{}';
```

ただし、このカラムを**ロードして検索に合流させるコードは未実装**。

### 現在の動作（2層構成）

| レイヤー | 実装済み | 説明 |
|---|---|---|
| per-call excluded_ids | ✅ | APIリクエスト単位で渡す除外ID。agentDialogRoute → … → rerank まで全段伝播 |
| is_excluded_from_search フラグ | ✅ | DB（faq_docs / faq_embeddings）の列。pgvector SQL WHERE句でフィルタ |
| tenants.default_excluded_ids 合流 | ❌ 未実装 | テナントデフォルト除外IDをロードして per-call IDs にマージする処理 |

### 計画（Phase69-2.5 / Phase70 で実装）

1. `src/agent/orchestrator/ragRetrieval.ts` でテナントレコードを取得
2. `default_excluded_ids` を `initialInput.excludedIds` にマージ（重複除去）
3. Admin UI に「テナントデフォルト除外ID」管理画面を追加（下記 #2 参照）

---

## 2. Admin UI — テナントデフォルト除外ID管理画面

### 現状

`KnowledgeFaqEditModal.tsx` のナレッジ個別編集に「検索から除外」トグルは実装済み。
ただし、テナント全体のデフォルト除外IDを管理するUIは**スコープアウト**。

### 計画（Phase69-2.5 / Phase70 で実装）

- テナント設定画面（`admin-ui/src/components/TenantSettings*.tsx` 周辺）に
  `default_excluded_ids` のリスト表示 + 追加/削除UIを追加
- 入力バリデーション：各要素200文字以内、最大500件

---

## 3. 理由・背景

- Phase69-2 の主目的はper-call excluded_ids の3層伝播とUIトグルであり、テナントデフォルトはPhase69-2のスコープ外
- DB スキーマ（カラム）だけ先行追加しておき、ロジックは次フェーズで追加するのが最小リスク
- テナントデフォルト除外IDが不要なテナントには影響ゼロ

---

*作成: Phase69-2 実装時 (2026-05-12)*
