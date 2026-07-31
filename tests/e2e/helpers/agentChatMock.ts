// Asana 1217080508665459: /copilot-preview の起動時ブリーフィングは、
// テナントのオンボーディングが未完了(firstConversation:false 等)だと
// nextStep を出して return し、agent/chat への POST 自体が発生しない
// (admin-ui/src/pages/copilot-preview/index.tsx:947-950)。
// この事情を知らずに「1回目の agent/chat 呼び出し = 起動時ブリーフィング」と
// 回数で決め打つと、オンボーディング未完了のテナントでは1回目がユーザーの
// 最初の送信メッセージになり、意図しないブリーフィング応答を受け取ってしまう。
// 回数ではなく BOOTSTRAP_PROMPT の内容で判定することで、この分岐の有無に
// 依存しないモックにする。
const BOOTSTRAP_PROMPT_MARKER = 'ログインしたところです';

export function isBootstrapMessage(message: string | undefined): boolean {
  return typeof message === 'string' && message.includes(BOOTSTRAP_PROMPT_MARKER);
}
