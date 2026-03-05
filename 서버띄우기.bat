@echo off
chcp 65001 >nul
echo.
echo  JP 타임즈 - 로컬 서버
echo ========================================
echo  PC에서 보기:  http://localhost:3000
echo ========================================
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=1" %%b in ("%%a") do (
    echo  모바일 링크 (같은 Wi-Fi 휴대폰):  http://%%b:3000
    echo.
    goto :done
  )
)
:done
echo  위 모바일 링크를 휴대폰 브라우저에 그대로 입력하세요.
echo ========================================
echo.
if where npx >nul 2>nul (
  npx --yes serve -l 3000
) else (
  echo npx가 없습니다. Node.js 설치 후 다시 실행하거나,
  echo Python이 있다면: python -m http.server 3000
  pause
)
