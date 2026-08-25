// admin-ui/src/components/markdown/AgentMarkdown.tsx
// AIエージェントの発話を描画する唯一のMarkdownコンポーネント。
//
// なぜ新規ファイルにするか: 描画箇所は現状 copilot-preview/index.tsx と
// components/AdminAgent/AdminAgentMessage.tsx の2箇所があり、今後も増える見込み。
// 各所で pre-wrap を個別に書き換える方式だと3面目で再発するため、1箇所に閉じる。
//
// LLMの出力は信頼できない入力として扱う。安全性は次の3点で担保している。
//   1. rehype-raw を入れない  … 生HTMLがDOM要素として実行されない
//   2. skipHtml を渡す        … 生HTMLを「文字として表示する」ことすらしない
//      (react-markdown は常に allowDangerousHtml:true で remark-rehype を呼び、
//       skipHtml が無いと raw ノードを text ノードに変換して画面に出す。
//       つまり rehype-raw を入れないだけでは <br> が文字として残る。実測確認済み)
//   3. img を描画しない       … 外部URLへの自動リクエスト(トラッキング画素・IP漏洩)を防ぐ
// URLのサニタイズは react-markdown 既定の urlTransform に依存している
// (javascript:/data: 等は空文字に潰される)。urlTransform を上書きしないこと。
// ユーザー自身の発話はこのコンポーネントに通さないこと(呼び出し側の責務)。
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// コード・表ヘッダの地色。呼び出し側のバブル背景(copilot-preview は var(--muted)、
// パネル面は var(--card))と必ず差がつくよう、CSS変数ではなく中間グレーの半透明を使う。
// 明るい地では暗く、暗い地では明るく転ぶため、どちらのテーマ・どちらの面でも沈まない。
// var(--muted) を使うと copilot-preview のAIバブルと同色になり完全に溶ける(実測)。
const CODE_BG = "rgba(127,127,127,0.22)";
const CODE_BORDER = "rgba(127,127,127,0.35)";

const components: Components = {
  h1: ({ children }) => (
    <h1 style={{ fontSize: 20, fontWeight: 700, margin: "12px 0 6px", color: "var(--foreground)" }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 18, fontWeight: 700, margin: "12px 0 6px", color: "var(--foreground)" }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 16, fontWeight: 700, margin: "10px 0 4px", color: "var(--foreground)" }}>{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 style={{ fontSize: 15, fontWeight: 700, margin: "10px 0 4px", color: "var(--foreground)" }}>{children}</h4>
  ),
  // Markdownはソフト改行(単一の\n)を<br>にしないが、\n自体はテキストノードに残る。
  // pre-line で改行として見せる(remark-breaks を足さずに済む)。これが無いと
  // オンボ初回挨拶(copilot-preview/index.tsx:379)のような \n 入りの発話が1行に潰れる。
  p: ({ children }) => <p style={{ margin: "4px 0", lineHeight: 1.7, whiteSpace: "pre-line" }}>{children}</p>,
  strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del style={{ opacity: 0.7 }}>{children}</del>,
  ul: ({ children }) => <ul style={{ margin: "4px 0", paddingLeft: 22, lineHeight: 1.7 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: "4px 0", paddingLeft: 22, lineHeight: 1.7 }}>{children}</ol>,
  li: ({ children }) => <li style={{ whiteSpace: "pre-line" }}>{children}</li>,
  // href が空 = react-markdown の urlTransform が危険なスキーム(javascript: 等)を
  // 潰した後。アンカーのまま出すと「押せるのに現在の画面が新タブで開くだけ」の
  // 偽リンクになり、本物と見分けがつかない。素のテキストとして出す。
  a: ({ children, href }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
        {children}
      </a>
    ) : (
      <>{children}</>
    ),
  blockquote: ({ children }) => (
    <blockquote
      style={{ margin: "6px 0", padding: "2px 12px", borderLeft: "3px solid var(--border)", color: "var(--muted-foreground)" }}
    >
      {children}
    </blockquote>
  ),
  // インラインコードとコードブロックの<code>はどちらもこのcomponentを通る
  // (react-markdown v9以降、code componentに inline フラグは渡されなくなった)。
  // fenceの言語指定(```js)がある場合は className="language-js" が付く。
  // 言語指定が無いfenceは className が付かないため、改行の有無で判別する
  // (インラインコードは1行に収まる前提)。
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
    if (isBlock) {
      return <code style={{ fontFamily: "monospace", fontSize: "0.9em" }}>{children}</code>;
    }
    return (
      <code style={{ background: CODE_BG, border: `1px solid ${CODE_BORDER}`, borderRadius: 4, padding: "1px 5px", fontSize: "0.9em", fontFamily: "monospace" }}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre style={{ background: CODE_BG, border: `1px solid ${CODE_BORDER}`, borderRadius: 8, padding: "10px 12px", overflowX: "auto", margin: "6px 0" }}>
      {children}
    </pre>
  ),
  // 表はチャット幅からはみ出させない。表だけ横スクロールのコンテナに入れる。
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "6px 0" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.95em" }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ border: "1px solid var(--border)", padding: "6px 10px", textAlign: "left", background: CODE_BG }}>
      {children}
    </th>
  ),
  td: ({ children }) => <td style={{ border: "1px solid var(--border)", padding: "6px 10px" }}>{children}</td>,
  // 画像は描画しない。エージェントの返答はテナントの知識・PDF抽出・エンド顧客の
  // 発話をそのまま引用することがあり、そこに紛れ込んだ画像URLを描画すると
  // 管理者のブラウザが第三者へ自動リクエストを出す(IP・UA・閲覧時刻の漏洩、
  // 開封トラッキング)。admin-ui に CSP は無いため描画側で止める。
  img: ({ alt }) => <span style={{ opacity: 0.7 }}>{alt ? `[画像: ${alt}]` : "[画像]"}</span>,
};

export default function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
      {content}
    </ReactMarkdown>
  );
}
