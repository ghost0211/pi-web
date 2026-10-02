import { handleDelete, handleGet, handlePut } from "@/lib/mcp-route-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleGet(request);
}

export async function PUT(request: Request) {
  return handlePut(request);
}

export async function DELETE(request: Request) {
  return handleDelete(request);
}
