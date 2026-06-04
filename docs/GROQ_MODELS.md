# Groq モデルカタログ 保守ガイド

PR #243 で導入した `src/config/groqModels.ts` の運用・保守手順をまとめたリファレンス。

---

## アクティブモデル一覧

| 定数名 | モデル ID | 用途 |
|---|---|---|
| `GROQ_INSTANT_8B` | `llama-3.1-8b-instant` | 低レイテンシ・シンプルな応答 |
| `GROQ_VERSATILE_70B` | `llama-3.3-70b-versatile` | 汎用・複雑な推論 |
| `GROQ_COMPOUND` | `groq/compound` | Groq compound（フル） |
| `GROQ_COMPOUND_MINI` | `groq/compound-mini` | Groq compound（軽量） / Embedding |
| `GPT_OSS_20B` | `openai/gpt-oss-20b` | gpt-oss 20B（Groq 経由）通常呼び出し |
| `GPT_OSS_120B` | `openai/gpt-oss-120b` | gpt-oss 120B（Groq 経由）複雑クエリ・safety（≤10%） |

> CLAUDE.md Anti-Slop ルール: 120B モデルは **複雑クエリ / safety 時のみ**、比率は **≤10%** に抑えること。

---

## 新モデルを採用する手順

1. `src/config/groqModels.ts` の定数ブロックに `export const GROQ_XXX = 'actual-model-id';` を追加
2. `ACTIVE_GROQ_MODELS` 配列に `{ id: GROQ_XXX, tier: '...', status: 'active' }` エントリを追加
3. 呼び出し箇所では文字列リテラルではなく定数を import して使用する
4. `src/config/groqModels.test.ts` の回帰テストが自動的にカバー（ID 重複チェック、active 状態チェック）

```typescript
// src/config/groqModels.ts に追加する例
export const GROQ_NEW_MODEL = 'llama-4-xxx';

// ACTIVE_GROQ_MODELS に追加
{ id: GROQ_NEW_MODEL, tier: 'versatile', status: 'active' },
```

---

## モデルを廃止（EOL）する手順

1. Groq の deprecation 告知（[console.groq.com/docs/deprecations](https://console.groq.com/docs/deprecations)）を確認
2. `src/config/groqModels.ts` の `KNOWN_DEPRECATED_GROQ_MODELS` に廃止モデルの ID を追記
   - コメントで移行先を明記する（例: `// → llama-3.3-70b-versatile に移行済み`）
3. `SCRIPTS/check-groq-models.sh`（EOL 検知層）を手動実行して移行漏れを確認する

```bash
bash SCRIPTS/check-groq-models.sh
# PASS — no deprecated Groq model IDs in src.  ← これが出るまで移行を続ける
```

4. PASS 後に `ACTIVE_GROQ_MODELS` から該当エントリを削除し、呼び出し元の定数参照を新モデルに差し替える
5. 旧定数（`export const GROQ_OLD = ...`）も削除する

---

## EOL 検知層の仕組み

```
KNOWN_DEPRECATED_GROQ_MODELS（groqModels.ts）
  └── SCRIPTS/check-groq-models.sh が src/ (非 test) を走査
        └── SCRIPTS/security-scan.sh の [7] Groq EOL model check として組み込み済み
              └── Gate 2 (bash SCRIPTS/security-scan.sh) で CI を落とす
```

- 検知スクリプトは `check-groq-models.sh` の自己テストで FAIL 検出を確認済み
- `src/config/groqModels.ts` 自身と `*.test.ts` ファイルは走査対象から除外される

---

## 関連ファイル

| ファイル | 役割 |
|---|---|
| `src/config/groqModels.ts` | モデル ID 定数・アクティブレジストリ・EOL ヘルパー（単一の真実） |
| `src/config/groqModels.test.ts` | カタログ整合性テスト（ID 重複・active 状態・EOL 非混入） |
| `SCRIPTS/check-groq-models.sh` | EOL 検知スクリプト（CI / Gate 2 から呼ばれる） |
| `SCRIPTS/security-scan.sh` | セキュリティスキャン統合（[7] Groq EOL model check を含む） |
| `src/types/contracts.ts` | `GroqModel` 型 union（カタログ由来） |
| `src/lib/posthog/llmAnalyticsTracker.ts` | `COST_PER_1K` コストマップ（カタログ由来） |
