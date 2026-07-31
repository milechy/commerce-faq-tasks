// admin-ui/src/lib/chatSessionStore.ts
// チャットの会話(メッセージ列・sessionId・直近の履歴ウィンドウ)をタブ単位で永続化するストア。
// 会話状態がReactのuseStateだけに置かれているため、リロード・ブラウザバック・モバイルでの
// タブ破棄のたびに会話が丸ごと消えていた。日常的に使う画面としては致命的なので、
// 同一タブのセッション内は復元できるようにする。
//
// localStorageではなくsessionStorageを使う理由: 会話には顧客名・電話番号などの個人情報が
// 載りうる。localStorageは共有端末・キオスク端末で次の利用者にそのまま残ってしまうため、
// タブを閉じれば消えるsessionStorageに限定する。加えて、ログアウト時にも明示的に消す
// (auth/useAuth.tsx の logout。多層防御)。
//
// パネル(components/AdminAgent/)と全画面(pages/copilot-preview/)の2面が同じ実装を共有する
// ため、面ごとのキーを引数で受け取る形にしてこのファイルへ切り出している。
//
// 【キーが面ごとに分かれている理由 — 意図的な決定であり、書き忘れではない】
// docs/CHAT_SURFACE_DECISION.md §5 は「共有ストア1本・ユーザー単位キー」と書いているが、
// メッセージ列については現状それが成立しない。2面の保持するメッセージ型に共通部分が無いため:
//   - パネル:   AgentMessage { role: "user" | "assistant"; content; actions?; ... }
//   - 全画面:   Msg         { id: number; role: "ai" | "me"; text?; card?; chips?; ... }
// role の語彙も本文のフィールド名(content / text)も別物で、Msg は数値 id を必須とする。
// さらに下の restoreChatSession は sessionId が文字列か・messages が配列かだけを見て
// 1件ごとの形は検証しない。したがってキーを1本にすると、他面が書いた会話が
// 「復元成功」として通ってしまい、本文が空・左右が逆・React の key が全て undefined の
// 壊れたスレッドが描画される(例外は出ないので気付けない)。
// 2面は同時に描画されないが(App.tsx の早期 return)、旧UIページから /copilot-preview へ
// SPA遷移するとパネルは unmount され、その後に全画面が同じキーを読む。同時ではなく
// 順番に上書きし合う経路なので、同時描画されないことは理由にならない。
// キー自体が面を表すため、会話に surface を併記する必要も無い。
//
// 単一キーにするには先にメッセージ表現の共通化(§4 の (a-2): copilot-preview/index.tsx を
// components/agentChat/ へ分解する複数PR規模の作業)が必要で、それが単一キー化の前提条件。
// この分離で塞がらない穴(sessionId を共有しないことによる knowledgeImportStaging の
// 孤児化)は docs/CHAT_SURFACE_DECISION.md 「§5 補記」に既知の未解決事項として記録済み。

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

// メッセージの型は面ごとに異なる(全画面はカード・チップ付き、パネルは role/content のみ)ため
// ジェネリックにし、このストアは中身を解釈せずそのまま往復させる。
export interface StoredChatSession<TMessage> {
  sessionId: string;
  messages: TMessage[];
  // サーバへ送る直近履歴のウィンドウ。パネル側は送信時に messages から組み立てるため持たない。
  history?: ChatHistoryEntry[];
  // この会話が属するテナント(super_adminのプレビュー切替でテナントが変わりうる面のみ設定)。
  // 復元時にこの値が現在のテナントと一致しない場合は、別テナントの会話として拒否する
  // (キーが surface のみでテナントを区別しないため、検証しないと別テナントの会話が
  // 「復元成功」として通ってしまう — GID: super_adminのテナント切替バグ参照)。
  tenantId?: string | null;
}

// sessionStorageのクォータを圧迫しないよう、保存するメッセージ数に上限を設ける
// (超過分は古いものから捨てる)。
export const MAX_PERSISTED_MESSAGES = 50;

export const CHAT_SESSION_SURFACE_FULLSCREEN = "copilot-preview";
export const CHAT_SESSION_SURFACE_PANEL = "admin-agent-panel";

export function chatSessionKey(surface: string): string {
  return `r2c_chat_session_${surface}`;
}

export function saveChatSession<TMessage>(surface: string, session: StoredChatSession<TMessage>): void {
  try {
    if (typeof window === "undefined") return;
    const payload: StoredChatSession<TMessage> = {
      sessionId: session.sessionId,
      messages: session.messages.slice(-MAX_PERSISTED_MESSAGES),
      history: session.history,
      tenantId: session.tenantId,
    };
    window.sessionStorage.setItem(chatSessionKey(surface), JSON.stringify(payload));
  } catch {
    // sessionStorage無効環境(プライベートブラウズ等)・クォータ超過では静かに無視
  }
}

/**
 * @param currentTenantId 呼び出し元が把握している「現在のテナント」。省略した場合はテナント
 *   検証をスキップする(テナント概念を持たない呼び出しとの後方互換)。渡した場合、保存時の
 *   tenantId と一致しなければ別テナントの会話とみなし null を返す(復元しない)。
 *   tenantId を持たない旧形式の保存データ(この検証を追加する前に保存されたもの)も、
 *   currentTenantId を渡された場合は不一致として扱い破棄する(安全側に倒す)。
 */
export function restoreChatSession<TMessage>(
  surface: string,
  currentTenantId?: string | null,
): StoredChatSession<TMessage> | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(chatSessionKey(surface));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChatSession<TMessage>>;
    if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.messages)) return null;
    if (currentTenantId !== undefined && parsed.tenantId !== currentTenantId) return null;
    return {
      sessionId: parsed.sessionId,
      messages: parsed.messages,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      tenantId: parsed.tenantId,
    };
  } catch {
    // 壊れたJSON・sessionStorage無効環境。会話が無かったものとして扱う(例外は投げない)
    return null;
  }
}

export function clearChatSession(surface: string): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.removeItem(chatSessionKey(surface));
  } catch {
    // 同上
  }
}
