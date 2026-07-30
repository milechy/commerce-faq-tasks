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
// ため、面ごとのキーを引数で受け取る形にしてこのファイルへ切り出している(片方の会話が
// もう片方を上書きしないため)。2面で sessionId 自体を共有するか(=キーを1本にするか)は
// チャット面の統合方針の決定待ちのため、ここでは面ごとに独立させている
// (docs/CHAT_SURFACE_DECISION.md §5)。

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
    };
    window.sessionStorage.setItem(chatSessionKey(surface), JSON.stringify(payload));
  } catch {
    // sessionStorage無効環境(プライベートブラウズ等)・クォータ超過では静かに無視
  }
}

export function restoreChatSession<TMessage>(surface: string): StoredChatSession<TMessage> | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.sessionStorage.getItem(chatSessionKey(surface));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChatSession<TMessage>>;
    if (typeof parsed.sessionId !== "string" || !Array.isArray(parsed.messages)) return null;
    return {
      sessionId: parsed.sessionId,
      messages: parsed.messages,
      history: Array.isArray(parsed.history) ? parsed.history : [],
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
