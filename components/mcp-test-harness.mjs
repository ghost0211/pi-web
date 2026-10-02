// Minimal deterministic hook driver: no DOM dependency, effects and deferred fetches are explicit.
import React from "react";
export function componentHarness(Component, initialProps) {
  const slots = []; let cursor = 0; let pending = []; let props = initialProps;
  const context = { t: (key) => key };
  const hooks = {
    useContext: () => context,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) {
      const index = cursor++; const old = slots[index];
      if (old && deps?.every((value, i) => Object.is(value, old.deps?.[i]))) return;
      old?.cleanup?.();
      slots[index] = { deps };
      pending.push(() => { slots[index].cleanup = callback(); });
    },
  };
  const expand = (value) => {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (!value || typeof value !== "object") return value;
    if (typeof value.type === "function") return expand(value.type(value.props));
    return { ...value, props: { ...value.props, children: expand(value.props?.children) } };
  };
  const nodes = (value) => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== "object") return [];
    return [value, ...nodes(value.props?.children)];
  };
  const text = (value) => Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" ? text(value.props?.children) : value === false || value === null || value === undefined ? "" : String(value);
  let tree;
  const render = (next = props) => {
    props = next; cursor = 0;
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const before = internals.H; internals.H = hooks;
    const beforeReact = globalThis.React; globalThis.React = React; // jiti's classic JSX transform
    try { tree = expand(Component(props)); }
    finally {
      internals.H = before;
      if (beforeReact === undefined) delete globalThis.React; else globalThis.React = beforeReact;
    }
    const effects = pending; pending = []; effects.forEach((effect) => effect());
    return tree;
  };
  return {
    render,
    button(label) { return nodes(tree).find((node) => node.type === "button" && text(node) === label); },
    input(label) { return nodes(tree).find((node) => ["input", "textarea"].includes(node.type) && node.props["aria-label"] === label); },
    text: () => text(tree),
    cleanup() { slots.forEach((value) => value?.cleanup?.()); },
  };
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));
