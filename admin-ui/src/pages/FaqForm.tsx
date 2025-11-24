// admin-ui/src/pages/FaqForm.tsx
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

type Mode = "create" | "edit";

type Props = {
  mode: Mode;
};

type Faq = {
  id: number;
  tenant_id: string;
  question: string;
  answer: string;
  category: string | null;
  tags: string[];
  is_published: boolean;
};

export default function FaqForm({ mode }: Props) {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();

  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [category, setCategory] = useState("");
  const [isPublished, setIsPublished] = useState(true);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 編集モードのときは既存 FAQ を取得
  useEffect(() => {
    if (mode !== "edit") return;

    if (!id) {
      navigate("/faqs", { replace: true });
      return;
    }

    const raw = localStorage.getItem("supabaseSession");
    if (!raw) {
      navigate("/login", { replace: true });
      return;
    }

    let accessToken: string | null = null;
    try {
      const session = JSON.parse(raw);
      accessToken = session?.access_token ?? null;
    } catch {
      localStorage.removeItem("supabaseSession");
      navigate("/login", { replace: true });
      return;
    }

    if (!accessToken) {
      navigate("/login", { replace: true });
      return;
    }

    const fetchFaq = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(
          `http://localhost:3100/admin/faqs/${id}?tenantId=demo`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );

        if (!res.ok) {
          const text = await res.text();
          throw new Error(
            `Failed to fetch FAQ: ${res.status} ${res.statusText} ${text}`
          );
        }

        const faq: Faq = await res.json();

        setQuestion(faq.question);
        setAnswer(faq.answer);
        setCategory(faq.category ?? "");
        setIsPublished(faq.is_published);
      } catch (err: any) {
        console.error("[FaqForm] fetch error", err);
        setError(err.message ?? "Failed to load FAQ");
      } finally {
        setLoading(false);
      }
    };

    fetchFaq();
  }, [mode, id, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const raw = localStorage.getItem("supabaseSession");
    if (!raw) {
      navigate("/login", { replace: true });
      return;
    }

    let accessToken: string | null = null;
    try {
      const session = JSON.parse(raw);
      accessToken = session?.access_token ?? null;
    } catch {
      localStorage.removeItem("supabaseSession");
      navigate("/login", { replace: true });
      return;
    }

    if (!accessToken) {
      navigate("/login", { replace: true });
      return;
    }

    try {
      setSaving(true);
      setError(null);

      const payload = {
        question,
        answer,
        category: category || null,
        is_published: isPublished,
      };

      let res: Response;

      if (mode === "create") {
        res = await fetch("http://localhost:3100/admin/faqs?tenantId=demo", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
      } else {
        if (!id) throw new Error("Missing FAQ id");
        res = await fetch(
          `http://localhost:3100/admin/faqs/${id}?tenantId=demo`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          }
        );
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Failed to save FAQ: ${res.status} ${res.statusText} ${text}`
        );
      }

      // 保存できたら一覧へ戻る
      navigate("/faqs");
    } catch (err: any) {
      console.error("[FaqForm] save error", err);
      setError(err.message ?? "Failed to save FAQ");
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "create" ? "FAQ 新規作成" : "FAQ 編集";

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
        Loading...
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#020617",
        color: "#e5e7eb",
        padding: "24px 32px",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
        }}
      >
        <h1 style={{ fontSize: 24, fontWeight: 600 }}>{title}</h1>
        <button
          onClick={() => navigate("/faqs")}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            border: "1px solid #4b5563",
            background: "transparent",
            color: "#e5e7eb",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          一覧に戻る
        </button>
      </header>

      <form
        onSubmit={handleSubmit}
        style={{
          maxWidth: 720,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {error && (
          <div
            style={{
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

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14 }}>質問</span>
          <input
            required
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "#020617",
              color: "#e5e7eb",
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14 }}>回答</span>
          <textarea
            required
            rows={6}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "#020617",
              color: "#e5e7eb",
              resize: "vertical",
            }}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 14 }}>カテゴリ</span>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="shipping など（空でも可）"
            style={{
              padding: "8px 10px",
              borderRadius: 8,
              border: "1px solid #374151",
              background: "#020617",
              color: "#e5e7eb",
            }}
          />
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 14,
          }}
        >
          <input
            type="checkbox"
            checked={isPublished}
            onChange={(e) => setIsPublished(e.target.checked)}
          />
          <span>公開する</span>
        </label>

        <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              padding: "10px 14px",
              borderRadius: 999,
              border: "none",
              background: saving ? "#4b5563" : "#22c55e",
              color: "#020617",
              fontWeight: 600,
              cursor: saving ? "default" : "pointer",
            }}
          >
            {saving ? "Saving..." : "保存"}
          </button>

          <button
            type="button"
            onClick={() => navigate("/faqs")}
            style={{
              padding: "10px 14px",
              borderRadius: 999,
              border: "1px solid #4b5563",
              background: "transparent",
              color: "#e5e7eb",
              cursor: "pointer",
            }}
          >
            キャンセル
          </button>
        </div>
      </form>
    </div>
  );
}
