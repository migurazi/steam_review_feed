@echo off
chcp 65001 >nul

if not exist node_modules (
    echo [ERROR] node_modules가 없습니다. setup.bat을 먼저 실행하세요.
    pause
    exit /b 1
)
if not exist .env.local (
    echo [ERROR] .env.local이 없습니다. setup.bat을 먼저 실행하세요.
    pause
    exit /b 1
)

echo ============================================
echo  Dev Server 시작 (http://localhost:3000)
echo  종료: Ctrl+C
echo ============================================
echo.
call npm run dev
pause
