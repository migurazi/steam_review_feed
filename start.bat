@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js가 없습니다. setup.bat을 먼저 실행하세요.
    pause
    exit /b 1
)

REM .env.local 보장 (없으면 생성 + SESSION_SECRET 자동, 구 placeholder 정규화).
call node scripts\setup-env.mjs

if not exist .next\standalone\server.js (
    echo [ERROR] standalone 빌드가 없습니다. build.bat을 먼저 실행하세요.
    pause
    exit /b 1
)

echo ============================================
echo  Steam Review Feed 시작 (http://localhost:3000)
echo  최초 실행이면 브라우저 안내에 따라 Steam API 키를 등록하세요.
echo  종료: Ctrl+C
echo ============================================
echo.
REM 서버가 뜰 시간을 준 뒤 브라우저를 자동으로 연다(별도 프로세스).
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"
call npm run start:standalone
pause
