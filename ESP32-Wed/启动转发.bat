@echo off
chcp 936 >nul
cd /d "%~dp0"
title ESP32 转发器

set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
    where py >nul 2>nul
    if errorlevel 1 (
        echo.
        echo   没找到 Python，请先安装：https://www.python.org/downloads/
        echo   安装时记得勾选 "Add Python to PATH"
        echo.
        pause
        exit /b 1
    )
    set "PY=py -3"
)

echo.
echo   正在启动转发器，浏览器会自动打开...
echo   关闭这个黑窗口就等于停止转发。
echo.

%PY% forward.py --port 8765 --open

echo.
echo   转发器已退出，按任意键关闭窗口。
pause >nul
