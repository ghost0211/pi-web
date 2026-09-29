import { jsonResponse } from "@/lib/json-response";
import { loadSshHosts, upsertSshHost, validateSshHostInput } from "@/lib/ssh-hosts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return jsonResponse(request, { hosts: loadSshHosts() });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "Invalid JSON body" }, { status: 400 });
  }
  const input = (body as Record<string, unknown>)?.host ?? body;
  const invalid = validateSshHostInput(input);
  if (invalid) return jsonResponse(request, { error: invalid }, { status: 400 });
  const entry = upsertSshHost(input as Parameters<typeof upsertSshHost>[0]);
  return jsonResponse(request, { host: entry });
}
