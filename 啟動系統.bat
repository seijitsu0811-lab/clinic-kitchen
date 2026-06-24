@echo off
chcp 65001 > nul
title 診所廚房管理系統

:: 確認 node 存在
where node >nul 2>&1
if errorlevel 1 (
    echo [錯誤] 找不到 Node.js，請先安裝。
    pause
    exit
)

:: 切換到系統目錄
cd /d "%~dp0"

echo.
echo  診所廚房管理系統 啟動中...
echo  請在瀏覽器開啟：http://localhost:3000
echo.
echo  [關閉此視窗 = 系統停止]
echo.

node server.js
pause
