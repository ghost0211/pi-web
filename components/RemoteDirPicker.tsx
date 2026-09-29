"use client";

import { FormEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { SshHost } from "./SshConfig";

interface Props {
  onCancel: () => void;
  /** Called with the local mount point (e.g. "Z:\") once the remote dir is mounted. */
  onSelect: (localPath: string) => void;
}

/**
 * Mount a remote directory of a configured SSH host (设置 → 远程主机) through
 * SSHFS-Win and open it as the session workspace.
 */
export function RemoteDirPicker({ onCancel, onSelect }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [hostId, setHostId] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPortalTarget(document.body);
    void (async () => {
      try {
        const res = await fetch("/api/ssh/hosts");
        const data = await res.json() as { hosts?: SshHost[] };
        const list = Array.isArray(data.hosts) ? data.hosts : [];
        setHosts(list);
        setHostId(list[0]?.id ?? "");
      } catch {
        setHosts([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (!hostId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ssh/mount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, remotePath }),
      });
      const data = await res.json() as { localPath?: string; error?: string };
      if (!res.ok || !data.localPath) throw new Error(data.error ?? `HTTP ${res.status}`);
      onSelect(data.localPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  if (!portalTarget) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("ssh.openRemoteTitle")}
      onClick={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}
      onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
    >
      <div style={{ width: 460, maxWidth: "calc(100vw - 16px)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>
        <div style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("ssh.openRemoteTitle")}</div>
          <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>{t("ssh.openRemoteSubtitle")}</div>
        </div>

        {hosts.length === 0 ? (
          <div style={{ padding: "24px 18px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7 }}>
            {loading ? t("ssh.loading") : t("ssh.noHostsForPicker")}
          </div>
        ) : (
          <form onSubmit={(event) => void open(event)}>
            <div style={{ padding: "14px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted)" }}>
                {t("ssh.pickHost")}
                <select
                  value={hostId}
                  onChange={(event) => setHostId(event.target.value)}
                  disabled={busy}
                  style={{ padding: "6px 9px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none" }}
                >
                  {hosts.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name} ({host.user}@{host.host}:{host.port})
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 12, color: "var(--text-muted)" }}>
                {t("ssh.remotePath")}
                <input
                  value={remotePath}
                  onChange={(event) => setRemotePath(event.target.value)}
                  disabled={busy}
                  placeholder={t("ssh.remotePathPlaceholder")}
                  style={{ padding: "6px 9px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 12, outline: "none", fontFamily: "var(--font-mono)" }}
                />
              </label>
              {error && <div style={{ fontSize: 12, color: "#dc2626", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{error}</div>}
              {busy && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("ssh.mounting")}</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
              >
                {t("i18n.cancel")}
              </button>
              <button
                type="submit"
                disabled={!hostId || busy}
                style={{ padding: "6px 14px", background: "var(--accent)", border: "none", borderRadius: 6, color: "#fff", fontSize: 12, fontWeight: 500, cursor: hostId && !busy ? "pointer" : "not-allowed", opacity: hostId && !busy ? 1 : 0.6 }}
              >
                {busy ? t("ssh.mounting") : t("ssh.openRemote")}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    portalTarget,
  );
}
