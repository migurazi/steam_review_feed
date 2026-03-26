/**
 * 수동 캐시 무효화 API.
 * POST /api/cache/invalidate?key=wishlist:76561198056932899
 *
 * "새로고침" 버튼에서 호출. 지정된 캐시 키를 삭제한다.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { cacheDelete, cacheDeleteByPrefix } from "@/lib/cache";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.steamId) {
    return NextResponse.json({ error: "인증이 필요합니다." }, { status: 401 });
  }

  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return NextResponse.json(
      { error: "무효화할 캐시 키를 지정해주세요." },
      { status: 400 }
    );
  }

  // 보안: 허용된 키 패턴만 무효화 가능 (자신의 steamId가 포함된 키)
  const allowedPrefixes = [
    `wishlist:${session.steamId}`,
    `library:${session.steamId}`,
  ];
  const isAllowed = allowedPrefixes.some((prefix) => key.startsWith(prefix));

  if (isAllowed) {
    if (key.includes("*")) {
      cacheDeleteByPrefix(key.replace("*", ""));
    } else {
      cacheDelete(key);
    }
    return NextResponse.json({ success: true, key });
  }

  return NextResponse.json(
    { error: "본인의 캐시만 무효화할 수 있습니다." },
    { status: 403 }
  );
}
