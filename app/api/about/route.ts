import { NextResponse } from "next/server";
import {
  getAboutInfo,
  executePiAgentUpdate,
  type UpdatePiAgentRequest,
} from "@/lib/about-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const force = searchParams.get("force") === "true" || searchParams.get("check") === "true";
    const info = await getAboutInfo(force);
    return NextResponse.json(info);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    let body: UpdatePiAgentRequest = {};
    try {
      body = (await request.json()) as UpdatePiAgentRequest;
    } catch {
      // Body can be empty, default to global update
    }

    // The embedded SDK is bundled with the app and is never updated from the
    // client — a desktop install replaces it wholesale, and updating it under
    // the running app would corrupt the install. Only the global npm CLI may be
    // updated from here.
    if (body.target === "local") {
      return NextResponse.json(
        {
          success: false,
          error: "Embedded SDK updates are not supported; the desktop app updates it on upgrade.",
          output: "",
          previousVersion: null,
          newVersion: null,
          target: "local",
        },
        { status: 400 },
      );
    }
    const result = await executePiAgentUpdate("global");

    return NextResponse.json(result, {
      status: result.success ? 200 : 500,
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        output: "",
        previousVersion: null,
        newVersion: null,
        target: "global",
      },
      { status: 500 },
    );
  }
}
