@echo off
title regotty distributor
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [HATA] Node.js bulunamadi - once kur: https://nodejs.org
  pause
  exit /b 1
)

rem ilk calistirmada config yoksa ornekten olustur
if not exist "config\config.json" if exist "config\config.example.json" (
  copy "config\config.example.json" "config\config.json" >nul
  echo [bilgi] config\config.json olusturuldu - icini doldurmayi unutma.
)
rem girdi/sanatci CSV'leri yoksa ornekten olustur
if not exist "input\input.csv" if exist "input\input.csv.example" (
  copy "input\input.csv.example" "input\input.csv" >nul
  echo [bilgi] input\input.csv olusturuldu - sarkilari gir.
)
if not exist "artists\artists.csv" if exist "artists\artists.csv.example" (
  copy "artists\artists.csv.example" "artists\artists.csv" >nul
  echo [bilgi] artists\artists.csv olusturuldu - profilleri gir.
)

rem bagimliliklar yoksa kur
if not exist "node_modules" (
  echo [kurulum] bagimliliklar yukleniyor - ilk calistirma biraz surer...
  call npm install
  if errorlevel 1 (
    echo [HATA] npm install basarisiz oldu.
    pause
    exit /b 1
  )
)

echo.
echo   regotty distributor paneli baslatiliyor...
echo   Panel: http://localhost:4599
echo   Kapatmak icin: bu pencereyi kapat ya da Ctrl+C
echo.

rem panel ayaga kalkinca (~2sn) tarayiciyi ac
start "" /min cmd /c "timeout /t 2 >nul && start http://localhost:4599"

node src/panel.mjs

echo.
echo Panel kapandi.
pause
