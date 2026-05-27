/**
 * Steam 타입 정의 검증 테스트.
 *
 * SteamAppDetails의 movies/screenshots 확장이
 * 실제 API 응답 구조와 일치하는지 TypeScript 레벨에서 검증한다.
 * 런타임 동작이 아닌 타입 호환성을 테스트하므로,
 * 컴파일만 통과하면 성공이다.
 */

import { describe, it, expect } from "vitest";
import type {
  SteamAppDetails,
  SteamMovie,
  SteamScreenshot,
  SteamGenre,
  SteamCategory,
} from "@/lib/steam/types";

describe("Steam 타입 정의", () => {
  it("SteamMovie 타입이 실제 API 응답 구조와 일치한다", () => {
    // 실제 Steam API 응답에서 가져온 구조 (2026-03-26 검증)
    const movie: SteamMovie = {
      id: 256692021,
      name: "Dota 2 - Join the Battle",
      thumbnail: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/256692021/movie.293x165.jpg",
      hls_h264: "https://video.akamai.steamstatic.com/.../hls_264_master.m3u8",
      highlight: true,
    };

    // 모든 필드가 올바른 타입으로 할당 가능해야 한다
    expect(movie.id).toBeTypeOf("number");
    expect(movie.name).toBeTypeOf("string");
    expect(movie.thumbnail).toBeTypeOf("string");
    expect(movie.hls_h264).toBeTypeOf("string");
    expect(movie.highlight).toBeTypeOf("boolean");
  });

  it("SteamScreenshot 타입이 실제 API 응답 구조와 일치한다", () => {
    const screenshot: SteamScreenshot = {
      id: 0,
      path_thumbnail: "https://shared.akamai.steamstatic.com/.../ss_600x338.jpg",
      path_full: "https://shared.akamai.steamstatic.com/.../ss_1920x1080.jpg",
    };

    expect(screenshot.id).toBeTypeOf("number");
    expect(screenshot.path_thumbnail).toBeTypeOf("string");
    expect(screenshot.path_full).toBeTypeOf("string");
  });

  it("SteamAppDetails의 movies와 screenshots는 optional이다", () => {
    // 기존 코드 호환성: movies/screenshots 없이도 유효해야 한다
    const detailsWithout: SteamAppDetails = {
      name: "Test Game",
      steam_appid: 12345,
      is_free: false,
      header_image: "https://example.com/header.jpg",
      short_description: "A test game",
      type: "game",
    };

    expect(detailsWithout.movies).toBeUndefined();
    expect(detailsWithout.screenshots).toBeUndefined();
  });

  it("SteamAppDetails에 movies와 screenshots를 포함할 수 있다", () => {
    const detailsWith: SteamAppDetails = {
      name: "Dota 2",
      steam_appid: 570,
      is_free: true,
      header_image: "https://example.com/header.jpg",
      short_description: "A MOBA game",
      type: "game",
      movies: [
        {
          id: 1,
          name: "Trailer",
          thumbnail: "https://example.com/thumb.jpg",
          hls_h264: "https://example.com/video.m3u8",
          highlight: true,
        },
      ],
      screenshots: [
        {
          id: 0,
          path_thumbnail: "https://example.com/ss_thumb.jpg",
          path_full: "https://example.com/ss_full.jpg",
        },
      ],
    };

    expect(detailsWith.movies).toHaveLength(1);
    expect(detailsWith.screenshots).toHaveLength(1);
  });

  it("SteamGenre 타입이 id(string)+description 구조를 갖는다", () => {
    // Steam API 응답: genres: [{ id: "1", description: "Action" }]
    const genre: SteamGenre = { id: "1", description: "액션" };
    expect(genre.id).toBeTypeOf("string");
    expect(genre.description).toBeTypeOf("string");
  });

  it("SteamCategory 타입이 id(number)+description 구조를 갖는다", () => {
    // Steam API 응답: categories: [{ id: 2, description: "Single-player" }]
    // 장르와 달리 카테고리 id는 정수
    const category: SteamCategory = { id: 2, description: "싱글 플레이어" };
    expect(category.id).toBeTypeOf("number");
    expect(category.description).toBeTypeOf("string");
  });

  it("SteamAppDetails의 genres와 categories는 optional이다", () => {
    // 일부 게임(데모, 도구, 미출시)은 genres/categories가 누락될 수 있음
    const detailsWithout: SteamAppDetails = {
      name: "Test Game",
      steam_appid: 12345,
      is_free: false,
      header_image: "https://example.com/header.jpg",
      short_description: "A test game",
      type: "game",
    };

    expect(detailsWithout.genres).toBeUndefined();
    expect(detailsWithout.categories).toBeUndefined();
  });

  it("SteamAppDetails에 genres와 categories를 포함할 수 있다", () => {
    const detailsWith: SteamAppDetails = {
      name: "Test Game",
      steam_appid: 12345,
      is_free: false,
      header_image: "https://example.com/header.jpg",
      short_description: "A test game",
      type: "game",
      genres: [
        { id: "1", description: "액션" },
        { id: "25", description: "어드벤처" },
      ],
      categories: [
        { id: 2, description: "싱글 플레이어" },
        { id: 22, description: "Steam 도전 과제" },
      ],
    };

    expect(detailsWith.genres).toHaveLength(2);
    expect(detailsWith.categories).toHaveLength(2);
    expect(detailsWith.genres?.[0].id).toBe("1");
    expect(detailsWith.categories?.[0].id).toBe(2);
  });

  it("genres와 categories에 빈 배열도 허용된다", () => {
    // 게임이지만 메타가 비어있는 경우 (드물지만 발생 가능)
    const details: SteamAppDetails = {
      name: "Edge Case Game",
      steam_appid: 99999,
      is_free: false,
      header_image: "",
      short_description: "",
      type: "game",
      genres: [],
      categories: [],
    };

    expect(details.genres).toHaveLength(0);
    expect(details.categories).toHaveLength(0);
  });
});
