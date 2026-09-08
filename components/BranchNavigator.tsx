"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type { BranchPreview, SessionEntry, SessionTreeNode } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** Set/clear a bookmark label on an entry (pi `/tree` labels). */
  onSetLabel?: (entryId: string, label: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean;
  /** Keep the inline dropdown mounted while another control supplies its trigger */
  hideInlineButton?: boolean;
}

// Find the visible entry IDs on the path from root to activeLeafId.
// Iterative DFS: a linear session degrades into a chain whose depth equals the
// entry count, so a recursive search overflows the call stack. Walk with an
// explicit stack instead (paths accumulate depth, not the call stack).
export function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  const target = targetId;
  const stack: { node: SessionTreeNode; path: string[] }[] = nodes.map((n) => ({ node: n, path: [n.entry.id] }));
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node.entry.id === target || node.compressedEntryIds?.includes(target)) {
      return new Set(path);
    }
    for (const child of node.children) {
      stack.push({ node: child, path: [...path, child.entry.id] });
    }
  }
  return new Set();
}

function isMessageEntry(entry: SessionEntry): boolean {
  return entry.type === "message" && "message" in entry;
}

// Compress a visible linear chain into the first branching/leaf node.
// Server-side compressed IDs also count as skipped nodes. Bookmarked (labeled)
// nodes are never compressed away: they stay visible as their own row so the
// navigator can surface and target them.
// branchPreview is the bounded preview of the first message on the source
// chain. labelEntry keeps unprojected/test shapes working as a fallback.
export function compressChain(node: SessionTreeNode): {
  node: SessionTreeNode;
  skipped: number;
  branchPreview?: BranchPreview;
  labelEntry: SessionEntry;
} {
  let current = node;
  let branchPreview = current.branchPreview;
  let labelEntry: SessionEntry | null = isMessageEntry(current.entry) ? current.entry : null;
  let skipped = current.compressedEntryIds?.length ?? 0;
  while (current.children.length === 1 && current.label === undefined) {
    current = current.children[0];
    branchPreview ??= current.branchPreview;
    if (!labelEntry && isMessageEntry(current.entry)) labelEntry = current.entry;
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }
  return { node: current, skipped, branchPreview, labelEntry: labelEntry ?? current.entry };
}

// Top-level rows of the panel: with multiple roots (a branch was started from
// the very first message) the roots themselves are the branches; otherwise the
// children of the first branching node. Linear sessions (no branching) fall
// back to their root so the panel stays reachable for bookmarking.
export function selectTopLevelBranches(tree: SessionTreeNode[]): SessionTreeNode[] {
  if (tree.length > 1) return tree;
  if (tree.length === 0) return [];
  const first = compressChain(tree[0]).node;
  return first.children.length > 1 ? first.children : [tree[0]];
}

function getLabel(entry: SessionEntry): string {
  if (entry.type === "message" && "message" in entry) {
    const msg = entry.message as { role: string; content: unknown };
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    if (text.length > 40) text = text.slice(0, 40) + "…";
    if (text) return text;
    if (msg.role === "assistant") return "[assistant]";
  }
  return entry.type;
}

// Does the tree have any branching at all? Iterative: a linear chain has no
// branching but recursing over it would overflow the stack, so walk with a stack.
export function hasSessionBranches(nodes: SessionTreeNode[]): boolean {
  // Sessions branched from the very first message have multiple root nodes.
  if (nodes.length > 1) return true;
  const stack: SessionTreeNode[] = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.children.length > 1) return true;
    for (const child of node.children) stack.push(child);
  }
  return false;
}

interface FlatBranchRow {
  node: SessionTreeNode;
  depth: number;
  text: string;
  bookmark?: string;
  role: "user" | "assistant" | null;
}

/** Flatten the visible (compressed) tree into rows, mirroring TreeNodeView. */
function flattenBranchRows(nodes: SessionTreeNode[]): FlatBranchRow[] {
  const rows: FlatBranchRow[] = [];
  const stack = nodes.map((node) => ({ node, depth: 0 })).reverse();
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const { node: rep, branchPreview, labelEntry } = compressChain(node);
    const role = branchPreview
      ? branchPreview.role ?? null
      : isMessageEntry(labelEntry)
        ? ((labelEntry as { message: { role: string } }).message.role as "user" | "assistant")
        : null;
    rows.push({
      node: rep,
      depth,
      text: branchPreview?.text ?? getLabel(labelEntry),
      bookmark: rep.label,
      role,
    });
    for (let i = rep.children.length - 1; i >= 0; i--) {
      stack.push({ node: rep.children[i], depth: depth + 1 });
    }
  }
  return rows;
}

interface LabelEditState {
  entryId: string;
  value: string;
}

function BookmarkBadge({ text }: { text: string }) {
  return (
    <span
      title={text}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontSize: 9,
        fontFamily: "var(--font-mono)",
        color: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 10%, transparent)",
        border: "1px solid color-mix(in srgb, var(--accent) 30%, transparent)",
        borderRadius: 3,
        padding: "0 4px",
        marginLeft: 5,
        flexShrink: 0,
        lineHeight: "15px",
        maxWidth: 140,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      {text}
    </span>
  );
}

function LabelEditRow({
  entryId,
  edit,
  onChange,
  onSetLabel,
  indent,
}: {
  entryId: string;
  edit: LabelEditState;
  onChange: (state: LabelEditState | null) => void;
  onSetLabel: (entryId: string, label: string | null) => void;
  indent: number;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = () => {
    const value = edit.value.trim();
    onSetLabel(entryId, value ? value : null);
    onChange(null);
  };
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 4, height: 28, paddingLeft: indent, paddingRight: 4 }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={edit.value}
        placeholder={t("i18n.labelPlaceholder")}
        onChange={(event) => onChange({ entryId, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onChange(null);
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          padding: "2px 6px",
          background: "var(--bg)",
          border: "1px solid var(--accent)",
          borderRadius: 4,
          color: "var(--text)",
          outline: "none",
        }}
      />
      <button
        type="button"
        onClick={commit}
        style={{
          flexShrink: 0, padding: "2px 7px", fontSize: 10, borderRadius: 4,
          border: "1px solid var(--border)", background: "var(--bg-hover)",
          color: "var(--text)", cursor: "pointer",
        }}
      >
        {t("i18n.saveLabel")}
      </button>
    </div>
  );
}

interface TreeNodeProps {
  node: SessionTreeNode;
  activePathIds: Set<string>;
  depth: number;
  isLast: boolean;
  parentLines: boolean[]; // whether ancestor at each depth has more siblings after
  onSelect: (id: string) => void;
  onSetLabel?: (entryId: string, label: string | null) => void;
  labelEdit: LabelEditState | null;
  onLabelEditChange: (state: LabelEditState | null) => void;
}

function TreeNodeView({ node, activePathIds, depth, isLast, parentLines, onSelect, onSetLabel, labelEdit, onLabelEditChange }: TreeNodeProps) {
  const { t } = useI18n();
  const { node: rep, skipped, branchPreview, labelEntry } = compressChain(node);
  const isActive = activePathIds.has(rep.entry.id);
  const isOnPath = activePathIds.has(node.entry.id) || activePathIds.has(rep.entry.id);
  const label = branchPreview?.text ?? getLabel(labelEntry);
  const role = branchPreview
    ? branchPreview.role ?? null
    : isMessageEntry(labelEntry)
      ? (labelEntry as { message: { role: string } }).message.role
      : null;
  const editing = labelEdit?.entryId === rep.entry.id;

  return (
    <div>
      {/* This node row */}
      <div
        className="branch-tree-row"
        style={{
          display: "flex",
          alignItems: "center",
          height: 24,
          cursor: "pointer",
        }}
        onClick={() => onSelect(rep.entry.id)}
      >
        {/* Indent guide lines */}
        {parentLines.map((hasLine, i) => (
          <div key={i} style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
            {hasLine && (
              <div style={{
                position: "absolute",
                left: 7,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--border)",
              }} />
            )}
          </div>
        ))}

        {/* Branch connector */}
        <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
          {/* vertical line up (to parent) */}
          <div style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: isLast ? "50%" : 0,
            width: 1,
            background: "var(--border)",
          }} />
          {/* horizontal line to node */}
          <div style={{
            position: "absolute",
            left: 7,
            top: "50%",
            width: 9,
            height: 1,
            background: "var(--border)",
          }} />
        </div>

        {/* Node dot */}
        <div style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flexShrink: 0,
          background: isActive ? "var(--accent)" : isOnPath ? "var(--text-muted)" : "var(--border)",
          border: isActive ? "none" : "1px solid var(--text-dim)",
          marginRight: 6,
          transition: "background 0.12s",
        }} />

        {/* Role badge */}
        {role && (
          <span style={{
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            color: role === "user" ? "var(--accent)" : "var(--text-dim)",
            background: role === "user" ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
            border: `1px solid ${role === "user" ? "rgba(37,99,235,0.2)" : "var(--border)"}`,
            borderRadius: 3,
            padding: "0 4px",
            marginRight: 5,
            flexShrink: 0,
            lineHeight: "16px",
          }}>
            {role === "user" ? "U" : "A"}
          </span>
        )}

        {/* Skipped indicator */}
        {skipped > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>
            +{skipped}
          </span>
        )}

        {/* Label */}
        <span style={{
          fontSize: 11,
          color: isActive ? "var(--text)" : isOnPath ? "var(--text-muted)" : "var(--text-dim)",
          fontWeight: isActive ? 500 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}>
          {label}
        </span>

        {/* Bookmark badge */}
        {rep.label && <BookmarkBadge text={rep.label} />}

        {/* Bookmark toggle (revealed on row hover via CSS) */}
        {onSetLabel && !editing && (
          <button
            type="button"
            className="branch-bookmark-button"
            title={rep.label ? t("i18n.editLabel") : t("i18n.addLabel")}
            aria-label={rep.label ? t("i18n.editLabel") : t("i18n.addLabel")}
            onClick={(event) => {
              event.stopPropagation();
              onLabelEditChange({ entryId: rep.entry.id, value: rep.label ?? "" });
            }}
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              padding: 0,
              marginLeft: 4,
              background: "none",
              border: "none",
              borderRadius: 3,
              color: rep.label ? "var(--accent)" : "var(--text-dim)",
              cursor: "pointer",
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill={rep.label ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        )}
      </div>

      {editing && onSetLabel && (
        <LabelEditRow
          entryId={rep.entry.id}
          edit={labelEdit}
          onChange={onLabelEditChange}
          onSetLabel={onSetLabel}
          indent={(parentLines.length + 1) * 16 + 13}
        />
      )}

      {/* Children */}
      {rep.children.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activePathIds={activePathIds}
          depth={depth + 1}
          isLast={idx === rep.children.length - 1}
          parentLines={[...parentLines, !isLast]}
          onSelect={onSelect}
          onSetLabel={onSetLabel}
          labelEdit={labelEdit}
          onLabelEditChange={onLabelEditChange}
        />
      ))}
    </div>
  );
}

function BranchPanelToolbar({
  search,
  onSearchChange,
  labeledOnly,
  onToggleLabeledOnly,
  labeledCount,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  labeledOnly: boolean;
  onToggleLabeledOnly: () => void;
  labeledCount: number;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 12px 6px" }}>
      <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
        <svg
          width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "var(--text-dim)", pointerEvents: "none" }}
        >
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("i18n.searchBranches")}
          style={{
            width: "100%",
            height: 24,
            fontSize: 11,
            padding: "0 8px 0 22px",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 5,
            color: "var(--text)",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>
      <button
        type="button"
        onClick={onToggleLabeledOnly}
        title={t("i18n.labeledOnly")}
        aria-pressed={labeledOnly}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 24,
          padding: "0 8px",
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          background: labeledOnly ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "var(--bg)",
          border: `1px solid ${labeledOnly ? "color-mix(in srgb, var(--accent) 40%, transparent)" : "var(--border)"}`,
          borderRadius: 5,
          color: labeledOnly ? "var(--accent)" : "var(--text-muted)",
          cursor: "pointer",
        }}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill={labeledOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
        {labeledCount}
      </button>
    </div>
  );
}

export function BranchNavigator({ tree, activeLeafId, onLeafChange, onSetLabel, inline, containerRef, open: openProp, onToggle, hasSession, compact, hideInlineButton }: Props) {
  const { t } = useI18n();
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [search, setSearch] = useState("");
  const [labeledOnly, setLabeledOnly] = useState(false);
  const [labelEdit, setLabelEdit] = useState<LabelEditState | null>(null);

  useEffect(() => {
    if (!open || !inline) return;
    const anchor = containerRef?.current ?? btnRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    return () => ro.disconnect();
  }, [open, inline, containerRef]);

  const activePathIds = useMemo(
    () => buildActivePath(tree, activeLeafId),
    [tree, activeLeafId]
  );

  const handleSelect = useCallback((id: string) => {
    onLeafChange(id);
  }, [onLeafChange]);

  // Reset transient panel state whenever the dropdown closes.
  useEffect(() => {
    if (!open) {
      setSearch("");
      setLabeledOnly(false);
      setLabelEdit(null);
    }
  }, [open]);

  const noBranchReason = !hasSession
    ? t("i18n.noActiveSession")
    : tree.length === 0
      ? t("i18n.noBranches")
      : null;

  const topLevel = selectTopLevelBranches(tree);
  const hasContent = !noBranchReason && topLevel.length > 0;

  const flatRows = useMemo(() => flattenBranchRows(topLevel), [topLevel]);
  const labeledCount = useMemo(() => flatRows.filter((row) => row.bookmark).length, [flatRows]);
  const query = search.trim().toLowerCase();
  const filtering = query.length > 0 || labeledOnly;
  const filteredRows = useMemo(() => {
    if (!filtering) return [];
    return flatRows.filter((row) => {
      if (labeledOnly && !row.bookmark) return false;
      if (!query) return true;
      return row.text.toLowerCase().includes(query) || (row.bookmark ?? "").toLowerCase().includes(query);
    });
  }, [flatRows, filtering, labeledOnly, query]);

  const treeList = (
    <>
      {topLevel.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activePathIds={activePathIds}
          depth={0}
          isLast={idx === topLevel.length - 1}
          parentLines={[]}
          onSelect={handleSelect}
          onSetLabel={onSetLabel}
          labelEdit={labelEdit}
          onLabelEditChange={setLabelEdit}
        />
      ))}
    </>
  );

  const filteredList = filteredRows.length === 0 ? (
    <div style={{ padding: "8px 2px", fontSize: 12, color: "var(--text-dim)", fontStyle: "italic" }}>
      {labeledOnly && !query ? t("i18n.noLabels") : t("i18n.noBranches")}
    </div>
  ) : (
    <>
      {filteredRows.map((row) => {
        const isActive = activePathIds.has(row.node.entry.id);
        const editing = labelEdit?.entryId === row.node.entry.id;
        return (
          <div key={row.node.entry.id}>
            <div
              className="branch-tree-row"
              style={{ display: "flex", alignItems: "center", height: 24, cursor: "pointer", paddingLeft: Math.min(row.depth, 12) * 12 }}
              onClick={() => handleSelect(row.node.entry.id)}
            >
              <div style={{
                width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                background: isActive ? "var(--accent)" : "var(--border)",
                border: isActive ? "none" : "1px solid var(--text-dim)",
                marginRight: 6,
              }} />
              {row.role && (
                <span style={{
                  fontSize: 9, fontFamily: "var(--font-mono)",
                  color: row.role === "user" ? "var(--accent)" : "var(--text-dim)",
                  background: row.role === "user" ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
                  border: `1px solid ${row.role === "user" ? "rgba(37,99,235,0.2)" : "var(--border)"}`,
                  borderRadius: 3, padding: "0 4px", marginRight: 5, flexShrink: 0, lineHeight: "16px",
                }}>
                  {row.role === "user" ? "U" : "A"}
                </span>
              )}
              <span style={{
                fontSize: 11,
                color: isActive ? "var(--text)" : "var(--text-dim)",
                fontWeight: isActive ? 500 : 400,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                flex: 1, minWidth: 0,
              }}>
                {row.text}
              </span>
              {row.bookmark && <BookmarkBadge text={row.bookmark} />}
              {onSetLabel && !editing && (
                <button
                  type="button"
                  className="branch-bookmark-button"
                  title={row.bookmark ? t("i18n.editLabel") : t("i18n.addLabel")}
                  aria-label={row.bookmark ? t("i18n.editLabel") : t("i18n.addLabel")}
                  onClick={(event) => {
                    event.stopPropagation();
                    setLabelEdit({ entryId: row.node.entry.id, value: row.bookmark ?? "" });
                  }}
                  style={{
                    flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                    width: 18, height: 18, padding: 0, marginLeft: 4,
                    background: "none", border: "none", borderRadius: 3,
                    color: row.bookmark ? "var(--accent)" : "var(--text-dim)", cursor: "pointer",
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill={row.bookmark ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                </button>
              )}
            </div>
            {editing && onSetLabel && (
              <LabelEditRow
                entryId={row.node.entry.id}
                edit={labelEdit}
                onChange={setLabelEdit}
                onSetLabel={onSetLabel}
                indent={Math.min(row.depth, 12) * 12 + 13}
              />
            )}
          </div>
        );
      })}
    </>
  );

  const panelBody = hasContent ? (
    <>
      <style>{`
        .branch-tree-row .branch-bookmark-button { opacity: 0; transition: opacity 0.12s; }
        .branch-tree-row:hover .branch-bookmark-button,
        .branch-tree-row:focus-within .branch-bookmark-button { opacity: 1; }
      `}</style>
      <BranchPanelToolbar
        search={search}
        onSearchChange={setSearch}
        labeledOnly={labeledOnly}
        onToggleLabeledOnly={() => setLabeledOnly((value) => !value)}
        labeledCount={labeledCount}
      />
      <div style={{ padding: "0 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}>
        {filtering ? filteredList : treeList}
      </div>
    </>
  ) : (
    <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
      {noBranchReason ?? t("i18n.noBranches")}
    </div>
  );

  const branchIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );

  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );


  if (inline) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          ref={btnRef}
          onClick={() => onToggle ? onToggle() : setOpenInternal((v) => !v)}
          style={{
            display: hideInlineButton ? "none" : "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: "pointer",
            color: open ? "var(--text)" : "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
           title={t("i18n.branches")}
           aria-label={t("i18n.branches")}
          aria-pressed={open}
        >
          {branchIcon}
           {!compact && <span>{t("i18n.branches")}</span>}
        </button>
        {open && dropdownPos && (
          <div style={{
            position: "fixed",
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border)",
            zIndex: 500,
          }}>
            {panelBody}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}>
      {/* Header toggle */}
      <button
        onClick={() => setOpenInternal((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        {branchIcon}
         <span style={{ color: "var(--text-muted)" }}>{t("i18n.branches")}</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          zIndex: 100,
        }}>
          {panelBody}
        </div>
      )}
    </div>
  );
}
