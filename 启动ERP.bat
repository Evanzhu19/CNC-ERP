@echo off
chcp 65001 >nul
cd /d %~dp0
title CNC ERP 服务器（关掉这个窗口系统就停了）
echo ==========================================
echo   CNC ERP 正在启动...
echo   本机访问：http://localhost:3000
echo   局域网访问：http://本机IP:3000
echo   （查本机IP：在命令行输入 ipconfig）
echo ==========================================
node server\index.js
pause
