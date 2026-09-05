// shopify-app/app/src/components/NotConnectedBanner.tsx
//
// 未接続/未設定時の案内(FR-10)。過度な通知を避け、この1箇所に限定する
// (App.tsx はこのコンポーネントを同時に複数出さない設計にしている)。

export function NotConnectedBanner({ message }: { message: string }) {
  return (
    <div className="r2c-banner" role="status">
      <p>{message}</p>
    </div>
  );
}
