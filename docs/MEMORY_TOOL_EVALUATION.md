# Anthropic Memory Tool 評価レポート — R2C チャットウィジェット

> 作成: 2026-05-18
> 対象 API: `memory_20250818` (beta header: `context-management-2025-06-27`)
> 評価者: R2C Phase1 Step-F Team Agent T3
> Asana GID: 1214891874822899

---

## Section 1: 機能仕様

### 1.1 Memory Tool 概要

Anthropic Memory Tool (`memory_20250818`) は Claude モデルに永続的な外部記憶を提供するベータ機能。
2025-08 に公開、有効化には API リクエストに `anthropic-beta: context-management-2025-06-27` ヘッダーが必要。

**重要**: Memory Tool は**クライアントサイド**実装。Anthropic サーバー側にデータを保存するのではなく、
Claude がツールコールを発行し、開発者のインフラ（ファイルシステム・DB・クラウドストレージ等）で
実際の読み書きを実行する設計。

| 操作 | 説明 |
|---|---|
| `view` | `/memories` ディレクトリ内のファイル一覧・内容確認 |
| `create` | 新規メモリファイルを作成 |
| `str_replace` | 既存メモリファイルの特定箇所を更新 |
| `insert` | メモリファイルに行を挿入 |
| `delete` | メモリファイルを削除 |
| `rename` | メモリファイルをリネーム |

**ストレージ構造（クライアント管理）:**
```
/memories/               # 開発者インフラ上の任意パス
  {tenant_id}/           # テナント単位（開発者がネームスペース設計）
    {user_id}/
      preferences.md
      session_summary.md
      faq_patterns.md
```

**動作フロー:**
1. Claude API コール時に `betaMemoryTool` を tools リストに渡す
2. Claude が会話中に `memory` ツールコールを発行
3. 開発者アプリが tool_use コールバックを実装し、実際のストレージ操作を実行
4. tool_result を Claude に返す → Claude が記憶内容を踏まえて応答生成

**トークンコスト:**
- 84% トークン削減効果を Anthropic が報告（拡張ワークフロー比較）
- メモリ読み取り: ファイルサイズに依存（不要な re-load を回避できるため総コスト削減）
- 書き込み: 通常のツールコール相当（~500 tokens/操作）

**対応モデル:**
- Claude Sonnet 4.5, Sonnet 4, Haiku 4.5, Opus 4.1, Opus 4

**ZDR (Zero Data Retention) との関係:**
- データはクライアントインフラで管理されるため、ZDR 制約は開発者側の実装に依存
- Anthropic サーバー側への個人情報保存は発生しない（クライアントサイド設計のため）

### 1.2 ベータ制限事項
- 2026-05 時点でベータ段階（全アカウント公開済み）
- API ヘッダー `anthropic-beta: context-management-2025-06-27` が必須
- Python: `BetaAbstractMemoryTool` サブクラス、TypeScript: `betaMemoryTool` 使用
- メモリストレージの永続化・スケーリングは開発者責任
- `context editing` と組み合わせると長期ワークフローでの context 溢れを防止可能

---

## Section 2: R2C 既存 RAG との重複検証

### 2.1 R2C の RAG スタック

| コンポーネント | 役割 | 配置 |
|---|---|---|
| Elasticsearch | キーワード検索 + BM25 | VPS (`ES_URL` 環境変数) |
| pgvector | セマンティック検索 | Supabase PostgreSQL |
| Cross-encoder (CE) | Rerank | ローカル (`CE_MODEL_PATH`) |
| Groq 20B/120B | 回答生成 | 外部 API |
| Supabase `chat_histories` | 会話履歴永続化 | Supabase PostgreSQL |

### 2.2 重複・競合分析

| 観点 | R2C 既存 RAG | Memory Tool | 重複度 |
|---|---|---|---|
| 書籍・商品情報検索 | ✅ pgvector + ES (Phase47) | ❌ 非対応（構造化コンテンツ不向き） | 低 |
| ユーザー会話履歴 | ✅ Supabase `chat_histories` テーブル | ⚠️ セッション要約をファイル保存で補完可能 | 中 |
| テナント設定 | ✅ DB `tenants` テーブル + 4層セキュリティ | ⚠️ 設定キャッシュとして利用可能（RLS 保証は開発者実装） | 中 |
| FAQ パターン学習 | ⚠️ Judge (Phase45) → tuning rules | ✅ 会話パターン・ユーザー選好の軽量蓄積に適 | 低〜中 |
| セッション間コンテキスト | ❌ 未実装（毎回フル再ロード） | ✅ セッション要約をメモリ化 → 次回トークン削減 | **なし（補完関係）** |

**結論**: 書籍 RAG / 商品検索には重複なし。会話履歴は補完関係（Supabase は全履歴保存、Memory Tool は要約・選好の軽量キャッシュ）。最大の付加価値は「セッション間コンテキスト継続」という R2C 未実装領域。

### 2.3 既存セキュリティスタックとの整合性

R2C の 4 層セキュリティスタック（`src/index.ts`）は以下の順で適用される:
1. `requestIdMiddleware` → 2. `securityHeadersMiddleware` → 3. `express.json`
4. `corsMiddleware` → 5. `rateLimiter` → 6. `authMiddleware`
7. `tenantContextLoader` → 8. `securityPolicyEnforcer`

Memory Tool のコールバック実装は `authMiddleware` / `tenantContextLoader` 通過後のコンテキストで
実行されるため、既存スタックとの整合性は確保しやすい。ただし、メモリファイルパスの
テナント分離は追加実装が必須（詳細は Section 3）。

---

## Section 3: テナント分離 サーバーサイド実装案

### 3.1 テナント分離の必要性

R2C のセキュリティ原則「tenantId は JWT から取得、body 禁止」に従い、
Memory Tool のファイルパスを `{tenantId}/{userId}/{filename}` でネームスペース化する。
パストラバーサル攻撃（`../`）対策も必須。

### 3.2 実装案（Express API 側）

```typescript
// src/memory/memoryBackend.ts （案）
import path from "node:path";
import fs from "node:fs/promises";

const MEMORY_BASE_DIR = process.env.MEMORY_BASE_DIR ?? "/var/r2c/memories";

// テナント分離パス生成（tenantId は JWT から取得済みの前提）
function buildMemoryPath(
  tenantId: string,
  userId: string,
  filename: string
): string {
  // path.join + resolve でパストラバーサル防止
  const safeTenantId = tenantId.replace(/[^a-z0-9_-]/gi, "");
  const safeUserId = userId.replace(/[^a-z0-9_-]/gi, "");
  const safeFilename = path.basename(filename); // ".." 排除
  return path.resolve(
    MEMORY_BASE_DIR,
    safeTenantId,
    safeUserId,
    safeFilename
  );
}

// Memory Tool コールバック実装例
export async function handleMemoryToolCall(
  tenantId: string, // 必ず req.tenantId から取得（JWT ベース）
  userId: string,
  toolInput: { command: string; path?: string; new_str?: string }
): Promise<string> {
  const filePath = buildMemoryPath(
    tenantId,
    userId,
    toolInput.path ?? "default.md"
  );

  switch (toolInput.command) {
    case "view":
      return await fs.readFile(filePath, "utf-8").catch(() => "");
    case "create":
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, toolInput.new_str ?? "");
      return "created";
    case "delete":
      await fs.unlink(filePath).catch(() => {});
      return "deleted";
    default:
      throw new Error(`Unsupported memory command: ${toolInput.command}`);
  }
}
```

### 3.3 セキュリティ考慮事項

- `tenantId` は必ず JWT から取得（`req.tenantId`）— body 渡し禁止（Anti-Slop 規定）
- Memory ファイルパスに PII（メール・氏名）を含めない（`userId` は UUID 使用）
- メモリファイル内容に書籍コンテンツを保存しない（ragExcerpt.slice(0,200) 同等ルール適用）
- ファイルサイズ上限を設ける（例: 10KB/user）— 無制限書き込みによる disk exhaustion 防止
- テナント削除時: `{tenantId}/` ディレクトリを再帰削除（テナントオフボーディング手順に追加要）
- `MEMORY_BASE_DIR` は環境変数で外部化、VPS の `/var/r2c/memories` に配置

---

## Section 4: A/B/C ユースケース — コスト vs 効果マトリクス

| ユースケース | 概要 | Token/月 (推定) | 効果 | 優先度 |
|---|---|---|---|---|
| A: ユーザー選好記憶 | 「配送方法の好み」「返品理由パターン」をユーザー単位で記憶 | ~50,000 tok ($0.15) | ★★★ パーソナライズ向上 | **高** |
| B: チューニングルール記憶 | Judge (Phase45) が検出した FAQ ギャップをメモリに蓄積 → 次回 RAG に反映 | ~20,000 tok ($0.06) | ★★ Gap 検出精度向上 | 中 |
| C: セッション要約記憶 | 長会話のサマリーをメモリに保存 → 次セッションで再利用 | ~80,000 tok 削減 ($-0.24) | ★★★ トークンコスト削減 | **高**（Supabase 補完） |

**コスト計算基準**: Claude Sonnet 4.6, input $3/MTok (クライアントサイドのため追加 API コスト最小)
**注**: クライアントサイド実装のため Memory Tool 自体の API 料金は発生しない。コストはファイル I/O のみ。

### 4.1 ユースケース A 詳細（最優先）

```
1. ユーザーが FAQ ウィジェットで購入/返品の相談
2. /api/chat エンドポイントが会話を処理（tenantId: JWT から取得）
3. 会話終了 or ターン完了時: Claude が memory tool コール
   → preferences.md に「コンビニ払い選好」「サイズ M 常用」等を書き込み
4. 次回セッション開始時: preferences.md を読み込み → システムプロンプトに注入
5. 回答パーソナライズ: 「前回もコンビニ払いでしたね。今回もそちらで手配しますか？」
```

### 4.2 ユースケース C 詳細（トークン削減効果大）

```
既存課題: Phase22 State Machine で clarify → answer → confirm を繰り返す長会話
          → 毎ターン全履歴を context に含めるため token 急増

Memory Tool 導入後:
  - 5 ターン経過 or context 80% 到達時点で Claude が session_summary.md を更新
  - 古い tool_result を context editing で削除
  - 次セッション冒頭で session_summary.md を読み込み → 84% トークン削減（Anthropic 実績値）
```

---

## Section 5: 採否判断 + Phase70+ 計画案

### 5.1 採否判断

**判定: ✅ 条件付き採用（PoC から開始可能 — 2026 Q3）**

クライアントサイド実装であることが判明し、ZDR/プライバシー上の懸念は大幅に軽減。
ただし、ファイルシステム管理・テナント分離実装・VPS ストレージ設計が追加コストとなる。

| 採用条件 | 状態 |
|---|---|
| ベータ → 一般公開 | ✅ ベータ公開済み（全アカウント利用可能） |
| テナント分離の実装可能性 | ✅ ファイルパスネームスペースで実現可能 |
| ZDR リスク | ✅ クライアントサイドのため Anthropic サーバーへの PII 保存なし |
| 月次コスト増加 | ✅ API 追加料金なし（ファイル I/O のみ） |
| VPS ストレージ容量 | ⚠️ Hetzner VPS の disk 使用量要確認（/var/r2c/memories） |

**即時採用への残課題:**
1. `betaMemoryTool` TypeScript SDK の実装工数（推定 2-3 日）
2. VPS `/var/r2c/memories` ディレクトリのバックアップ設計
3. ファイルサイズ上限・ TTL（有効期限）ポリシーの策定
4. 日本個人情報保護法との適合性確認（userId = UUID を使用すれば問題最小化）

**見送り不要の理由（当初懸念の解消）:**
- ~~「ベータ段階でプロダクション採用リスク」~~ → PoC 段階での試験的採用は問題なし
- ~~「ZDR 非対応で個人情報リスク」~~ → クライアントサイド設計のため Anthropic 側にデータ送信なし
- ~~「既存 Supabase と重複」~~ → 補完関係（全履歴 vs 要約・選好）

### 5.2 Phase70+ 計画案（2026 Q3〜）

```
Phase 70: Memory Tool PoC（2026 Q3）
  目標:
    - ユースケース A (ユーザー選好) を carnation テナントで 2 週間試験
    - ユースケース C (セッション要約) でトークンコスト削減計測
  実装範囲:
    - src/memory/memoryBackend.ts（ファイルシステム実装）
    - /api/chat ルートへの betaMemoryTool 統合
    - 管理スクリプト: SCRIPTS/r2c-memory-cleanup.sh（TTL 超過ファイル削除）
  Gate:
    - Memory 使用率 > 30% かつ CSAT +0.2 以上
    - トークン削減率 > 30%（Anthropic 実績値 84% の保守推定）

Phase 71: Memory Tool 本番化（2026 Q4）
  実装範囲:
    - テナントオフボーディング手順に memory ディレクトリ削除を追加
    - Admin UI: 記憶内容の閲覧・削除 UI（/v1/admin/memory/* エンドポイント）
    - モニタリング: Prometheus メトリクス
      - memory_files_total{tenant_id} — テナント別ファイル数
      - memory_storage_bytes{tenant_id} — ストレージ使用量
      - memory_tool_calls_total{operation} — 操作別コール数
    - VPS バックアップ: /var/r2c/memories を週次 rsync
```

### 5.3 アクションアイテム

- [ ] Phase 70 を Asana に起票（担当: hkobayashi、期限: 2026-06-30）
- [ ] VPS Hetzner の空き disk 容量確認（`df -h` on 65.108.159.161）
- [ ] `betaMemoryTool` TypeScript 型定義の最新 SDK バージョン確認（`@anthropic-ai/sdk`）
- [ ] carnation テナント管理者への PoC 説明・同意取得
- [ ] memory ファイルの TTL ポリシー策定（推奨: 90 日間未アクセスで自動削除）

---

## 参考リンク

- [Memory tool - Claude API Docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Managing context on the Claude Developer Platform](https://www.anthropic.com/news/context-management)
- [Anthropic's Managed Agents memory](https://usewire.io/blog/anthropic-managed-agents-memory-context-engineering/)
- [Claude API Memory Tool Guide](https://thomas-wiegold.com/blog/claude-api-memory-tool-guide/)
