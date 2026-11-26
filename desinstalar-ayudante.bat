@echo off
rem Stickers con audio: quita lo que puso instalar-ayudante.bat.
cd /d "%~dp0"
where py >nul 2>nul && (py stickers.py desinstalar) || (python stickers.py desinstalar)
echo.
pause
