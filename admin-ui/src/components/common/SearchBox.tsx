// admin-ui/src/components/common/SearchBox.tsx
// Phase52b: 検索ボックス共通コンポーネント（300msデバウンス）

import { useState, useEffect, useRef } from "react";

interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function SearchBox({ value, onChange, placeholder = "検索..." }: SearchBoxProps) {
  const [localValue, setLocalValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setLocalValue(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onChange(v), 300);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <input
      type="text"
      value={localValue}
      onChange={handleChange}
      placeholder={placeholder}
      style={{
        padding: "8px 14px",
        minHeight: 38,
        borderRadius: 10,
        border: "1px solid #374151",
        background: "rgba(15,23,42,0.8)",
        color: "#e5e7eb",
        fontSize: 13,
        outline: "none",
        minWidth: 180,
        flex: 1,
      }}
    />
  );
}
