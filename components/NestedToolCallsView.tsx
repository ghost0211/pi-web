"use client";

import type { NestedToolCalls } from "@earendil-works/pi-ai";
import { useI18n } from "@/hooks/useI18n";

/** Pi records metadata, not nested results: never synthesize transcript messages. */
export function NestedToolCallsView({ record }: { record: NestedToolCalls }) {
  const { t } = useI18n();
  if (record.calls.length === 0 && record.complete) return null;
  return (
    <details style={{ borderTop: "1px solid var(--border)", padding: "6px 10px", color: "var(--text-muted)" }}>
      <summary style={{ cursor: "pointer", fontSize: 11 }}>
        {t("chat.nestedCalls", { count: record.calls.length })}
        {!record.complete && ` · ${t("chat.nestedCallsPartial")}`}
      </summary>
      <div style={{ maxHeight: 320, overflowY: "auto", marginTop: 6 }}>
        {record.calls.map((call) => (
          <details key={call.id} style={{ padding: "3px 0", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            <summary style={{ cursor: "pointer", overflowWrap: "anywhere", color: call.status === "error" ? "#f87171" : undefined }}>
              {call.name} · {call.status}{call.durationMs !== undefined && ` · ${call.durationMs}ms`}
            </summary>
            {call.arguments !== undefined && (
              <pre style={{ margin: "4px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(call.arguments, null, 2)}</pre>
            )}
            {call.argumentsBytes !== undefined && <div>{t("chat.nestedArgumentsOmitted", { bytes: call.argumentsBytes })}</div>}
            {call.error && <pre style={{ margin: "4px 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "#f87171" }}>{call.error}</pre>}
          </details>
        ))}
      </div>
    </details>
  );
}
