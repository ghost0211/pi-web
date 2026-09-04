"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("Pi Web render error", error);
  }, [error]);

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24, background: "var(--bg)", color: "var(--text)" }}>
      <div role="alert" style={{ width: "min(480px, 100%)", padding: 24, border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)", textAlign: "center" }}>
        <div aria-hidden="true" style={{ marginBottom: 12, color: "#ef4444", fontSize: 28 }}>!</div>
        <h1 style={{ margin: "0 0 8px", fontSize: 18 }}>Pi Web 遇到了问题</h1>
        <p style={{ margin: "0 0 18px", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6 }}>
          Something went wrong. You can retry without losing the saved session.
        </p>
        <button type="button" onClick={retry} style={{ padding: "8px 16px", border: "none", borderRadius: 7, background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 600 }}>
          重试 / Retry
        </button>
        {error.digest && <p style={{ margin: "14px 0 0", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>Error ID: {error.digest}</p>}
      </div>
    </main>
  );
}
