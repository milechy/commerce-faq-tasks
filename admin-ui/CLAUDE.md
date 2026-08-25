# admin-ui（管理画面フロントエンド）

## スコープと面の関係
- `/copilot-preview`（`src/pages/copilot-preview/`）は **テナント(client_admin)専用**のチャット・ファースト画面。将来の既定画面＝**主面**。
- 同じAPIを叩く面がもう1つある: パネル `src/components/AdminAgent/`（旧UI上に浮くFAB）。**パネルは機能凍結**。新機能を足さない。最後の旧UIページが閉じた時点で削除する。
- 旧UI `src/pages/admin/*` は **super_admin の運用面として残り続ける**。目標は「テナント向けページを閉じる」であって「旧UIを無くす」ではない。
- **機能をチャットへ持ち込むときは、まず表現形式を決める** — `docs/COPILOT_UI_PARITY.md` §3 の T1 状態カード / T2 選択一覧 / T3 候補カード / T4 要約+可視化。「ツールを足すか旧UIへ handoff するか」をその場で決めない（原則が無いまま個別判断を重ねたことが、旧UI機能16件の取りこぼしを生んだ）。
- 決定の履歴: `docs/CHAT_SURFACE_DECISION.md` / `docs/LEGACY_UI_SUNSET.md` / `docs/COPILOT_UI_PARITY.md` / `docs/CHAT_HISTORY_CATEGORY_REQUIREMENTS.md`

## ディレクトリ方針
- **新規ファイルを作ってよいのは「2面が共有する必要があり、既存 `src/lib/` に該当が無い」場合のみ。**
  前例: `lib/useAgentChatTransport.ts`(transport) / `lib/chatSessionStore.ts`(永続化) / `lib/feedbackReplies.ts` / `components/common/ThemeToggle.tsx`
- 2面で共有する層（transport・IME判定・永続化・PDF受付ルール）は**必ず `lib/` の既存実装を使う**。手書きコピーを作らない。
- `copilot-preview/index.tsx` は肥大しているが、`components/agentChat/` への分解は**別タスク**（複数PR規模）。ついでに始めない。
- **カードは型（T1状態 / T2選択 / T4サマリー）ごとに汎用化する。機能ごとに専用の `Card.kind` を増やさない。** `Card` union は既に20種近く、`index.tsx` は3000行超。素朴に足し続けると維持できなくなる。
- **旧UI の `pages/admin/*` のコンポーネントをそのまま import しない。** `isSuperAdmin` をpropsや内部分岐で内包しているものが多く（`AvatarSettingsSection` / `FlowFunnelSection` 等）、持ち込むと禁止事項1に抵触する。共有するなら描画に必要な純粋部分だけを切り出す。

## 絶対にやってはいけないこと
1. **`/copilot-preview` に super_admin 専用機能を足す。** テナント専用UI。過去に誤追加した11ツールを撤去した経緯がある（PR #507）。判断に迷ったら旧UI側の `isSuperAdmin` ガードを確認する。
2. **パネル（`components/AdminAgent/`）に新機能を足す。** 機能凍結。共有層のバグ修正は対象外（それはやる）。
3. **IME/Enter 判定を手書きする。** `lib/utils.ts` の `shouldSubmitOnEnter()` のみ。この重複は過去に13日間の実バグを産んでいる。
4. **`chatSessionStore` のキーを1本化する。** 2面のメッセージ型に共通部分が無く、単一キーにすると**例外を出さずに壊れたスレッドが描画される**（理由はファイル冒頭のコメント）。
5. **会話ログ本文を `sessionStorage` に載せる。** 顧客名・電話番号が最大50件残る。`localStorage` を避けた理由が本文経由で無効化される。
6. **旧UIの `Route` を削除する。** catch-all で旧ダッシュボードに落ちる。閉じるなら明示 `Navigate`。
7. **`admin-ui/src` の変更を auto-merge に載せる。** Tier S = hkobayashi 手動マージ。「auto-merge待ち」と報告しない。
8. **書籍/PDFナレッジの投入導線をテナント面に広げない。**（2026-07-31決定：書籍PDFはR2C運用限定。抜粋200字の著作権保護がR2C管理前提のため）
   注意: **現状コードは方針と逆を向いている** — `copilot-preview` のD&D/📎と旧UIのPDFタブにロール判定が無い。是正は**削除ではなくロール条件による不可視化**で行う。
9. **`card` を `text` の置き換えにする。** card は**追加**であって置き換えではない。card 非対応クライアント（パネル）でも自然文だけで意味が通ること。**T4の可視化カードで最も破りやすい** — グラフを描いて本文が「グラフをご覧ください」になったら契約違反。
10. **プラン上限・利用上限を反射的に足す。** R2Cは従量課金で、外部API利用はテナント請求。守るのは `trackUsage` 計上と**費用の事前明示**であって、上限やゲートではない。
11. **旧UIの `Route` を削除する**（既出6の再掲だが頻出）。旧UIのクローズは計測窓（4週）の経過後の別判断であり、機能をチャットに足したことは閉じてよい理由にならない。

## 設計上の約束
- **認可の判断をフロントに持たせない。** `targetTenantId` は `previewMode && previewTenantId` のときだけ送る（`useAgentChatTransport` が導出済み）。実効テナントの決定はサーバ。
- 並列取得は `Promise.allSettled`。片方の失敗が他方を巻き込まない（バッジ取得の既存パターン）。
- 構造化カード（`card`）が来ていればそれを描画し、無ければ自然文の正規表現パースにフォールバックする既存の順序を保つ。
- カードを追加したら**3層すべて**を通す（サーバ `*CardPayload` → `lib/useAgentChatTransport.ts` の `*AgentActionCard` → `index.tsx` の `a.card?.kind === "..."` 分岐）。**1層でも漏れると型は通るのに何も描画されない**（`cardPayloadSync.test.ts` が検出する）。
- **設定を変える前に、必ず現在の状態を見せる。** 店主の要求はほぼ全て「変えたい」より「合っているか確かめたい」が先にある。提示なしに切り替わる経路を作らない。
- **集合を変える前に、対象の件数と実例を見せる。** 会話には画面のような「今見えているもの」が無い。恐いのは操作ではなく範囲の取り違え。絞り込みを変えたら対象を再提示してから確定する。
- **取り返しのつかない操作は、GUIのモーダル以上の確認密度を持たせる。** チャットは「はい」の一言で確定してしまい、心理的コストがGUIより低い。
- **Mobile First** — 390px を先に確認。タップ44px、フォント16px、横スクロールなし。レールは `@media (max-width: 767px)` でドロワー化する既存実装を変えない。

## テストで最低限（vitest / happy-dom、`authFetch` と `useAuth` を `vi.mock`）
- **既存テストは書き換えて通す。** 挙動を変えたテストを削除して回避しない。
- 送信の検証は**プロンプト文字列の固定ではなく `authFetch` に渡った body**（`message` / `surface` / `sessionId` / `targetTenantId`）で行う。
- **新規APIを作っていないこと**をURL一覧で固定する既存テストがある。増やす場合はその意図を壊さない。
- 確認チップ: 書き込み系がブロックされたとき同意チップが出て、**同意なしに実行されない**こと。
- 復元: リロード・ブラウザバック・ログアウト時の会話の扱い。**未確定の一括操作が確定済みとして復元されない**こと。
- 390px でのレイアウト崩れ。**グラフ・一覧カードが横スクロールを起こさない**こと。
- 失敗系が必ず `status="failed"` 等で確定し、**無限スピナーを残さない**こと（アップロード・生成系）。
- テストは既存の `index.test.tsx` に追記する。**挙動を変えたテストを削除して回避しない。**

## 命名・エラーハンドリング
- `Card.kind` は camelCase（`agentAction`, `pdfUpload`）。**サーバ側は snake_case** で非対称だが、統一のために両側を触らない。
- **同じ値が面によって違って見えてはならない。** ツールの日本語ラベル・`answered_from` の3値・Judgeスコアの閾値(80/60)と4軸ラベルは、旧UI・パネルと同一の語彙を使う。
- エラー文言は定数を使う（`AGENT_CHAT_ERROR_MESSAGE` / `AGENT_CHAT_AUTH_REQUIRED_MESSAGE`）。新しいハードコードを作らない。技術的詳細を画面に出さず、**次の行動**（時間をおく／ログインする）を伝える。
- **失敗を黙って成功にしない。** 送信中フラグは失敗時も必ず解除する。
- `sessionStorage` 無効・クォータ超過・壊れたJSONは例外を投げず「無かったこと」として続行する。
- コメントは日本語で **「なぜ」** を書く。特に**意図的な逸脱**は書き忘れと区別できる形で理由を残す（模範: `lib/chatSessionStore.ts` 冒頭）。
