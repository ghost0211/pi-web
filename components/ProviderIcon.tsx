const PROVIDER_ICONS: Record<string, { symbol: string; color: boolean }> = {
  anthropic: { symbol: "anthropic", color: false },
  openai: { symbol: "openai", color: false },
  "openai-codex": { symbol: "openai", color: false },
  google: { symbol: "google", color: true },
  "google-vertex": { symbol: "google", color: true },
  "ant-ling": { symbol: "antgroup", color: true },
  deepseek: { symbol: "deepseek", color: true },
  groq: { symbol: "groq", color: false },
  mistral: { symbol: "mistral", color: true },
  moonshotai: { symbol: "moonshot", color: false },
  "moonshotai-cn": { symbol: "moonshot", color: false },
  moonshot: { symbol: "moonshot", color: false },
  minimax: { symbol: "minimax", color: true },
  "minimax-cn": { symbol: "minimax", color: true },
  fireworks: { symbol: "fireworks", color: true },
  huggingface: { symbol: "huggingface", color: true },
  cerebras: { symbol: "cerebras", color: true },
  openrouter: { symbol: "openrouter", color: false },
  xai: { symbol: "xai", color: false },
  "cloudflare-ai-gateway": { symbol: "cloudflare", color: true },
  "cloudflare-workers-ai": { symbol: "cloudflare", color: true },
  "vercel-ai-gateway": { symbol: "vercel", color: false },
  "github-copilot": { symbol: "githubcopilot", color: false },
  "amazon-bedrock": { symbol: "aws", color: true },
  azure: { symbol: "azure", color: true },
  "azure-openai-responses": { symbol: "azure", color: true },
  "kimi-coding": { symbol: "kimi", color: true },
  nvidia: { symbol: "nvidia", color: true },
  opencode: { symbol: "opencode", color: false },
  "opencode-go": { symbol: "opencode", color: false },
  qwen: { symbol: "qwen", color: true },
  xiaomi: { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-ams": { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-cn": { symbol: "xiaomimimo", color: false },
  "xiaomi-token-plan-sgp": { symbol: "xiaomimimo", color: false },
  zai: { symbol: "zai", color: false },
  "zai-coding-cn": { symbol: "zai", color: false },
  zhipu: { symbol: "zhipu", color: true },
  cohere: { symbol: "cohere", color: true },
  perplexity: { symbol: "perplexity", color: true },
  together: { symbol: "together", color: true },
  grok: { symbol: "grok", color: false },
};

const CUSTOM_PROVIDER_PREFIX = "custom-";

function lookupProviderIcon(id: string): { symbol: string; color: boolean } | null {
  const normalized = id.trim().toLowerCase();
  if (!normalized) return null;
  const exact = PROVIDER_ICONS[normalized];
  if (exact) return exact;
  // User-defined providers are commonly named `custom-<vendor>` (or
  // `<team>-<vendor>`); fall back to the vendor icon when the tail matches a
  // known provider at a separator boundary.
  const withoutCustomPrefix = normalized.startsWith(CUSTOM_PROVIDER_PREFIX)
    ? normalized.slice(CUSTOM_PROVIDER_PREFIX.length)
    : null;
  if (withoutCustomPrefix && PROVIDER_ICONS[withoutCustomPrefix]) return PROVIDER_ICONS[withoutCustomPrefix];
  let best: { symbol: string; color: boolean; keyLength: number } | null = null;
  for (const key of Object.keys(PROVIDER_ICONS)) {
    if (normalized.endsWith(`-${key}`) || normalized.endsWith(`_${key}`)) {
      if (!best || key.length > best.keyLength) best = { ...PROVIDER_ICONS[key], keyLength: key.length };
    }
  }
  return best ? { symbol: best.symbol, color: best.color } : null;
}

/** Icon entry for a provider id, or null when no known provider matches. */
export function resolveProviderIcon(id: string | null | undefined): { symbol: string; color: boolean } | null {
  return id ? lookupProviderIcon(id) : null;
}

/** Generic chip glyph shown for providers without a known icon. */
export function DefaultModelIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
    </svg>
  );
}

/**
 * Fixed-size provider glyph for compact slots such as the model selector: the
 * provider's icon when known, the default chip icon otherwise.
 */
export function ProviderGlyph({ id, size }: { id: string | null | undefined; size: number }) {
  if (!resolveProviderIcon(id)) return <DefaultModelIcon size={size} />;
  return <ProviderIcon id={id!} size={size} />;
}

export function ProviderIcon({ id, size }: { id: string; size: number }) {
  const icon = lookupProviderIcon(id);
  if (icon) {
    // Brand-colored paths keep their authored fills; neutral paths in those
    // symbols can opt into this theme-aware foreground with `currentColor`.
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={icon.color ? undefined : "currentColor"}
        style={{ color: "var(--text-muted)", flexShrink: 0 }}
      >
        <use href={`/provider-icons.svg#${icon.symbol}`} />
      </svg>
    );
  }

  const label = id
    .split(/[-_]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--text-dim)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        fontSize: Math.max(8, Math.floor(size * 0.42)),
        fontWeight: 700,
        lineHeight: 1,
      }}
    >
      {label}
    </span>
  );
}
