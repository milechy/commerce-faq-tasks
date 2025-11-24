// admin-ui/src/pages/FaqList.tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

type Faq = {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[];
  is_published: boolean;
  created_at: string;
  updated_at: string;
};

type ApiResponse = {
  items: Faq[];
  pagination: {
    limit: number;
    offset: number;
    count: number;
  };
};

export default function FaqList() {
  const navigate = useNavigate();

  const [faqs, setFaqs] = useState<Faq[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // フィルタ系
  const [search, setSearch] = useState("");
  const [showOnlyPublished, setShowOnlyPublished] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const getAccessToken = (): string | null => {
    const raw = localStorage.getItem("supabaseSession");
    if (!raw) return null;
    try {
      const session = JSON.parse(raw);
      return session?.access_token ?? null;
    } catch {
      localStorage.removeItem("supabaseSession");
      return null;
    }
  };

  // FAQ 一覧取得
  useEffect(() => {
    const accessToken = getAccessToken();
    if (!accessToken) {
      navigate("/login", { replace: true });
      return;
    }

    const fetchFaqs = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(
          "http://localhost:3100/admin/faqs?tenantId=demo&limit=50&offset=0",
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (res.status === 401 || res.status === 403) {
          localStorage.removeItem("supabaseSession");
          navigate("/login", { replace: true });
          return;
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Failed to fetch FAQs: ${res.status} ${res.statusText} ${text}`
          );
        }

        const data: ApiResponse = await res.json();
        const sorted = [...data.items].sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        setFaqs(sorted);
      } catch (err: any) {
        console.error("[FaqList] fetch error", err);
        setError(err.message ?? "Failed to load FAQs");
      } finally {
        setLoading(false);
      }
    };

    fetchFaqs();
  }, [navigate]);

  // 削除
  const handleDelete = async (faq: Faq) => {
    const ok = window.confirm(
      `本当にこの FAQ を削除しますか？\n\n[${faq.question}]`
    );
    if (!ok) return;

    const accessToken = getAccessToken();
    if (!accessToken) {
      navigate("/login", { replace: true });
      return;
    }

    try {
      const res = await fetch(
        `http://localhost:3100/admin/faqs/${faq.id}?tenantId=demo`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (res.status === 401 || res.status === 403) {
        localStorage.removeItem("supabaseSession");
        navigate("/login", { replace: true });
        return;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Failed to delete FAQ: ${res.status} ${res.statusText} ${text}`
        );
      }

      setFaqs((prev) => prev.filter((f) => f.id !== faq.id));
    } catch (err: any) {
      console.error("[FaqList] delete error", err);
      alert(err.message ?? "Failed to delete FAQ");
    }
  };

  // カテゴリ一覧（select 用）を動的に生成
  const categories: string[] = Array.from(
    new Set(
      faqs
        .map((f) => f.category)
        .filter((c): c is string => !!c && c.trim().length > 0)
    )
  ).sort();

  // フィルタリング
  const filteredFaqs = faqs.filter((faq) => {
    if (showOnlyPublished && !faq.is_published) return false;

    if (categoryFilter !== "all") {
      const c = faq.category ?? "";
      if (c !== categoryFilter) return false;
    }

    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      faq.question.toLowerCase().includes(q) ||
      faq.answer.toLowerCase().includes(q) ||
      (faq.category ?? "").toLowerCase().includes(q)
    );
  });

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#020617",
          color: "#e5e7eb",
        }}
      >
        Loading FAQs...
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(circle at top, #0f172a 0, #020617 55%, #000 100%)",
        color: "#e5e7eb",
        padding: "24px 32px",
      }}
    >
      {/* ヘッダー */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 999,
              background: "rgba(15,23,42,0.9)",
              border: "1px solid #1f2937",
              fontSize: 11,
              color: "#9ca3af",
              marginBottom: 6,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "999px",
                background: "#22c55e",
              }}
            />
            tenant: demo
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 600 }}>
            FAQ 管理ダッシュボード
          </h1>
          <p style={{ fontSize: 13, color: "#9ca3af", marginTop: 4 }}>
            Supabase ログイン済みのユーザー向け FAQ 管理画面です。
          </p>
        </div>

        <button
          onClick={() => navigate("/faqs/new")}
          style={{
            padding: "10px 16px",
            borderRadius: 999,
            border: "none",
            background:
              "linear-gradient(135deg, #22c55e 0%, #4ade80 50%, #22c55e 100%)",
            color: "#022c22",
            fontWeight: 600,
            cursor: "pointer",
            fontSize: 14,
            boxShadow: "0 10px 30px rgba(34,197,94,0.25)",
          }}
        >
          ＋ 新規 FAQ
        </button>
      </header>

      {/* フィルタバー */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <input
          type="text"
          placeholder="キーワードで検索（質問 / 回答 / カテゴリ）"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: 220,
            padding: "8px 10px",
            borderRadius: 999,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.9)",
            color: "#e5e7eb",
            fontSize: 13,
          }}
        />

        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          style={{
            padding: "8px 10px",
            borderRadius: 999,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.9)",
            color: "#e5e7eb",
            fontSize: 13,
          }}
        >
          <option value="all">すべてのカテゴリ</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            padding: "6px 10px",
            borderRadius: 999,
            border: "1px solid #374151",
            background: "rgba(15,23,42,0.9)",
          }}
        >
          <input
            type="checkbox"
            checked={showOnlyPublished}
            onChange={(e) => setShowOnlyPublished(e.target.checked)}
          />
          公開のみ
        </label>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            borderRadius: 12,
            background: "#451a1a",
            color: "#fecaca",
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      {/* 一覧カード */}
      <div
        style={{
          borderRadius: 18,
          border: "1px solid #1f2937",
          background:
            "linear-gradient(145deg, rgba(15,23,42,0.95), rgba(15,23,42,0.7))",
          overflow: "hidden",
          boxShadow: "0 18px 45px rgba(0,0,0,0.45)",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "3fr 1.2fr 1.2fr 1.5fr",
            padding: "10px 16px",
            fontSize: 12,
            color: "#9ca3af",
            borderBottom: "1px solid #1f2937",
            background:
              "linear-gradient(90deg, rgba(15,23,42,0.9), rgba(15,23,42,0.6))",
          }}
        >
          <div>質問</div>
          <div>カテゴリ</div>
          <div>公開状態</div>
          <div style={{ textAlign: "right" }}>操作</div>
        </div>

        {filteredFaqs.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              fontSize: 13,
              color: "#9ca3af",
            }}
          >
            該当する FAQ がありません。
          </div>
        ) : (
          filteredFaqs.map((faq, index) => (
            <div
              key={faq.id}
              style={{
                display: "grid",
                gridTemplateColumns: "3fr 1.2fr 1.2fr 1.5fr",
                padding: "12px 16px",
                fontSize: 14,
                borderBottom:
                  index === filteredFaqs.length - 1
                    ? "none"
                    : "1px solid #111827",
                alignItems: "center",
                background:
                  index % 2 === 0 ? "rgba(15,23,42,0.9)" : "rgba(15,23,42,0.8)",
                transition: "background 0.15s ease, transform 0.08s ease",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  "rgba(30,64,175,0.35)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background =
                  index % 2 === 0 ? "rgba(15,23,42,0.9)" : "rgba(15,23,42,0.8)";
              }}
            >
              <div>
                <div
                  style={{
                    fontWeight: 500,
                    marginBottom: 4,
                    cursor: "pointer",
                  }}
                  onClick={() => navigate(`/faqs/${faq.id}/edit`)}
                >
                  {faq.question}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "#9ca3af",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: "100%",
                  }}
                >
                  {faq.answer}
                </div>
              </div>

              <div style={{ fontSize: 12, color: "#e5e7eb" }}>
                {faq.category || <span style={{ color: "#6b7280" }}>-</span>}
              </div>

              <div>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 10px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 500,
                    background: faq.is_published ? "#064e3b" : "#1f2937",
                    color: faq.is_published ? "#bbf7d0" : "#e5e7eb",
                    border: faq.is_published
                      ? "1px solid rgba(74,222,128,0.5)"
                      : "1px solid #374151",
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "999px",
                      background: faq.is_published ? "#4ade80" : "#6b7280",
                    }}
                  />
                  {faq.is_published ? "公開中" : "下書き"}
                </span>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                }}
              >
                <button
                  onClick={() => navigate(`/faqs/${faq.id}/edit`)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "1px solid #4b5563",
                    background: "transparent",
                    color: "#e5e7eb",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  編集
                </button>
                <button
                  onClick={() => handleDelete(faq)}
                  style={{
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "1px solid #7f1d1d",
                    background: "transparent",
                    color: "#fecaca",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  削除
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
