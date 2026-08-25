// admin-ui/src/components/common/SectionErrorBoundary.tsx
//
// 1セクションのレンダーエラーがページ全体を落とすのを防ぐ(P0-1, GID 1217808384631918)。
//
// admin-ui/index.html には window の error イベントを拾って #root ごと
// "起動エラー" 画面に差し替えるグローバルフォールバックがある。React の
// レンダー中の例外(componentDidCatch で捕まえない限り)はこのグローバル
// ハンドラまで伝播するため、1セクションのバグでダッシュボード全体が
// 消える(実例: FlowFunnelSection のレスポンス契約ドリフトで本番が全損)。
//
// React の Error Boundary はクラスコンポーネントでしか実装できない
// (componentDidCatch はフックに存在しない)。このファイルだけクラスに
// なるのはその制約のためで、他に理由はない。
import { Component, type ReactNode } from "react";

interface Props {
  /** エラー時に表示する見出し。省略時は共通文言。 */
  sectionLabel?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class SectionErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error("[SectionErrorBoundary]", this.props.sectionLabel, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          role="alert"
          style={{
            marginTop: 32,
            padding: "18px 20px",
            borderRadius: 12,
            background: "var(--destructive-surface)",
            border: "1px solid var(--destructive-border)",
            color: "var(--destructive)",
            fontSize: 14,
          }}
        >
          {this.props.sectionLabel ? `${this.props.sectionLabel}の表示に失敗しました。` : "この項目の表示に失敗しました。"}
          他の項目は通常どおりご利用いただけます。
        </div>
      );
    }
    return this.props.children;
  }
}
