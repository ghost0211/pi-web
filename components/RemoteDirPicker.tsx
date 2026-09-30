"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { SshHostEntry } from "@/lib/ssh-hosts";
import { ConfigButton } from "./SettingsUi";

const inputStyle = {
  minWidth: 0,
  height: 36,
  padding: "0 10px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  outline: "none",
  background: "var(--bg-panel)",
  color: "var(--text)",
  fontSize: 13,
} as const;

interface RemoteDirEntry {
  name: string;
  path: string;
}

interface RemoteLsResponse {
  ok?: boolean;
  path?: string;
  parentPath?: string | null;
  directories?: RemoteDirEntry[];
  error?: string;
}

interface MountResponse {
  ok?: boolean;
  driveLetter?: string;
  mountPoint?: string;
  remotePath?: string;
  error?: string;
  detail?: string;
  needsSshfsWin?: boolean;
}

interface Props {
  onCancel: () => void;
  onSelect: (cwd: string) => void;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

export function RemoteDirPicker({ onCancel, onSelect }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [hosts, setHosts] = useState<SshHostEntry[]>([]);
  const [hostId, setHostId] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [directories, setDirectories] = useState<RemoteDirEntry[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [mounting, setMounting] = useState(false);
  const [mountError, setMountError] = useState<string | null>(null);
  const browseSeq = useRef(0);

  const loadHosts = useCallback(async () => {
    try {
      const response = await fetch("/api/ssh/hosts");
      if (!response.ok) return;
      const data = (await response.json()) as { hosts?: SshHostEntry[] };
      const list = Array.isArray(data.hosts) ? data.hosts : [];
      setHosts(list);
      setHostId((previous) => previous || list[0]?.id || "");
    } catch {
      /* list stays empty */
    }
  }, []);

  const navigateTo = useCallback(
    async (targetHostId: string, directory?: string) => {
      if (!targetHostId) return;
      const seq = ++browseSeq.current;
      setBrowsing(true);
      setBrowseError(null);
      try {
        const response = await fetch("/api/ssh/ls", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostId: targetHostId, path: directory ?? "" }),
        });
        const data = (await response.json()) as RemoteLsResponse;
        if (seq !== browseSeq.current) return; // stale navigation
        if (!response.ok || !data.ok || !data.path) throw new Error(data.error ?? `HTTP ${response.status}`);
        setCurrentPath(data.path);
        setParentPath(data.parentPath ?? null);
        setPathInput(data.path);
        setDirectories(data.directories ?? []);
      } catch (cause) {
        if (seq !== browseSeq.current) return;
        setBrowseError(cause instanceof Error ? cause.message : String(cause));
        setDirectories([]);
      } finally {
        if (seq === browseSeq.current) setBrowsing(false);
      }
    },
    [],
  );

  useEffect(() => {
    setPortalTarget(document.body);
    void loadHosts();
  }, [loadHosts]);

  // Browse the login directory whenever the selected host changes.
  useEffect(() => {
    if (!hostId) return;
    setCurrentPath("");
    setParentPath(null);
    setPathInput("");
    setDirectories([]);
    setMountError(null);
    void navigateTo(hostId);
  }, [hostId, navigateTo]);

  const handleHostChange = (nextHostId: string) => {
    setHostId(nextHostId);
  };

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(hostId, candidate);
  };

  const handleOpen = async () => {
    if (!hostId || !currentPath) return;
    setMounting(true);
    setMountError(null);
    try {
      const response = await fetch("/api/ssh/mount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, remotePath: currentPath }),
      });
      const data = (await response.json()) as MountResponse;
      if (!response.ok || !data.ok || !data.mountPoint) {
        const needsHint = data.needsSshfsWin ? ` — ${t("ssh.installSshfsWin")}: winget install -e --id SSHFS-Win.SSHFS-Win` : "";
        throw new Error(`${data.error ?? `HTTP ${response.status}`}${data.detail ? `\n${data.detail}` : ""}${needsHint}`);
      }
      onSelect(data.mountPoint);
    } catch (cause) {
      setMountError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMounting(false);
    }
  };

  const busy = mounting;
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const canOpen = Boolean(hostId && currentPath) && !hasUncommittedPath && !browsing && !busy;

  if (!portalTarget) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("ssh.openRemoteTitle")}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
    >
      <div style={{ width: 560, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(var(--app-viewport-height, 100dvh) - 16px))", maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("ssh.openRemoteTitle")}</div>
            <div style={{ color: "var(--text-dim)", fontSize: 11, marginTop: 2 }}>{t("ssh.openRemoteSubtitle")}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            aria-label={t("i18n.close")}
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <label style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}>{t("ssh.pickHost")}</label>
          <select
            value={hostId}
            onChange={(event) => handleHostChange(event.target.value)}
            disabled={busy || hosts.length === 0}
            style={{ ...inputStyle, flex: 1 }}
          >
            {hosts.length === 0 ? <option value="">{t("ssh.noHostsForPicker")}</option> : null}
            {hosts.map((host) => (
              <option key={host.id} value={host.id}>
                {host.name} ({host.user}@{host.host}:{host.port})
              </option>
            ))}
          </select>
        </div>

        <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button
            type="button"
            onClick={() => void navigateTo(hostId, parentPath ?? undefined)}
            disabled={!hostId || browsing || busy || !parentPath}
            title={t("directoryPicker.goToParent")}
            aria-label={t("directoryPicker.goToParent")}
            style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: parentPath && !browsing ? "pointer" : "default", opacity: parentPath && !browsing ? 1 : 0.45 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <input
            type="text"
            value={pathInput}
            placeholder={t("ssh.remotePathPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            disabled={!hostId || busy}
            onChange={(event) => {
              setPathInput(event.target.value);
              setBrowseError(null);
            }}
            style={{ ...inputStyle, flex: 1, fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <button
            type="submit"
            disabled={!hostId || browsing || busy || !pathInput.trim()}
            title={t("directoryPicker.goToDirectory")}
            style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: hostId && !browsing && pathInput.trim() ? "pointer" : "default", opacity: hostId && !browsing && pathInput.trim() ? 1 : 0.6 }}
          >
            {t("directoryPicker.go")}
          </button>
        </form>

        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
          {!hostId ? (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("ssh.noHostsForPicker")}</div>
          ) : browsing ? (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.loadingDirectories")}</div>
          ) : directories.length > 0 ? (
            directories.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => void navigateTo(hostId, entry.path)}
                title={entry.path}
                style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
              >
                <FolderIcon />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            ))
          ) : (
            !browseError && <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noSubdirectories")}</div>
          )}
          {browseError && <div style={{ padding: "8px", color: "#dc2626", fontSize: 11, whiteSpace: "pre-wrap" }}>{browseError}</div>}
        </div>

        {mountError && (
          <div style={{ padding: "8px 18px", color: "#dc2626", fontSize: 12, whiteSpace: "pre-wrap", flexShrink: 0 }}>{mountError}</div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1, color: "var(--text-dim)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {mounting ? t("ssh.mounting") : ""}
          </div>
          <ConfigButton type="button" onClick={onCancel} disabled={busy}>
            {t("i18n.cancel")}
          </ConfigButton>
          <ConfigButton
            type="button"
            variant="primary"
            onClick={() => void handleOpen()}
            disabled={!canOpen}
            title={hasUncommittedPath ? t("directoryPicker.openBeforeSelecting") : t("directoryPicker.selectCurrentDirectory")}
          >
            {mounting ? t("ssh.mounting") : t("ssh.openRemote")}
          </ConfigButton>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}

