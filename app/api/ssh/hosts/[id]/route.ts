import { jsonResponse } from "@/lib/json-response";
import { deleteSshHost, loadSshHosts, upsertSshHost, validateSshHostInput } from "@/lib/ssh-hosts";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ id: string }>;
}

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 });
  }
  const input = (body as Record<string, unknown>)?.host ?? body;
  const invalid = validateSshHostInput(input);
  if (invalid) return jsonResponse(request, { error: invalid }, { status: 400 });
  if (!loadSshHosts().some((host) => host.id === id)) {
    return jsonResponse(request, { error: "Host not found" }, { status: 404 });
  }
  const entry = upsertSshHost(input as Parameters<typeof upsertSshHost>[0], id);
  return jsonResponse(request, { host: entry });
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  if (!deleteSshHost(id)) return jsonResponse(request, { error: "Host not found" }, { status: 404 });
  return jsonResponse(request, { ok: true });
}
