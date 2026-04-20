@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion

echo ╔══════════════════════════════════════════╗
echo ║  WindsurfAPI v2.0 Installer (Windows)    ║
echo ╚══════════════════════════════════════════╝
echo.

:: ── Check Node.js ─────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js not found. Please install Node.js ^>= 20:
    echo    https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -e "console.log(process.versions.node.split(''.'')[0])"') do set NODE_VER=%%v
if %NODE_VER% lss 20 (
    echo ❌ Node.js ^>= 20 required.
    pause
    exit /b 1
)
echo ✅ Node.js detected

:: ── Install directory ─────────────────────────
set "INSTALL_DIR=%USERPROFILE%\.windsurfapi"
echo 📁 Installing to %INSTALL_DIR% ...

if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"

:: Copy source files
set "SCRIPT_DIR=%~dp0"
xcopy /E /Y /Q "%SCRIPT_DIR%..\src" "%INSTALL_DIR%\src\" >nul
copy /Y "%SCRIPT_DIR%..\package.json" "%INSTALL_DIR%\" >nul
copy /Y "%SCRIPT_DIR%..\README.md" "%INSTALL_DIR%\" >nul 2>&1
copy /Y "%SCRIPT_DIR%..\CHANGELOG.md" "%INSTALL_DIR%\" >nul 2>&1

:: Create .env if not exists
if not exist "%INSTALL_DIR%\.env" (
    echo # WindsurfAPI configuration> "%INSTALL_DIR%\.env"
    echo PORT=3003>> "%INSTALL_DIR%\.env"
    echo API_KEY=sk-windsurf-change-me>> "%INSTALL_DIR%\.env"
    echo DASHBOARD_PASSWORD=change-me>> "%INSTALL_DIR%\.env"
    echo DEFAULT_MODEL=claude-sonnet-4.6>> "%INSTALL_DIR%\.env"
    echo LS_BINARY_PATH=C:\windsurf\language_server_windows_x64.exe>> "%INSTALL_DIR%\.env"
    echo LS_PORT=42100>> "%INSTALL_DIR%\.env"
    echo.
    echo ✅ Created .env — please edit API_KEY and DASHBOARD_PASSWORD!
) else (
    echo ✅ Existing .env preserved
)

:: Create start script
echo @echo off> "%INSTALL_DIR%\start.bat"
echo cd /d "%INSTALL_DIR%">> "%INSTALL_DIR%\start.bat"
echo node src/index.js>> "%INSTALL_DIR%\start.bat"
echo pause>> "%INSTALL_DIR%\start.bat"

:: Create Windows Service install script (optional, uses nssm)
echo @echo off> "%INSTALL_DIR%\install-service.bat"
echo echo Installing WindsurfAPI as Windows Service...>> "%INSTALL_DIR%\install-service.bat"
echo echo Requires NSSM ^(https://nssm.cc/^). Download and put nssm.exe in PATH.>> "%INSTALL_DIR%\install-service.bat"
echo nssm install WindsurfAPI node "%INSTALL_DIR%\src\index.js">> "%INSTALL_DIR%\install-service.bat"
echo nssm set WindsurfAPI AppDirectory "%INSTALL_DIR%">> "%INSTALL_DIR%\install-service.bat"
echo nssm set WindsurfAPI Start SERVICE_AUTO_START>> "%INSTALL_DIR%\install-service.bat"
echo nssm start WindsurfAPI>> "%INSTALL_DIR%\install-service.bat"
echo echo Done!>> "%INSTALL_DIR%\install-service.bat"
echo pause>> "%INSTALL_DIR%\install-service.bat"

echo.
echo ════════════════════════════════════════════
echo ✅ WindsurfAPI v2.0 installed!
echo.
echo    Start:     %INSTALL_DIR%\start.bat
echo    Dashboard: http://localhost:3003/dashboard
echo    API:       http://localhost:3003/v1/chat/completions
echo.
echo    ⚠️  Edit %INSTALL_DIR%\.env before first run!
echo    Optional: Run install-service.bat for auto-start
echo ════════════════════════════════════════════
pause
