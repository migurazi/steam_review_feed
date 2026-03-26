import { NextRequest, NextResponse } from "next/server";
import { getAppDetails } from "@/lib/steam/api";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId: raw } = await params;
  const appId = Number(raw);

  if (!Number.isInteger(appId) || appId <= 0) {
    return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
  }

  const result = await getAppDetails(appId);
  if (!result) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const { data } = result;

  return NextResponse.json({
    movies: data.movies ?? [],
    screenshots: data.screenshots ?? [],
    short_description: data.short_description,
    header_image: data.header_image,
  });
}
