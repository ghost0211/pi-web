import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../hooks/useTheme.ts", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");

test("opens one settings panel from direct sidebar shortcuts", () => {
  assert.match(shellSource, /<SettingsPanel/);
  assert.match(shellSource, /setSettingsSection\(/);
  assert.match(shellSource, /initialSection=\{settingsSection\}/);
  assert.match(shellSource, /translate\("common\.settings"\)/);
  assert.doesNotMatch(shellSource, /\["plugins", translate\("common\.plugins"\)\]/);
  assert.doesNotMatch(shellSource, /setModelsConfigOpen|setSkillsConfigOpen|setAgentsConfigOpen|setPluginsConfigOpen/);
});

test("sidebar archive/project entry points open one full session manager with an explicit filter", () => {
  assert.match(shellSource, /window\.addEventListener\(OPEN_SESSION_MANAGEMENT_EVENT, openManagement\)/);
  assert.match(shellSource, /setSettingsSection\("sessions"\)/);
  assert.match(panelSource, /key=\{sessionManagementRequest\?\.serial \?\? 0\}/);
  assert.match(panelSource, /initialFilter=\{sessionManagementRequest\?\.filter\}/);
  assert.match(panelSource, /initialProjectKey=\{sessionManagementRequest\?\.projectKey\}/);
  assert.match(panelSource, /onSelectSession=\{onSelectSession\}/);
});

test("archived and not-yet-migrated main sessions cannot show a writable composer", () => {
  assert.match(shellSource, /archived=\{selectedSessionArchived\}/);
  assert.match(shellSource, /managementPending=\{Boolean\(selectedSession && !management\.ready\)\}/);
  assert.match(shellSource, /onRestoreArchived=\{\(\) => void restoreSelectedSession\(\)\}/);
  assert.match(shellSource, /window\.addEventListener\(SESSION_CATALOG_CHANGED_EVENT, onCatalogChanged\)/);
  assert.match(shellSource, /if \(selectedSession && removed\.has\(selectedSession\.id\)\) handleSessionDeleted/);
});

test("confirmed batches cannot be dismissed before partial failures are observable", () => {
  assert.match(panelSource, /onOperationBusyChange=\{setSessionsBusy\}/);
  assert.match(panelSource, /if \(!sessionsBusy\) onClose\(\)/);
  assert.match(panelSource, /event\.target === event\.currentTarget && !sessionsBusy/);
  assert.match(panelSource, /disabled=\{sessionsBusy\} onClick=\{onClose\}/);
  assert.match(panelSource, /const activateSection = [\s\S]*?if \(sessionsBusy\) return;/);
});

test("keeps every requested configuration surface inside the settings panel", () => {
  for (const section of ["general", "models", "model-scope", "mcp", "skills", "agents", "plugins"]) {
    assert.match(panelSource, new RegExp(`id: "${section}"`));
  }
  for (const component of ["ModelsConfig", "ModelScopeConfig", "McpConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(panelSource, new RegExp(`<${component} embedded`));
  }
});

test("restores the settings section and each list detail selection", async () => {
  assert.match(shellSource, /getLastSettingsSection\(projectTrustCwd\)/);
  assert.match(panelSource, /setLastSettingsSection\(initialSection\)/);
  assert.match(panelSource, /setLastSettingsSection\(nextSection\)/);
  for (const name of ["ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(
      await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8"),
      /getLastSettingsSelection/,
    );
  }
});

test("keeps visited settings sections mounted and contains nested Escape handling", async () => {
  const modelsSource = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
  assert.match(panelSource, /mountedSections\.has\(id\)/);
  assert.match(panelSource, /hidden=\{section !== id\}/);
  assert.match(panelSource, /event\.defaultPrevented/);
  assert.match(modelsSource, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*onClose\(\);/);
});

test("offers direct light, dark, and system theme selection", () => {
  for (const preference of ["light", "dark", "auto"]) {
    assert.match(panelSource, new RegExp(`id: "${preference}"`));
  }
  assert.match(panelSource, /setThemePreference\(option\.id\)/);
  assert.match(themeSource, /const setThemePreference = useCallback/);
});

test("keeps General free of divider rows", () => {
  assert.match(panelSource, /className="settings-dialog-header"/);
  assert.doesNotMatch(panelSource, /sections\.find\(\(item\) => item\.id === section\)/);
  assert.doesNotMatch(panelSource, /<section style=\{\{[^}]*borderBottom/);
  assert.doesNotMatch(panelSource, /borderLeft: index > 0/);
});

test("uses sidebar navigation on desktop and one compact section picker on mobile", () => {
  assert.match(panelSource, /className="settings-mobile-section-picker"/);
  assert.match(panelSource, /className="settings-section-tabs"/);
  assert.match(panelSource, /className="settings-section-tab"/);
  assert.match(cssSource, /\.settings-section-tab \{/);
  assert.match(cssSource, /\.settings-section-icon \{[\s\S]*?flex-shrink: 0/);
  assert.match(cssSource, /\.settings-section-tab\[aria-current="page"\]/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.settings-section-tabs \{[\s\S]*?display: none/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.settings-mobile-section-picker \{[\s\S]*?display: block/);
  assert.doesNotMatch(panelSource, /width: isMobile \? "100%" : 188/);
  assert.match(panelSource, /<main className="settings-dialog-main">/);
  assert.doesNotMatch(panelSource, /<style>/);
  assert.doesNotMatch(panelSource, /style=\{\{/);
});

test("session manager reserves the floating Settings close button lane only on desktop", () => {
  const desktopRule = cssSource.match(/\.settings-section-host \.sessions-manager-header \{([^}]+)\}/)?.[1];
  assert.match(desktopRule ?? "", /padding-inline-end: 64px/);
  const mobileRules = cssSource.slice(cssSource.indexOf("@media (max-width: 640px)"));
  assert.match(mobileRules, /\.settings-dialog-header \{[^}]*position: relative/);
  assert.match(mobileRules, /\.settings-section-host \.sessions-manager-header \{[^}]*padding-inline-end: 18px/);
  assert.match(cssSource, /\.sessions-manager-header-info \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
  assert.match(cssSource, /\.sessions-manager-refresh \{[^}]*flex-shrink: 0/);
});

test("shows all SDK startup modes in a compact card-row selector", () => {
  assert.match(panelSource, /className="settings-shell-select settings-startup-select"/);
  for (const mode of ["false", "header", "true"]) assert.ok(panelSource.includes(`<option value="${mode}">`));
  assert.match(cssSource, /\.settings-startup-select \{[\s\S]*?width: auto;[\s\S]*?max-width: 50%;[\s\S]*?flex-shrink: 0/);
});

test("labels agent profiles as sub-agents", () => {
  assert.match(enSource, /"common\.agents": "Sub-agents"/);
  assert.match(enSource, /"agents\.new": "New sub-agent"/);
  assert.match(zhSource, /"common\.agents": "子代理"/);
  assert.match(zhSource, /"agents\.new": "新建子代理"/);
});

test("uses the child-session robot glyph for the sub-agents tab", () => {
  const robotGlyph = /<rect x="5" y="7" width="14" height="11" rx="2" \/>\s*<path d="M9 11h\.01M15 11h\.01M9 15h6M12 7V4M10 4h4" \/>/;
  assert.match(panelSource, robotGlyph);
  assert.match(sidebarSource, robotGlyph);
  assert.match(panelSource, /section === "agents"[\s\S]*?className="settings-section-icon is-agent"/);
  assert.match(cssSource, /\.settings-section-icon\.is-agent \{[\s\S]*?transform: scale\(1\.25\)/);
});

test("embeds Codemode advanced controls with the current session's explicit reload callback", () => {
  assert.match(panelSource, /<CodemodeSettings sessionId=\{sessionId\} onSessionReloaded=\{onSessionReloaded\}/);
  assert.match(panelSource, /<McpConfig embedded[^\n]*cwd=\{cwd\}[^\n]*sessionId=\{sessionId\}/);
  assert.match(panelSource, /id: "mcp", label: t\("mcp\.title"\), requiresProject: false/);
});

test("uses the compact controls glyph for General", () => {
  assert.match(panelSource, /section === "general"[\s\S]*?<path d="M20 7h-9M14 17H5" \/>[\s\S]*?<circle cx="7" cy="7" r="3" \/>[\s\S]*?<circle cx="17" cy="17" r="3" \/>/);
});
