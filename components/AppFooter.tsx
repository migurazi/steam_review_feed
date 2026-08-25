import AboutDialog from '@/components/AboutDialog';

/**
 * 전 페이지 공용 푸터. 서비스명 + 버전 배지(AboutDialog) + 면책 문구 + 개인정보 링크.
 *
 * 홈/피드/추천/도전과제 페이지에서 동일하게 사용한다. 버전 배지를 누르면
 * 서비스 소개 모달(AboutDialog)이 열리므로, 모든 진입 페이지에서 소개에
 * 접근할 수 있도록 여기에 한 번만 정의하고 재사용한다.
 */
export default function AppFooter() {
  return (
    <footer className="border-t border-gray-200 dark:border-gray-800 px-4 py-4 text-center text-gray-500 dark:text-gray-600 text-xs">
      Steam Review Feed <AboutDialog /> — Steam과 무관한 비공식 서비스입니다.{' '}
      <a
        href="/privacy"
        className="hover:text-gray-700 dark:hover:text-gray-400 transition-colors underline"
      >
        개인정보 처리방침
      </a>
    </footer>
  );
}
