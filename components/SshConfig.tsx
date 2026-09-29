"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSplitView,
} from "./SettingsUi";

export interface SshHost {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  identityFile: string | null;
}

interface HostFormState {
  name: string;
  host: string;
  port: string;
  user: string;
  identityFile: string;
}

const EMPTY_FORM: HostFormState = { name: "", host: "", port: "22", user: "", identityFile: "" };

const inputStyle = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

const noteStyle = { fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 } as const;
const errorStyle = { fontSize: 12, color: "#dc2626", lineHeight: 1.5, whiteSpace: "pre-wrap" as const };
const okStyle = { fontSize: 12, color: "#16a34a", lineHeight: 1.5 } as const;

interface TestResult {
  ok: boolean;
  message: string;
}

export function SshConfig({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const { t } = useI18n();
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [form, setForm] = useState<HostFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadHosts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ssh/hosts");
      const data = await res.json() as { hosts?: SshHost[] };
      const list = Array.isArray(data.hosts) ? data.hosts : [];
      setHosts(list);
      setSelectedId((current) => current && list.some((host) => host.id === current) ? current : (list[0]?.id ?? null));
    } catch {
      setHosts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadHosts(); }, [loadHosts]);

  const selected = hosts.find((host) => host.id === selectedId) ?? null;

  const startEdit = (host: SshHost | "new") => {
    setTestResult(null);
    setFormError(null);
    if (host === "new") {
      setEditing("new");
      setForm(EMPTY_FORM);
    } else {
      setEditing(host.id);
      setForm({
        name: host.name,
        host: host.host,
        port: String(host.port),
        user: host.user,
        identityFile: host.identityFile ?? "",
      });
    }
  };

  const formPayload = () => ({
    name: form.name.trim() || form.host.trim(),
    host: form.host.trim(),
    port: Number(form.port) || 22,
    user: form.user.trim(),
    identityFile: form.identityFile.trim() || null,
  });

  const saveHost = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      const isNew = editing === "new";
      const res = await fetch(isNew ? "/api/ssh/hosts" : `/api/ssh/hosts/${encodeURIComponent(String(editing))}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: formPayload() }),
      });
      const data = await res.json() as { host?: SshHost; error?: string };
      if (!res.ok || !data.host) throw new Error(data.error ?? `HTTP ${res.status}`);
      setEditing(null);
      await loadHosts();
      setSelectedId(data.host.id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (payload: Record<string, unknown>) => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ssh/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      setTestResult(data.ok
        ? { ok: true, message: t("ssh.testOk") }
        : { ok: false, message: data.error ?? t("ssh.testFailed") });
    } catch (error) {
      setTestResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  };

  const deleteHost = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await fetch(`/api/ssh/hosts/${encodeURIComponent(selected.id)}`, { method: "DELETE" });
      await loadHosts();
    } finally {
      setDeleting(false);
    }
  };

  const renderDetail = () => {
    if (editing !== null) {
      return (
        <form onSubmit={(event) => void saveHost(event)}>
          <ConfigDetailStack>
            <ConfigSectionTitle>
              {editing === "new" ? t("ssh.addHost") : t("ssh.editHost")}
            </ConfigSectionTitle>
            <ConfigField label={t("ssh.fieldName")}>
              <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("ssh.fieldNamePlaceholder")} />
            </ConfigField>
            <ConfigField label={t("ssh.fieldHost")}>
              <input style={inputStyle} required value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} placeholder="192.168.1.10 / dev.example.com" />
            </ConfigField>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px", gap: 10 }}>
              <ConfigField label={t("ssh.fieldUser")}>
                <input style={inputStyle} required value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} placeholder="root" />
              </ConfigField>
              <ConfigField label={t("ssh.fieldPort")}>
                <input style={inputStyle} required inputMode="numeric" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} placeholder="22" />
              </ConfigField>
            </div>
            <ConfigField label={t("ssh.fieldIdentity")}>
              <input style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} value={form.identityFile} onChange={(e) => setForm({ ...form, identityFile: e.target.value })} placeholder={t("ssh.fieldIdentityPlaceholder")} />
            </ConfigField>
            <div style={noteStyle}>{t("ssh.keyAuthNote")}</div>
            {formError && <div style={errorStyle}>{formError}</div>}
            {testResult && (
              <div style={testResult.ok ? okStyle : errorStyle}>{testResult.message}</div>
            )}
          </ConfigDetailStack>
          <ConfigFooter>
            <ConfigButton variant="secondary" onClick={() => void runTest({ host: formPayload() })} disabled={testing || saving}>
              {testing ? t("ssh.testing") : t("ssh.testConnection")}
            </ConfigButton>
            <ConfigButton variant="secondary" onClick={() => setEditing(null)} disabled={saving}>
              {t("i18n.cancel")}
            </ConfigButton>
            <ConfigButton variant="primary" type="submit" disabled={saving}>
              {saving ? t("ssh.saving") : t("ssh.saveHost")}
            </ConfigButton>
          </ConfigFooter>
        </form>
      );
    }

    if (!selected) {
      return <ConfigEmptyState>{loading ? t("ssh.loading") : t("ssh.noHosts")}</ConfigEmptyState>;
    }

    return (
      <>
        <ConfigDetailStack>
          <ConfigSectionTitle>{selected.name}</ConfigSectionTitle>
          <div style={{ ...noteStyle, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)" }}>
            {selected.user}@{selected.host}:{selected.port}
          </div>
          {selected.identityFile && (
            <div style={{ ...noteStyle, fontFamily: "var(--font-mono)" }}>
              {selected.identityFile}
            </div>
          )}
          {testResult && (
            <div style={testResult.ok ? okStyle : errorStyle}>{testResult.message}</div>
          )}
          <div style={noteStyle}>{t("ssh.mountNote")}</div>
        </ConfigDetailStack>
        <ConfigFooter>
          <ConfigButton variant="secondary" onClick={() => void runTest({ hostId: selected.id })} disabled={testing}>
            {testing ? t("ssh.testing") : t("ssh.testConnection")}
          </ConfigButton>
          <ConfigButton variant="secondary" onClick={() => startEdit(selected)}>
            {t("ssh.edit")}
          </ConfigButton>
          <ConfigButton variant="secondary" onClick={() => void deleteHost()} disabled={deleting}>
            {deleting ? t("ssh.deleting") : t("i18n.delete")}
          </ConfigButton>
        </ConfigFooter>
      </>
    );
  };

  return (
    <ConfigPanelShell embedded={embedded} title={t("settings.ssh")} subtitle="~/.pi/agent/ssh-hosts.json" closeLabel={t("i18n.close")} onClose={onClose}>
      <ConfigSplitView>
        <ConfigSidebar>
          <div style={{ padding: "8px 10px", fontSize: 11, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {t("ssh.hostsHeading")}
          </div>
          {hosts.map((host) => (
            <ConfigSidebarItem
              key={host.id}
              active={selectedId === host.id && editing === null}
              onClick={() => { setSelectedId(host.id); setEditing(null); setTestResult(null); }}
            >
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                {host.name}
              </span>
            </ConfigSidebarItem>
          ))}
          <div style={{ padding: "6px 8px" }}>
            <ConfigButton variant="secondary" size="small" onClick={() => startEdit("new")}>
              {t("ssh.addHost")}
            </ConfigButton>
          </div>
        </ConfigSidebar>
        <ConfigDetail>{renderDetail()}</ConfigDetail>
      </ConfigSplitView>
    </ConfigPanelShell>
  );
}
