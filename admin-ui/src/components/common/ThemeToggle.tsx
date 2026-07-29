// admin-ui/src/components/common/ThemeToggle.tsx
// 元々 AppSidebar.tsx にインライン定義されていたテーマ切替を共有コンポーネント化。
// 旧UI(AppSidebar)・新UI(/copilot-preview)の両方から使う。移設のみでスタイル・
// ロジックは一切変更していない(旧UIの見た目・挙動を変えないため)。

import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  const options: { value: "light" | "dark" | "system"; icon: React.ElementType; label: string }[] = [
    { value: "light", icon: Sun, label: "ライト" },
    { value: "dark", icon: Moon, label: "ダーク" },
    { value: "system", icon: Monitor, label: "自動" },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        background: "var(--sidebar-accent)",
        borderRadius: "var(--radius-md)",
        padding: 2,
      }}
    >
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          title={label}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: "calc(var(--radius-md) - 2px)",
            border: "none",
            background: theme === value ? "var(--background)" : "transparent",
            color: theme === value ? "var(--foreground)" : "var(--muted-foreground)",
            cursor: "pointer",
            boxShadow: theme === value ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
            transition: "all 0.15s",
          }}
        >
          <Icon size={14} />
        </button>
      ))}
    </div>
  );
}
