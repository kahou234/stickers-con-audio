@echo off
rem Stickers con audio: deja que el boton de la extension prenda el ayudante solo. Una vez por compu.
cd /d "%~dp0"
where py >nul 2>nul && (py stickers.py instalar) || (python stickers.py instalar)
echo.
pause
