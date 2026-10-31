@echo off
chcp 65001 >nul
title 关闭局域网访问（删除 ToDoList 放行规则）

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo 需要管理员权限，正在弹出 UAC 授权窗口...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo ============================================
echo  正在删除局域网放行规则（5173 / 4000）
echo ============================================
echo.

netsh advfirewall firewall delete rule name="ToDoList Dev 5173"
netsh advfirewall firewall delete rule name="ToDoList Dev 4000"

echo.
echo 如果上面打印了 Ok.，说明规则已删除，手机应该打不开了。
echo 本机浏览器（localhost:5173）不受影响。
echo.
pause
