import { NextResponse } from "next/server";

export async function GET(request) {
  const upstream = await fetch(`${process.env.GOODBASE_URL || "https://base.goodos.app"}/api/auth/me`, {
    headers: { cookie: request.headers.get("cookie") || "" },
    cache: "no-store",
  });
  return NextResponse.json(await upstream.json(), { status: upstream.status });
}

