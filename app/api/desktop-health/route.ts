export const dynamic = "force-dynamic";

/**
 * Sidecar identity check used only by the Tauri shell. A per-launch nonce
 * prevents a loopback port race from navigating WebView2 to an unrelated local
 * HTTP server that happened to claim the selected port first.
 */
export function GET() {
  const token = process.env.PI_WEB_DESKTOP_HEALTH_TOKEN;
  if (!process.env.PI_WEB_DESKTOP || !token) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(token, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
