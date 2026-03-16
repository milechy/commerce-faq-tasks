import { useCallback, useEffect, useRef, useState } from "react";
import FileUpload from "../admin/FileUpload";
import { useLang } from "../../i18n/LangContext";
import { useAuth } from "../../auth/useAuth";
import { API_BASE } from "../../lib/api";
import GlobalKnowledgeCheckbox from "./GlobalKnowledgeCheckbox";
import {
  type BookMetadata,
  type OcrJobStatus,
  fetchWithAuth,
  CARD_STYLE,
} from "./shared";

export default function PdfUploadSection({ tenantId }: { tenantId: string }) {
  const { t } = useLang();
  const { isSuperAdmin } = useAuth();
  const [isGlobal, setIsGlobal] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<OcrJobStatus | null>(null);
  const [books, setBooks] = useState<BookMetadata[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBooks = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge?tenant=${tenantId}`);
      if (!res.ok) return;
      const data = (await res.json()) as { items?: unknown[]; count?: number };
      setBooks((data.items ?? []) as BookMetadata[]);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => { fetchBooks(); }, [fetchBooks]);

  useEffect(() => {
    if (!currentJobId) return;
    const poll = async () => {
      try {
        const res = await fetchWithAuth(`${API_BASE}/v1/admin/knowledge/jobs/${currentJobId}`);
        if (!res.ok) return;
        const data = (await res.json()) as OcrJobStatus;
        setJobStatus(data);
        if (data.status === "done" || data.status === "failed") {
          if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
          setCurrentJobId(null);
          if (data.status === "done") fetchBooks();
        }
      } catch {
        // ignore
      }
    };
    void poll();
    pollingRef.current = setInterval(() => void poll(), 10_000);
    return () => { if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; } };
  }, [currentJobId, fetchBooks]);

  const uploadEndpoint = isGlobal
    ? `/v1/admin/knowledge/pdf?tenant=${tenantId}&target=global`
    : `/v1/admin/knowledge/pdf?tenant=${tenantId}`;

  return (
    <div style={{ ...CARD_STYLE, marginBottom: 24 }}>
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "#9ca3af", margin: "0 0 12px" }}>
        {t("knowledge.pdf_title")}
      </h3>
      {isSuperAdmin && (
        <GlobalKnowledgeCheckbox isGlobal={isGlobal} onChange={setIsGlobal} />
      )}
      <FileUpload
        uploadEndpoint={uploadEndpoint}
        onUploadSuccess={(name) => { setUploadSuccess(name); setTimeout(() => setUploadSuccess(null), 5000); }}
        onUploadResponse={(data) => {
          const d = data as { jobId?: string } | null;
          if (d?.jobId) { setJobStatus({ status: "processing" }); setCurrentJobId(d.jobId); }
        }}
      />
      {uploadSuccess && (
        <div style={{ marginTop: 10, padding: "12px 16px", borderRadius: 10, background: "rgba(5,46,22,0.5)", border: "1px solid rgba(74,222,128,0.3)", color: "#86efac", fontSize: 14 }}>
          {t("knowledge.pdf_accepted", { name: uploadSuccess })}
        </div>
      )}
      {jobStatus && (
        <div style={{
          marginTop: 10, padding: "12px 16px", borderRadius: 10, fontSize: 14,
          border: `1px solid ${jobStatus.status === "done" ? "rgba(74,222,128,0.3)" : jobStatus.status === "failed" ? "rgba(248,113,113,0.3)" : "rgba(96,165,250,0.3)"}`,
          background: jobStatus.status === "done" ? "rgba(5,46,22,0.5)" : jobStatus.status === "failed" ? "rgba(127,29,29,0.4)" : "rgba(23,37,84,0.5)",
          color: jobStatus.status === "done" ? "#86efac" : jobStatus.status === "failed" ? "#fca5a5" : "#93c5fd",
        }}>
          {jobStatus.status === "processing" && t("knowledge.pdf_processing")}
          {jobStatus.status === "done" && t("knowledge.pdf_done", { pages: jobStatus.pages ?? 0, chunks: jobStatus.chunks ?? 0 })}
          {jobStatus.status === "failed" && t("knowledge.pdf_failed", { error: jobStatus.error ?? "" })}
        </div>
      )}
      {books.length > 0 && (
        <p style={{ fontSize: 12, color: "#6b7280", margin: "10px 0 0" }}>
          {t("knowledge.pdf_registered", { n: books.length })}
        </p>
      )}
    </div>
  );
}
