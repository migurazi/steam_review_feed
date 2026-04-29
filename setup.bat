@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo  Steam Review Feed - Setup
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node
where npm >nul 2>nul
if errorlevel 1 goto :no_node
goto :node_ok

:no_node
echo [!] Node.js / npm 이 설치되어 있지 않습니다.
echo.
where winget >nul 2>nul
if errorlevel 1 (
    echo     winget을 사용할 수 없습니다.
    echo     https://nodejs.org/ko/download 에서 Node.js 20 이상 LTS를 직접 설치한 뒤 다시 실행하세요.
    pause
    exit /b 1
)
echo     winget으로 Node.js LTS를 자동 설치할 수 있습니다.
set /p INSTALL_NODE="    지금 설치하시겠습니까? (Y/N): "
if /i not "%INSTALL_NODE%"=="Y" (
    echo     설치를 취소했습니다. https://nodejs.org/ko/download 에서 직접 설치하세요.
    pause
    exit /b 1
)
echo.
echo     [winget] OpenJS.NodeJS.LTS 설치 중...
winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
    echo.
    echo [ERROR] Node.js 설치 실패. 수동으로 설치한 뒤 다시 실행하세요.
    pause
    exit /b 1
)
echo.
echo     설치 완료. 이 창을 닫고 새 cmd 창을 연 뒤 setup.bat을 다시 실행하세요.
echo     ^(현재 창에서는 PATH가 반영되지 않습니다^)
pause
exit /b 0

:node_ok
echo [1/2] 의존성 설치 (npm install)
call npm install
if errorlevel 1 (
    echo.
    echo [ERROR] npm install 실패
    pause
    exit /b 1
)

echo.
echo [2/2] .env.local 확인
if exist .env.local (
    echo       .env.local 이미 존재합니다. 건너뜁니다.
) else (
    echo       .env.local 생성 중 (SESSION_SECRET 자동 생성)
    powershell -NoProfile -Command "$secret = [Convert]::ToBase64String([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)); Set-Content -Path .env.local -Value @('STEAM_API_KEY=여기에_Steam_API_키_입력', ('SESSION_SECRET=' + $secret), 'NEXT_PUBLIC_BASE_URL=http://localhost:3000') -Encoding UTF8"
    if errorlevel 1 (
        echo.
        echo [ERROR] .env.local 생성 실패
        pause
        exit /b 1
    )
    echo       .env.local 생성 완료
    echo.
    echo       *** STEAM_API_KEY를 직접 입력해야 합니다 ***
    echo       발급: https://steamcommunity.com/dev/apikey
)

echo.
echo ============================================
echo  Setup 완료!
echo  - 개발 서버 실행:    dev.bat
echo  - 프로덕션 빌드:     build.bat
echo  - 프로덕션 실행:     start.bat
echo ============================================
pause
