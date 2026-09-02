"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigButton, ConfigPanelShell } from "./SettingsUi";

interface ScopeModelEntry {
  provider: string;
  id: string;
  name: string;
  contextWindow?: number;
}

interface ScopeResponse {
  models?: ScopeModelEntry[];
  enabledIds?: string[] | null;
  warnings?: string[];
  error?: string;
}

interface Props {
  embedded?: boolean;
  onClose: () => void;
}

function modelKey(model: Pick<ScopeModelEntry, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function sameSelection(a: ReadonlySet<string> | null, b: ReadonlySet<string> | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Editor for the persisted `enabledModels` scope (pi's `/scoped-models`).
 * `selected === null` represents the unrestricted state (setting absent).
 */
export function ModelScopeConfig({ embedded = false, onClose }: Props) {
  const { t } = useI18n();
  const [models, setModels] = useState<ScopeModelEntry[]>([]);
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedOk, setSavedOk] = useState(false);

  const load = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/models/scope", { signal });
      const data = (await response.json()) as ScopeResponse;
      if (!response.ok || !Array.isArray(data.models)) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      setModels(data.models);
      const ids = data.enabledIds == null ? null : new Set(data.enabledIds);
      setBaseline(ids);
      setSelected(ids);
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(`${t("modelScope.loadError")}: ${detail}`);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const allIds = useMemo(() => models.map(modelKey), [models]);
  const dirty = !sameSelection(selected, baseline);

  const filteredGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches = (model: ScopeModelEntry) => !query
      || model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query)
      || model.provider.toLowerCase().includes(query);
    const groups = new Map<string, ScopeModelEntry[]>();
    for (const model of models) {
      if (!matches(model)) continue;
      const list = groups.get(model.provider) ?? [];
      list.push(model);
      groups.set(model.provider, list);
    }
    return [...groups.entries()];
  }, [models, search]);

  const toggleModel = useCallback((id: string) => {
    setSavedOk(false);
    setSelected((current) => {
      const next = current === null ? new Set(allIds) : new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [allIds]);

  const setProviderModels = useCallback((ids: string[], enable: boolean) => {
    setSavedOk(false);
    setSelected((current) => {
      const next = current === null ? new Set(allIds) : new Set(current);
      for (const id of ids) {
        if (enable) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, [allIds]);

  const save = useCallback(async () => {
    if (selected !== null && selected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/models/scope", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledIds: selected === null ? null : [...selected] }),
      });
      const data = (await response.json()) as ScopeResponse;
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const ids = data.enabledIds == null ? null : new Set(data.enabledIds);
      setBaseline(ids);
      setSelected(ids);
      setWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setSavedOk(true);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(`${t("modelScope.saveError")}: ${detail}`);
    } finally {
      setSaving(false);
    }
  }, [selected, t]);

  const allIdSet = useMemo(() => new Set(allIds), [allIds]);
  const unavailableIds = selected === null
    ? []
    : [...selected].filter((id) => !allIdSet.has(id));
  const emptySelection = selected !== null && selected.size === 0;
  const selectedCount = selected === null
    ? allIds.length
    : allIds.filter((id) => selected.has(id)).length;

  return (
    <ConfigPanelShell embedded={embedded} title={t("settings.modelScope")} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="model-scope-panel">
        <div className="model-scope-header">
          <p className="model-scope-description">{t("modelScope.description")}</p>
          <p className="model-scope-take-effect">{t("modelScope.takeEffect")}</p>
        </div>

        <div className="model-scope-toolbar">
          <input
            type="search"
            className="model-scope-search"
            placeholder={t("modelScope.searchPlaceholder")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t("modelScope.searchPlaceholder")}
            disabled={saving}
          />
          <span className="model-scope-count">
            {t("modelScope.selectedCount", { selected: selectedCount, total: allIds.length })}
          </span>
          <ConfigButton size="small" onClick={() => { setSavedOk(false); setSelected(null); }} disabled={loading || saving}>
            {t("modelScope.selectAll")}
          </ConfigButton>
          <ConfigButton size="small" onClick={() => { setSavedOk(false); setSelected(new Set()); }} disabled={loading || saving}>
            {t("modelScope.clear")}
          </ConfigButton>
          <ConfigButton
            size="small"
            variant="primary"
            onClick={() => void save()}
            disabled={loading || saving || !dirty || emptySelection}
            title={emptySelection ? t("modelScope.emptySaveHint") : undefined}
          >
            {saving ? t("modelScope.saving") : savedOk && !dirty ? t("modelScope.saved") : t("modelScope.save")}
          </ConfigButton>
        </div>

        {warnings.length > 0 && (
          <div className="model-scope-warnings" role="alert">
            {warnings.map((warning, index) => <div key={`${index}-${warning}`}>{warning}</div>)}
          </div>
        )}
        {error && <div className="model-scope-error" role="alert">{error}</div>}

        <div className="model-scope-list">
          {loading ? (
            <div className="model-scope-placeholder">{t("modelScope.loading")}</div>
          ) : filteredGroups.length === 0 ? (
            <div className="model-scope-placeholder">{t("modelScope.noModels")}</div>
          ) : (
            filteredGroups.map(([provider, providerModels]) => {
              const providerIds = providerModels.map(modelKey);
              const enabledCount = selected === null
                ? providerIds.length
                : providerIds.filter((id) => selected.has(id)).length;
              const allOn = enabledCount === providerIds.length;
              const noneOn = enabledCount === 0;
              return (
                <section key={provider} className="model-scope-provider">
                  <label className="model-scope-provider-head">
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = !allOn && !noneOn; }}
                      onChange={() => setProviderModels(providerIds, !allOn)}
                      disabled={saving}
                    />
                    <strong>{provider}</strong>
                    <span className="model-scope-provider-count">{enabledCount}/{providerIds.length}</span>
                  </label>
                  {providerModels.map((model) => {
                    const id = modelKey(model);
                    return (
                      <label key={id} className="model-scope-row">
                        <input
                          type="checkbox"
                          checked={selected === null || selected.has(id)}
                          onChange={() => toggleModel(id)}
                          disabled={saving}
                        />
                        <span className="model-scope-model-name">{model.name || model.id}</span>
                        <code className="model-scope-model-id">{model.id}</code>
                      </label>
                    );
                  })}
                </section>
              );
            })
          )}
          {!loading && unavailableIds.length > 0 && (
            <section className="model-scope-provider">
              <div className="model-scope-provider-head">
                <strong>{t("modelScope.unavailable")}</strong>
                <span className="model-scope-provider-count">{unavailableIds.length}</span>
              </div>
              {unavailableIds.map((id) => (
                <label key={id} className="model-scope-row is-unavailable">
                  <input
                    type="checkbox"
                    checked
                    onChange={() => toggleModel(id)}
                    disabled={saving}
                  />
                  <code className="model-scope-model-id">{id}</code>
                </label>
              ))}
            </section>
          )}
        </div>
      </div>
    </ConfigPanelShell>
  );
}
