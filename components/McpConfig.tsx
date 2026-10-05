"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import {
  deleteMcpServer, fetchMcpCatalog, fetchMcpRuntime, formToMcpServerPatch, getEffectiveMcpServerConfig,
  isMcpServerShadowed, isSafeAuthorizationUrl, performMcpRuntimeAction, RevisionConflictError,
  saveMcpServer, serverToMcpForm, submitMcpRuntimeInput, validateMcpServerName,
  type McpCatalogResponse, type McpRuntimeResponse, type McpScope, type McpServerForm,
} from "@/lib/mcp-client";
import {
  ConfigButton, ConfigDetail, ConfigDetailHeader, ConfigDetailTitle, ConfigEmptyState, ConfigField,
  ConfigFooter, ConfigListAction, ConfigPanelShell, ConfigSectionTitle, ConfigSidebar,
  ConfigSidebarGroupLabel, ConfigSidebarItem, ConfigSidebarList, ConfigSidebarText, ConfigSplitView, ConfigSwitch,
} from "./SettingsUi";

interface Props { cwd: string | null; sessionId: string | null; onClose: () => void; onSessionReloaded: () => void; embedded?: boolean }
const inputStyle: CSSProperties = { width: "100%", padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", fontSize: 12 };
const textStyle: CSSProperties = { ...inputStyle, minHeight: 72, fontFamily: "var(--font-mono)", resize: "vertical" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "MCP request failed";

export function McpConfig({ cwd, sessionId, onClose, onSessionReloaded, embedded = false }: Props) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<McpCatalogResponse | null>(null);
  const [runtime, setRuntime] = useState<McpRuntimeResponse | null>(null);
  const [form, setForm] = useState<McpServerForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [trustConfirm, setTrustConfirm] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [input, setInput] = useState<{ token: string; placeholder?: string } | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [inputBusy, setInputBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const actionAbort = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const statusSequence = useRef(0);
  const selected = useRef<{ scope: McpScope; name: string } | null>(null);

  const choose = (scope: McpScope, name?: string, data = catalog) => {
    const server = data?.files.find((file) => file.scope === scope)?.servers.find((entry) => entry.name === name);
    selected.current = { scope, name: name ?? "" };
    setForm(serverToMcpForm(scope, server, data));
    setError(null); setDeleteConfirm(false); setAuthUrl(null); setInput(null); setMessage("");
  };

  const updateCatalog = (data: McpCatalogResponse) => {
    setCatalog(data);
    const choice = selected.current;
    if (choice) {
      const server = data.files.find((file) => file.scope === choice.scope)?.servers.find((entry) => entry.name === choice.name);
      if (server) { setForm(serverToMcpForm(choice.scope, server, data)); return; }
      if (!choice.name) { setForm(serverToMcpForm(choice.scope)); return; }
    }
    const file = data.files.find((entry) => entry.servers.length);
    if (file) {
      selected.current = { scope: file.scope, name: file.servers[0].name };
      setForm(serverToMcpForm(file.scope, file.servers[0], data));
    } else { selected.current = null; setForm(null); }
  };

  const loadStatus = async (controller: AbortController) => {
    if (!sessionId || controller.signal.aborted) return;
    const sequence = ++statusSequence.current;
    try {
      const value = await fetchMcpRuntime(sessionId, controller.signal);
      if (!controller.signal.aborted && sequence === statusSequence.current) setRuntime(value);
    } catch { if (!controller.signal.aborted && sequence === statusSequence.current) setRuntime(null); }
  };

  // The lifetime signal invalidates every GET, mutation, reload and OAuth reply on context changes.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    selected.current = null; busyRef.current = false;
    setCatalog(null); setRuntime(null); setForm(null); setLoading(true); setBusy(false);
    setNeedsReload(false); setDeleteConfirm(false); setTrustConfirm(false); setAuthUrl(null); setInput(null); setInputValue(""); setInputBusy(false); setError(null); setMessage("");
    void fetchMcpCatalog(cwd, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setCatalog(data);
      const file = data.files.find((entry) => entry.servers.length);
      if (file) { selected.current = { scope: file.scope, name: file.servers[0].name }; setForm(serverToMcpForm(file.scope, file.servers[0], data)); }
    }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const sequence = ++statusSequence.current;
    if (sessionId) void fetchMcpRuntime(sessionId, controller.signal).then((value) => {
      if (!controller.signal.aborted && sequence === statusSequence.current) setRuntime(value);
    }).catch(() => {});
    return () => { controller.abort(); actionAbort.current?.abort(); };
  }, [cwd, sessionId]);

  const run = async (work: (controller: AbortController) => Promise<void>) => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busyRef.current || loading) return;
    busyRef.current = true; setBusy(true); setError(null); setMessage("");
    try { await work(controller); }
    catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof RevisionConflictError ? t("mcp.conflictError") : errorMessage(reason));
    } finally { if (!controller.signal.aborted) { busyRef.current = false; setBusy(false); } }
  };

  const save = () => run(async (controller) => {
    if (!form || !catalog) return;
    const invalid = validateMcpServerName(form.name);
    if (invalid) { setError(t(invalid)); return; }
    if (form.scope === "project" && !catalog.project.trusted) { setError(t("mcp.projectUntrustedNotice")); return; }
    let config: Record<string, unknown>;
    try { config = formToMcpServerPatch(form); }
    catch (reason) { setError(t(errorMessage(reason))); return; }
    const file = catalog.files.find((entry) => entry.scope === form.scope);
    if (!file) return;
    const data = await saveMcpServer({ scope: form.scope, cwd, name: form.name.trim(), config, revision: file.revision }, controller.signal);
    if (controller.signal.aborted) return;
    selected.current = { scope: form.scope, name: form.name.trim() };
    updateCatalog(data); setNeedsReload(Boolean(sessionId)); setMessage(t("mcp.saveSuccess"));
  });

  const remove = () => run(async (controller) => {
    if (!form || form.isNew || !catalog) return;
    const file = catalog.files.find((entry) => entry.scope === form.scope);
    if (!file) return;
    const data = await deleteMcpServer({ scope: form.scope, cwd, name: form.name, revision: file.revision }, controller.signal);
    if (controller.signal.aborted) return;
    selected.current = null; updateCatalog(data); setDeleteConfirm(false); setNeedsReload(Boolean(sessionId)); setMessage(t("mcp.deleteSuccess"));
  });

  const trust = () => run(async (controller) => {
    if (!cwd || !trustConfirm) return;
    const response = await fetch("/api/project-trust", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ cwd, purpose: "mcp" }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const data = await fetchMcpCatalog(cwd, controller.signal);
    if (controller.signal.aborted) return;
    setTrustConfirm(false); updateCatalog(data); setRuntime(null); onSessionReloaded(); await loadStatus(controller);
  });

  const reload = () => run(async (controller) => {
    if (!sessionId || !runtime?.live) return;
    await sendAgentCommand(sessionId, { type: "reload", requireLiveSession: true }, { signal: controller.signal });
    if (controller.signal.aborted) return;
    setNeedsReload(false); onSessionReloaded(); await loadStatus(controller);
  });

  const refresh = () => run(async (controller) => {
    const data = await fetchMcpCatalog(cwd, controller.signal);
    if (controller.signal.aborted) return;
    updateCatalog(data); await loadStatus(controller);
  });

  const act = (action: "login" | "logout" | "reconnect") => run(async (controller) => {
    if (!sessionId || !form || form.isNew || needsReload || !runtime?.available || isMcpServerShadowed(form.name, form.scope, catalog)) return;
    const effective = getEffectiveMcpServerConfig(form.name, form.scope, catalog);
    if (!effective || effective.enabled === false) return;
    const child = new AbortController(); actionAbort.current = child;
    const abort = () => child.abort(); controller.signal.addEventListener("abort", abort, { once: true });
    setAuthUrl(null); setInput(null); setInputValue("");
    let terminal = false;
    try {
      await performMcpRuntimeAction({ sessionId, action, name: form.name, signal: child.signal, onEvent: (event) => {
        if (controller.signal.aborted || child.signal.aborted) return;
        if (event.type === "auth" && isSafeAuthorizationUrl(event.url)) setAuthUrl(event.url);
        else if (event.type === "input") setInput({ token: event.token, placeholder: event.placeholder });
        else if (event.type === "notify") { if (event.level === "error") setError(event.message); else setMessage(event.message); }
        else if (event.type === "error") { terminal = true; setError(event.message); }
        else if (event.type === "done") { terminal = true; if (event.success) setMessage(t("mcp.actionSuccess")); else setError(t("mcp.actionFailed")); }
      } });
      if (!terminal && !child.signal.aborted && !controller.signal.aborted) setError(t("mcp.actionFailed"));
    } catch (reason) { if (!child.signal.aborted) throw reason; }
    finally {
      controller.signal.removeEventListener("abort", abort);
      if (actionAbort.current === child) actionAbort.current = null;
      child.abort();
      if (!controller.signal.aborted) { setInput(null); setAuthUrl(null); setInputValue(""); setInputBusy(false); await loadStatus(controller); }
    }
  });

  const reply = async (value: string | null) => {
    const controller = lifetime.current;
    const action = actionAbort.current;
    if (!sessionId || !input || !controller || controller.signal.aborted || !action || action.signal.aborted || inputBusy) return;
    const current = () => !controller.signal.aborted && !action.signal.aborted && actionAbort.current === action;
    setInputBusy(true);
    try {
      await submitMcpRuntimeInput(sessionId, input.token, value, action.signal);
      if (current()) { setInput(null); setInputValue(""); }
    } catch (reason) { if (current()) setError(errorMessage(reason)); }
    finally { if (current()) setInputBusy(false); }
  };
  const change = (key: keyof McpServerForm, value: string | boolean) => setForm((previous) => {
    if (!previous) return null;
    if (key === "name" && previous.isNew && previous.isOverride && typeof value === "string") {
      return { ...serverToMcpForm("project", { name: value, config: {} }, catalog), isNew: true };
    }
    return { ...previous, [key]: value };
  });
  const shadowed = Boolean(form && isMcpServerShadowed(form.name, form.scope, catalog));
  const effectiveConfig = form ? getEffectiveMcpServerConfig(form.name, form.scope, catalog) : null;
  const isEffectiveDisabled = !effectiveConfig || effectiveConfig.enabled === false;
  const oauthCapable = Boolean(effectiveConfig && typeof effectiveConfig.url === "string" && !effectiveConfig.auth);
  const liveDisabled = busy || needsReload || !runtime?.available || !form || form.isNew || shadowed || isEffectiveDisabled;
  const fields: Array<keyof McpServerForm> = form?.type === "http" ? ["url", "headers", "oauth", ...(form.scope === "global" ? ["authProvider" as const] : [])] : ["command", "args", "cwd", "env"];
  const jsonFields = new Set(["args", "env", "headers", "oauth", "toolExposure"]);

  return <ConfigPanelShell embedded={embedded} title={t("mcp.title")} subtitle={t("mcp.subtitle")} closeLabel={t("mcp.cancel")} onClose={onClose}>
    <ConfigSplitView>
      <ConfigSidebar><ConfigSidebarList>
        {(["global", "project"] as const).map((scope) => <div key={scope}>
          <ConfigSidebarGroupLabel>{t(scope === "global" ? "mcp.globalServers" : "mcp.projectServers")}</ConfigSidebarGroupLabel>
          {catalog?.files.find((entry) => entry.scope === scope)?.servers.map((server) => <ConfigSidebarItem key={server.name} disabled={busy || loading} active={form?.scope === scope && form.name === server.name} onClick={() => choose(scope, server.name)}>
            <ConfigSidebarText>{server.name}{isMcpServerShadowed(server.name, scope, catalog) ? ` (${t("mcp.overridden")})` : ""}</ConfigSidebarText>
          </ConfigSidebarItem>)}
          <ConfigListAction disabled={busy || loading || !catalog || (scope === "project" && !catalog.project.trusted)} active={form?.isNew && form.scope === scope} onClick={() => choose(scope)}>{t(scope === "global" ? "mcp.addGlobalServer" : "mcp.addProjectServer")}</ConfigListAction>
        </div>)}
      </ConfigSidebarList></ConfigSidebar>
      <ConfigDetail>
        {catalog?.files.map((entry) => <p key={entry.scope} style={{ color: "var(--text-muted)", fontSize: 11, overflowWrap: "anywhere" }}><strong>{t(entry.scope === "global" ? "mcp.scopeGlobal" : "mcp.scopeProject")}: </strong><code>{entry.path}</code></p>)}
        {cwd && catalog && !catalog.project.trusted && <div>
          <p>{t("mcp.projectUntrustedNotice")}</p>
          {!trustConfirm ? <ConfigButton disabled={busy} onClick={() => setTrustConfirm(true)}>{t("mcp.trustProject")}</ConfigButton> : <>
            <p role="alert">{t("mcp.trustWarning")}</p>
            <ConfigButton disabled={busy} onClick={() => void trust()}>{t("mcp.confirmTrust")}</ConfigButton>
            <ConfigButton disabled={busy} onClick={() => setTrustConfirm(false)}>{t("mcp.cancel")}</ConfigButton>
          </>}
        </div>}
        {catalog?.errors.map((entry, index) => <p key={index} role="alert">{entry}</p>)}
        {loading ? <ConfigEmptyState>{t("mcp.loading")}</ConfigEmptyState> : form ? <>
          <ConfigDetailHeader><ConfigDetailTitle>{form.isNew ? t("mcp.create") : form.name}</ConfigDetailTitle></ConfigDetailHeader>
          {shadowed && <p>{t("mcp.shadowedNotice")}</p>}
          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("mcp.savedValueHint")}</p>
          <fieldset disabled={busy || (form.scope === "project" && !catalog?.project.trusted)} style={{ border: 0, padding: 0, margin: 0 }}>
            <ConfigField label={t("mcp.serverName")}><input style={inputStyle} aria-label={t("mcp.serverName")} value={form.name} disabled={!form.isNew} onChange={(event) => change("name", event.target.value)} /></ConfigField>
            <ConfigField label={t("mcp.serverType")}>
              <select
                style={inputStyle}
                aria-label={t("mcp.serverType")}
                value={form.isOverride ? "override" : form.type}
                disabled={Boolean(form.isOverride && !form.isNew)}
                onChange={(event) => {
                  const val = event.target.value;
                  if (val === "override") {
                    setForm((prev) => (prev ? { ...serverToMcpForm("project", { name: prev.name, config: {} }, catalog), isNew: true } : null));
                  } else {
                    setForm((prev) => (prev ? { ...prev, type: val as "stdio" | "http", isOverride: false } : null));
                  }
                }}
              >
                <option value="stdio">{t("mcp.transportStdio")}</option>
                <option value="http">{t("mcp.transportHttp")}</option>
                {form.scope === "project" && (form.isNew || form.isOverride) && <option value="override">{t("mcp.thinOverride")}</option>}
              </select>
            </ConfigField>
            {form.isOverride && <p style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("mcp.overrideNotice")}</p>}
            <ConfigField label={t("mcp.enabled")}><ConfigSwitch checked={form.enabled} label={t("mcp.enabled")} onChange={(value) => change("enabled", value)} /></ConfigField>
            <ConfigField label={t("mcp.exposure")}><select style={inputStyle} aria-label={t("mcp.exposure")} value={form.exposure} onChange={(event) => change("exposure", event.target.value)}>{["codemode", "deferred", "direct", "hidden"].map((value) => <option key={value} value={value}>{t(`mcp.exposure${value[0].toUpperCase()}${value.slice(1)}`)}</option>)}</select></ConfigField>
            {!form.isOverride ? <>
              {[...fields, "description", "timeout", "toolExposure" as const].map((key) => <ConfigField key={key} label={t(`mcp.${key}`)}>{jsonFields.has(key) ? <textarea style={textStyle} aria-label={t(`mcp.${key}`)} value={String(form[key as keyof McpServerForm])} onChange={(event) => change(key as keyof McpServerForm, event.target.value)} /> : <input style={inputStyle} aria-label={t(`mcp.${key}`)} value={String(form[key as keyof McpServerForm])} onChange={(event) => change(key as keyof McpServerForm, event.target.value)} />}</ConfigField>)}
              {form.type === "http" && <p style={{ fontSize: 11 }}>{t("mcp.oauthHint")}</p>}
              {form.type === "http" && form.scope === "global" && <p style={{ fontSize: 11 }}>{t("mcp.authProviderHint")}</p>}
            </> : (
              <ConfigField label={t("mcp.toolExposure")}><textarea style={textStyle} aria-label={t("mcp.toolExposure")} value={String(form.toolExposure)} onChange={(event) => change("toolExposure", event.target.value)} /></ConfigField>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <ConfigButton variant="primary" onClick={() => void save()}>{t("mcp.save")}</ConfigButton>
              {!form.isNew && <ConfigButton onClick={() => choose(form.scope, form.name)}>{t("mcp.reset")}</ConfigButton>}
              {form.isNew && <ConfigButton onClick={() => { selected.current = null; setForm(null); }}>{t("mcp.cancel")}</ConfigButton>}
              {!form.isNew && <ConfigButton variant="danger" onClick={() => setDeleteConfirm(true)}>{t("mcp.delete")}</ConfigButton>}
              {deleteConfirm && <><ConfigButton variant="danger" onClick={() => void remove()}>{t("mcp.confirmDelete")}</ConfigButton><ConfigButton onClick={() => setDeleteConfirm(false)}>{t("mcp.cancel")}</ConfigButton></>}
            </div>
          </fieldset>
        </> : <ConfigEmptyState>{t("mcp.emptySelection")}</ConfigEmptyState>}
        <ConfigSectionTitle>{t("mcp.state")}</ConfigSectionTitle>
        <p style={{ fontSize: 11, color: "var(--text-muted)" }}>{t("mcp.runtimeContext")}</p>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{runtime?.statusText || runtime?.reason || t(runtime?.available ? "mcp.runtimeNoStatus" : "mcp.runtimeUnavailable")}</pre>
        {needsReload && <p role="status">{t("mcp.needsReloadNotice")}</p>}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <ConfigButton disabled={liveDisabled} onClick={() => void act("reconnect")}>{t("mcp.reconnect")}</ConfigButton>
          {oauthCapable && <><ConfigButton disabled={liveDisabled} onClick={() => void act("login")}>{t("mcp.login")}</ConfigButton><ConfigButton disabled={liveDisabled} onClick={() => void act("logout")}>{t("mcp.logout")}</ConfigButton></>}
          <ConfigButton disabled={busy || !sessionId || !runtime?.live} onClick={() => void reload()}>{t("mcp.reloadSession")}</ConfigButton>
          {busy && actionAbort.current && <ConfigButton onClick={() => { actionAbort.current?.abort(); }}>{t("mcp.cancel")}</ConfigButton>}
        </div>
        {authUrl && isSafeAuthorizationUrl(authUrl) && <p><a href={authUrl} target="_blank" rel="noopener noreferrer">{t("mcp.openAuthUrl")}</a></p>}
        {input && <div><ConfigField label={t("mcp.authPrompt")}><input style={inputStyle} aria-label={t("mcp.authPrompt")} value={inputValue} placeholder={input.placeholder} onChange={(event) => setInputValue(event.target.value)} /></ConfigField><ConfigButton disabled={inputBusy || !inputValue.trim()} onClick={() => void reply(inputValue.trim())}>{t("mcp.submit")}</ConfigButton><ConfigButton disabled={inputBusy} onClick={() => void reply(null)}>{t("mcp.cancel")}</ConfigButton></div>}
        {error && <p role="alert" style={{ color: "var(--error, #ef4444)" }}>{error}</p>}
        {message && <p role="status">{message}</p>}
      </ConfigDetail>
    </ConfigSplitView>
    <ConfigFooter status={busy ? t("mcp.busy") : undefined}><ConfigButton disabled={busy || loading} onClick={() => void refresh()}>{t("mcp.refresh")}</ConfigButton></ConfigFooter>
  </ConfigPanelShell>;
}
