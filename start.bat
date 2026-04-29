@echo off
chcp 65001 >nul

if not exist .env.local (
    echo [ERROR] .env.local이 없습니다. setup.bat을 먼저 실행하세요.
    pause
    exit /b 1
)
if not exist .next\standalone\server.js (
    echo [ERROR] standalone 빌드가 없습니다. build.bat을 먼저 실행하세요.
    pause
    exit /b 1
)

echo ============================================
echo  Production Server 시작 (http://localhost:3000)
echo  종료: Ctrl+C
echo ============================================
echo.
call npm run start:standalone
pause
