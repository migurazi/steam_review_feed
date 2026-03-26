import Link from 'next/link';

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 px-4 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-[#66c0f4] font-bold text-base">
            Steam Review Feed
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto w-full px-4 py-10">
        <h1 className="text-3xl font-bold text-white mb-2">개인정보 처리방침</h1>
        <p className="text-gray-500 text-sm mb-8">최종 업데이트: 2026년 3월 26일</p>

        <div className="space-y-8 text-gray-300 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-white mb-3">1. 수집하는 정보</h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-700">
                  <th className="text-left py-2 pr-4 text-gray-400 font-medium">항목</th>
                  <th className="text-left py-2 text-gray-400 font-medium">수집 여부</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800">
                <tr>
                  <td className="py-2 pr-4">Steam64 ID</td>
                  <td className="py-2 text-green-400">수집함</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">필터 설정 (언어, 기간 등)</td>
                  <td className="py-2 text-green-400">수집함 (세션 쿠키)</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">Steam 비밀번호</td>
                  <td className="py-2 text-gray-500">수집하지 않음</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">Steam 액세스 토큰</td>
                  <td className="py-2 text-gray-500">수집하지 않음</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">이메일, 연락처</td>
                  <td className="py-2 text-gray-500">수집하지 않음</td>
                </tr>
                <tr>
                  <td className="py-2 pr-4">결제 정보</td>
                  <td className="py-2 text-gray-500">수집하지 않음</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">2. 정보 수집 목적</h2>
            <ul className="list-disc list-inside space-y-1 text-sm">
              <li>Steam API를 통한 위시리스트/라이브러리 게임 목록 조회</li>
              <li>개인화된 리뷰 피드 제공</li>
              <li>세션 유지 (서버 재시작 후에도 로그인 상태 유지)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">3. 정보 보관 기간</h2>
            <p className="text-sm">
              마지막 로그인으로부터 <strong className="text-white">6개월</strong>이 경과하면 사용자
              데이터(Steam64 ID, 설정)가 자동으로 삭제됩니다. 서비스를 더 이상 사용하지 않는다면
              추가적인 조치 없이 데이터가 자동 삭제됩니다.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">4. 인증 방식</h2>
            <p className="text-sm">
              본 서비스는 Steam OpenID 2.0을 사용합니다. 로그인 과정에서 Steam 공식 페이지로
              이동하며, 비밀번호는 Steam에만 전달되고 본 서비스는 절대 열람할 수 없습니다.
              인증 완료 후 Steam64 ID만 수신합니다.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">5. 제3자 공유</h2>
            <p className="text-sm">
              수집된 정보는 제3자에게 판매하거나 공유하지 않습니다. Steam API 호출을 위해
              Steam64 ID가 Steam(Valve Corporation)의 서버로 전달될 수 있습니다.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">6. 사용자 권리</h2>
            <p className="text-sm">
              언제든지 로그아웃하면 세션이 즉시 종료됩니다. 데이터 삭제를 원하시면 서비스를
              사용하지 않는 상태로 6개월 경과 시 자동 삭제됩니다.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-white mb-3">7. 면책</h2>
            <p className="text-sm">
              본 서비스는 Valve Corporation 또는 Steam과 무관한 비공식 서비스입니다.
              Steam은 Valve Corporation의 상표입니다.
            </p>
          </section>
        </div>
      </main>

      <footer className="border-t border-gray-800 px-4 py-4 text-center text-gray-600 text-xs">
        <Link href="/" className="hover:text-gray-400 transition-colors">
          홈으로 돌아가기
        </Link>
      </footer>
    </div>
  );
}
