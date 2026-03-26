/**
 * /api/game/[appId]/media 라우트 단위 테스트.
 *
 * getAppDetails를 mock하여 다음을 검증한다:
 * - 정상 응답: movies, screenshots, short_description, header_image 반환
 * - 동영상이 없는 게임: movies 빈 배열 반환
 * - 존재하지 않는 appId: 404 반환
 * - 잘못된 appId 형식: 400 반환
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "@/app/api/game/[appId]/media/route";
import { NextRequest } from "next/server";
import type { SteamAppDetails } from "@/lib/steam/types";

// getAppDetails를 mock한다
vi.mock("@/lib/steam/api", () => ({
  getAppDetails: vi.fn(),
}));

import { getAppDetails } from "@/lib/steam/api";
const mockGetAppDetails = vi.mocked(getAppDetails);

/** 테스트용 요청 객체를 생성한다 */
function createRequest(): NextRequest {
  return new NextRequest("http://localhost:3000/api/game/570/media");
}

/** 테스트용 앱 상세 데이터 (동영상 + 스크린샷 포함) */
const fullAppDetails: SteamAppDetails = {
  name: "Dota 2",
  steam_appid: 570,
  is_free: true,
  header_image: "https://cdn.akamai.steamstatic.com/steam/apps/570/header.jpg",
  short_description: "Every day, millions of players...",
  type: "game",
  movies: [
    {
      id: 256692021,
      name: "Dota 2 Trailer",
      thumbnail: "https://cdn.akamai.steamstatic.com/steam/apps/256692021/movie.jpg",
      hls_h264: "https://video.akamai.steamstatic.com/.../hls_264_master.m3u8",
      highlight: true,
    },
  ],
  screenshots: [
    {
      id: 0,
      path_thumbnail: "https://cdn.akamai.steamstatic.com/.../ss_thumb.jpg",
      path_full: "https://cdn.akamai.steamstatic.com/.../ss_full.jpg",
    },
  ],
};

/** 테스트용 앱 상세 데이터 (동영상 없음, 스크린샷만) */
const noMovieAppDetails: SteamAppDetails = {
  ...fullAppDetails,
  name: "Indie Game",
  steam_appid: 99999,
  movies: undefined,
  screenshots: [
    {
      id: 0,
      path_thumbnail: "https://cdn.akamai.steamstatic.com/.../ss_thumb.jpg",
      path_full: "https://cdn.akamai.steamstatic.com/.../ss_full.jpg",
    },
  ],
};

describe("/api/game/[appId]/media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("정상 요청: movies, screenshots, short_description, header_image를 반환한다", async () => {
    mockGetAppDetails.mockResolvedValue({
      data: fullAppDetails,
      isStale: false,
    });

    const res = await GET(createRequest(), {
      params: Promise.resolve({ appId: "570" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.movies).toHaveLength(1);
    expect(json.movies[0].hls_h264).toContain("m3u8");
    expect(json.screenshots).toHaveLength(1);
    expect(json.short_description).toBe("Every day, millions of players...");
    expect(json.header_image).toContain("header.jpg");
  });

  it("동영상이 없는 게임: movies를 빈 배열로 반환한다", async () => {
    mockGetAppDetails.mockResolvedValue({
      data: noMovieAppDetails,
      isStale: false,
    });

    const res = await GET(createRequest(), {
      params: Promise.resolve({ appId: "99999" }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    // movies가 undefined인 경우 빈 배열로 정규화된다
    expect(json.movies).toEqual([]);
    expect(json.screenshots).toHaveLength(1);
  });

  it("존재하지 않는 appId: 404를 반환한다", async () => {
    // getAppDetails가 null을 반환하면 삭제/이관된 앱
    mockGetAppDetails.mockResolvedValue(null);

    const res = await GET(createRequest(), {
      params: Promise.resolve({ appId: "999999999" }),
    });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe("App not found");
  });

  it("숫자가 아닌 appId: 400을 반환한다", async () => {
    const res = await GET(createRequest(), {
      params: Promise.resolve({ appId: "abc" }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Invalid appId");
  });

  it("음수 appId: 400을 반환한다", async () => {
    const res = await GET(createRequest(), {
      params: Promise.resolve({ appId: "-1" }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Invalid appId");
  });

  it("소수점 appId: 400을 반환한다 (정수만 허용)", async () => {
    const res = await GET(createRequest(), {
      params: Promise.resolve({ appId: "1.5" }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("Invalid appId");
  });
});
