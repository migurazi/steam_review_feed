@echo off
chcp 65001 >nul

if not exist node_modules (
    echo [ERROR] node_modules가 없습니다. setup.bat을 먼저 실행하세요.
    pause
    exit /b 1
)

echo ============================================
echo  Production Build 시작
echo ============================================
echo.
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] 빌드 실패
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Build 완료! start.bat으로 실행하세요.
echo ============================================
pause
