/**
 * Server-Sent Events 공통 유틸리티.
 *
 * 두 SSE 라우트(`app/api/reviews/stream/route.ts`, `app/api/recommend/route.ts`)
 * 가 동일한 헤더 set, 동일한 sseEvent 인코더를 hand-roll로 가지고 있어 드리프트
 * 위험이 컸다. 한 곳에 모아 모든 SSE 라우트가 같은 동작(특히 X-Accel-Buffering
 * 해제로 nginx/Vercel/Docker 환경의 응답 버퍼링 회피)을 공유하도록 한다.
 */

const encoder = new TextEncoder();

/**
 * 이벤트 이름과 JSON 직렬화 가능한 데이터로부터 SSE 프레임 바이트열을 만든다.
 *
 * 형식 (RFC: text/event-stream):
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * 클라이언트는 `es.addEventListener(name, ...)`로 구독한다. data가 1줄 JSON
 * 이라 별도의 data 분리 처리가 필요 없다.
 */
export function sseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * ReadableStream을 받아 SSE 응답을 생성한다.
 *
 * 공통 헤더:
 *   - Content-Type: text/event-stream — 브라우저 EventSource 인식
 *   - Cache-Control: no-cache, no-transform — 프록시/브라우저 캐싱 차단
 *   - Connection: keep-alive — HTTP/1.1 연결 유지
 *   - X-Accel-Buffering: no — nginx/Vercel/일부 Docker 환경이 응답을 버퍼링하여
 *     SSE 이벤트가 한꺼번에 전달되는 회귀를 방지. 표준 헤더는 아니지만 광범위
 *     하게 지원되며 미인식 환경에선 무해.
 */
export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
