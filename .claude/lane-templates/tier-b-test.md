# Lane Template: Tier B — Unit Test 追加

## 推奨モデル: Sonnet 4.6（複雑なら Opus 4.8）

既存の **prod モジュールに unit test を追加**するタスク用テンプレ。
**対象モジュール本体は変更しない**（挙動不変・テストだけ追加）。テストファイルは
`*.test.ts`（= pr-risk-scorer の LOW パターン）なので **Tier B / auto-merge OK**。

---

## Step 0: 必読（省略禁止 — 鉄則 8）

```bash
cat CLAUDE.md
cat .claude/rules/anti-slop.md 2>/dev/null
```

そして **対象モジュールと、近い既存テストの書き方** を必ず読む:

```bash
cat <対象モジュールのパス>                       # テスト対象を理解する
ls src/**/*.test.ts | head                        # 既存テストの場所/命名を確認
cat src/search/faqIndexUnify.test.ts 2>/dev/null  # 純粋ロジックのテスト例
```

タスク notes に「対象モジュール」と「カバーすべき観点」が書いてある。必ず踏まえる。

---

## このタスクでやること

1. notes 指定の **対象モジュール 1つ** に対し、`<module>.test.ts`（co-located）を新規作成
   または既存テストにケース追加。
2. **正常系 + 境界値 + 異常系** を最低各1つ。pure 関数なら入出力、分岐網羅を意識。
3. 外部依存（DB / fetch / Groq / Gemini / Supabase / ES 等）は **必ずモック**
   （`jest.fn()` / `jest.mock()`）。ネットワーク・実 DB に触れない。
4. テストは **意味のある assertion** を書く（`expect(true).toBe(true)` 等の空テスト禁止）。

---

## Tier 判定（着手前と Gate 直前の2回）

```bash
git diff --name-only main...HEAD
```

| 変更ファイル | 可否 |
|---|---|
| `*.test.ts`（非 HIGH ディレクトリ）のみ | ✅ このテンプレ継続（Tier B） |
| 対象モジュール本体（非 test の `.ts`）を変更した | ❌ 挙動を変えた可能性 → 差し戻し。テストのみに戻す |
| `src/middleware/**`, `src/api/auth*`, `src/agent/security/**` 配下に test を置いた | ⚠️ そこは HIGH 扱い → auto-merge されない。notes 指定の非 HIGH モジュールに限定すること |

**対象モジュール本体は絶対に編集しない。** テストのために export を増やす必要がある場合は、
その時点で Team Lead に差し戻す（勝手に本体 API を変えない）。

---

## Gate（実装完了後・必ず実行して結果を報告）

```bash
# typecheck（テスト対象＋テストの型整合）
npx tsc -p tsconfig.json --noEmit
# 追加した test だけ実行して green を確認
npx jest <追加した .test.ts のパス> --runInBand
# lint baseline を超えないこと（テストファイルは src 配下なら対象）
npx oxlint src admin-ui/src --max-warnings 63
```

報告フォーマット:
```
## Gate 1
- typecheck: 0 errors
- test: N passed（追加 M 件）
- lint: pass（max-warnings 63 以内）
```

- Gate 1.5 dead-code: 該当なし（テスト追加のみ）
- Gate 2 security-scan: 該当なし（機密混入のみ目視）
- Gate 2.5 Codex: **skip 可**（test code only）→ commit に `(skip Gate 2.5: test only)`
- Gate 3 build: 該当なし

---

## Acceptance Criteria（DoD）

- [ ] 変更が `*.test.ts` のみ（`git diff --name-only main...HEAD` で確認）
- [ ] 対象モジュール本体は未変更（挙動不変）
- [ ] `npx jest <testfile>` が green、typecheck 0 errors、lint baseline 以内
- [ ] 正常系 + 境界 + 異常系を含む意味のある assertion
- [ ] 外部依存はモック（ネットワーク・実 DB 不使用）
- [ ] commit `test(<scope>): <要約> (skip Gate 2.5: test only)`（Co-Authored-By 含む）

---

## 一切しないこと

- 対象モジュール本体（非 test ファイル）の編集
- `src/`(本体), `admin-ui/`, `SCRIPTS/`, `.env*`, `package.json`, lockfile への変更
- HIGH ディレクトリ（`src/middleware/`, `src/api/auth*`, `src/agent/security/`）への test 配置
- 空テスト・スナップショット乱用・到達不能なモック
- main への直接 commit / push
- "no diff" 報告
- **auto-merge の手動 enable**（自前 auto-merge workflow が green を見て自動でマージする。
  Lane は PR を出すところまで。`gh pr merge` は実行しない）

---

## 最終アクション

1. `git add <test files>`（個別指定。`git add -A` 禁止）
2. `git status` で他ファイル混入なし確認
3. `git commit -m "test(<scope>): <要約> (skip Gate 2.5: test only)"`（Co-Authored-By 行を含める）
4. `git push -u origin feature/<asana-gid>-<short-description>`
5. `gh pr create --title "test(<scope>): <要約>" --body "<DoD checklist + Asana GID>"`
6. **PR を出したら完了**。auto-merge workflow が CI green を見て自動マージする（Lane は merge しない）。
7. PR URL + 追加テスト件数を 1 行で報告

---

## 24h ループ共通ガード（CLAUDE.md「24h ループ安定性ガード」準拠）

- **並列上限**: 同時稼働 Lane 最大 3 本 / 1 セッション内の並列 tool call も 3 本未満。
- **CI 待ち（無限待ち禁止）**: `gh run watch` で無限待ちせず最大 **20 分** deadline ループ。超過したら
  `bash SCRIPTS/notify-slack.sh "⚠️ CI 20分超過、人間確認へ" --color warning` で通知して次へ。
- **context 断絶時**: `previous_message_not_found` 検知 → 状態を `MEMORY.md` に記録 → Lane 終了 → 再 dispatch。
