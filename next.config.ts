import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // better-sqlite3는 N-API 네이티브 바인딩(.node)을 포함하는 모듈이라 Turbopack/
  // webpack 번들링 대상에서 제외해야 한다. Next.js의 auto-external 목록에 포함
  // 되어 있지만, dev 모드의 static-paths-worker가 route 모듈을 fork된 자식 프로
  // 세스에 로드할 때 일관되게 인식되지 않아 worker가 "2 child process exceptions
  // exceeding retry limit"으로 죽는 회귀가 관측됐다. 명시 선언으로 강제.
  // (관련 로그: .next/dev/logs/next-development.log, /game/[appId] 접근 시 발화)
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
