export default function SteamLoginButton() {
  return (
    <a
      href="/api/auth/steam"
      className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-[#1b6fa8] dark:bg-[#1b2838] border border-[#1b6fa8] dark:border-[#4c6b8a] text-white font-semibold text-base hover:bg-[#155a8a] dark:hover:bg-[#2a475e] hover:border-[#155a8a] dark:hover:border-[#66c0f4] transition-all duration-200 shadow-lg"
    >
      Steam으로 로그인
    </a>
  );
}
