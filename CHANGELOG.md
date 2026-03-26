# Changelog

이 프로젝트의 모든 주요 변경 사항을 기록합니다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## [Unreleased]

## [0.1.0] - 2026-03-26

### Added

- Steam OpenID 로그인 및 Steam ID 직접 입력 지원
- 위시리스트/라이브러리 게임 통합 리뷰 피드
- SSE 기반 점진적 리뷰 로딩
- 리뷰 필터링 (언어, 기간, 플레이타임, 글자수, 추천/비추천, 무료 게임 제외)
- 게임 검색 기능 (비로그인)
- 게임별 리뷰 상세 페이지
- 개인정보 처리방침 페이지
- SQLite 기반 사용자/게임 목록 영속화
- Docker 배포 구성 (Nginx 설정 포함)
- Rate limiting (IP 기반, 분당 30회)
- 이벤트 로깅 시스템
