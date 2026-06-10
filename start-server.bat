@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo =========================================
echo 互動記憶遊戲 - Node.js / Gemini AI-only 版本
echo =========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [錯誤] 找不到 Node.js。請先安裝 Node.js 18 或以上版本。
  echo 下載：https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo 第一次啟動，正在安裝套件...
  npm install
  if %errorlevel% neq 0 (
    echo [錯誤] npm install 失敗。
    pause
    exit /b 1
  )
)

echo [提醒] 這一版沒有預設題目 fallback。
echo 請確認 server.js 裡的 HARDCODED_GEMINI_API_KEY 已經填入你的 Gemini API key。
echo.
echo 遊戲網址：http://localhost:3000
echo 按 Ctrl+C 可以停止伺服器。
echo.
npm start
pause
