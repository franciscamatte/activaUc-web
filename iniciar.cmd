@echo off
rem =====================================================================
rem  ActivaUC . arranque del servidor de desarrollo en Windows
rem ---------------------------------------------------------------------
rem  En este equipo Node.js vive dentro de WSL, no en Windows. Este
rem  archivo es el atajo: doble clic, o .\iniciar.cmd desde PowerShell.
rem
rem  Deja la pagina en http://localhost:5173 y se queda corriendo.
rem  Para detenerlo: Ctrl+C, o cerrar la ventana.
rem
rem  No se le pasa la ruta a WSL a proposito: al cambiar aqui el
rem  directorio, WSL arranca en el equivalente /mnt/c/... por si mismo.
rem  Pasarla como argumento obliga a escapar las barras invertidas, que
rem  bash interpreta, y la ruta llega partida.
rem =====================================================================
setlocal
rem Codigo de pagina UTF-8: sin esto los acentos de la salida
rem del servidor se ven como caracteres raros en la consola.
chcp 65001 >nul
cd /d "%~dp0"

echo Iniciando ActivaUC en http://localhost:5173
echo Para detenerlo: Ctrl+C
echo.

rem Distribucion de este equipo. Si no existe, se usa la de por omision.
wsl -d Ubuntu-24.04 -- bash scripts/dev-wsl.sh
if errorlevel 1 (
  echo.
  echo Reintentando con la distribucion de WSL por omision...
  wsl -- bash scripts/dev-wsl.sh
)

if errorlevel 1 (
  echo.
  echo No se pudo iniciar. Revisa docs\ARRANQUE_LOCAL.md seccion 6.
  pause
)
