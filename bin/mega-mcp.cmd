@echo off
rem Starts the MEGA MCP server (dist\plugin-server.js) with Node.js 18 or later on Windows.
rem Codex runs .mcp.json's "./bin/mega-mcp" from the plugin folder and, on Windows, picks
rem this file beside it. Like bin/mega-mcp, it runs the first of these that is Node 18+:
rem   1. MEGA_MCP_NODE, if you set it (for example in %%USERPROFILE%%\.codex\.env)
rem   2. the first node.exe on PATH, as before this launcher existed
rem   3. the Node that ships with the ChatGPT / Codex app
rem   4. the Node.js installer's folders, Scoop
rem   5. versions installed by nvm-windows, Volta, fnm or mise
rem Only .exe files are run (a .cmd run from here would never return), one after the other
rem until one is Node 18+. A version manager's shim found on PATH (in a "shims" folder, or
rem Volta's) is passed over, as it picks a Node from config files around it. A candidate
rem built from a variable is set only when the variable is, so an unset one can't become a
rem path at the root of the drive, where any local user can create folders. Every folder
rem searched is passed to the server in MEGA_MCP_NODE_ROOTS, so its transfers refuse to
rem write there (a node.exe, or a DLL next to one, placed there would run at the next
rem start). The server gets the environment Codex gave this file, without the variables
rem env_vars passes only for finding Node, nor this file's own. No labels or GOTO, so
rem either line ending works.
setlocal EnableExtensions DisableDelayedExpansion
set "MEGA_MCP_SERVER=%~dp0..\dist\plugin-server.js"
set "MEGA_MCP_CHECK=process.exit(+process.versions.node.split('.')[0]>=18?0:1)"
set "MEGA_MCP_NAMES=OK PATH SHIM RES CLI CACHE RT PF PF64 PF86 LPROG SCOOP SCOOPLTS USCOOP USCOOPLTS NVM FNM AFNM FOUND R1 R2 R3 R4"
rem What .mcp.json's env_vars passes only for finding Node; keep in step with it (CODEX_HOME
rem is for the server).
set "MEGA_MCP_VARS=MEGA_MCP_NODE CODEX_MCP_NODE_PATH CODEX_BROWSER_USE_NODE_PATH CODEX_ELECTRON_RESOURCES_PATH CODEX_CLI_PATH XDG_CACHE_HOME XDG_DATA_HOME N_PREFIX VOLTA_HOME ASDF_DATA_DIR MISE_DATA_DIR NODENV_ROOT FNM_DIR NVM_DIR NVM_HOME NVM_SYMLINK SCOOP"
for %%V in (%MEGA_MCP_NAMES%) do set "MEGA_MCP_N_%%V="
set "MEGA_MCP_NODE_ROOTS="

rem MEGA_MCP_NODE comes first; say so when it can't be used.
if defined MEGA_MCP_NODE for %%N in ("%MEGA_MCP_NODE%") do if /i "%%~xN"==".exe" if exist "%%~N" "%%~N" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_OK=1"
if defined MEGA_MCP_NODE if not defined MEGA_MCP_N_OK >&2 echo mega-mcp: MEGA_MCP_NODE is not Node.js 18 or later; looking elsewhere.

rem node.exe on PATH, unless it is a shim: in a folder named "shims" (Scoop, mise), in a
rem folder named Volta or its bin, or in VOLTA_HOME's bin.
for %%I in (node.exe) do set "MEGA_MCP_N_PATH=%%~$PATH:I"
if defined MEGA_MCP_N_PATH for %%I in ("%MEGA_MCP_N_PATH%") do for %%D in ("%%~dpI.") do if /i "%%~nxD"=="shims" set "MEGA_MCP_N_SHIM=%%~fI"
if defined MEGA_MCP_N_PATH for %%I in ("%MEGA_MCP_N_PATH%") do for %%D in ("%%~dpI.") do if /i "%%~nxD"=="Volta" set "MEGA_MCP_N_SHIM=%%~fI"
if defined MEGA_MCP_N_PATH for %%I in ("%MEGA_MCP_N_PATH%") do for %%D in ("%%~dpI.") do if /i "%%~nxD"=="bin" for %%E in ("%%~dpD.") do if /i "%%~nxE"=="Volta" set "MEGA_MCP_N_SHIM=%%~fI"
if defined MEGA_MCP_N_PATH if defined VOLTA_HOME for %%I in ("%MEGA_MCP_N_PATH%") do for %%H in ("%VOLTA_HOME%\bin\node.exe") do if /i "%%~fI"=="%%~fH" set "MEGA_MCP_N_SHIM=%%~fI"
if defined MEGA_MCP_N_SHIM set "MEGA_MCP_N_PATH="

if defined CODEX_ELECTRON_RESOURCES_PATH set "MEGA_MCP_N_RES=%CODEX_ELECTRON_RESOURCES_PATH%\cua_node\bin\node.exe"
if defined CODEX_CLI_PATH for %%I in ("%CODEX_CLI_PATH%") do set "MEGA_MCP_N_CLI=%%~dpIcua_node\bin\node.exe"
if defined USERPROFILE set "MEGA_MCP_N_CACHE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if defined LOCALAPPDATA for /d %%D in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do if exist "%%~fD\bin\node.exe" set "MEGA_MCP_N_RT=%%~fD\bin\node.exe"
if defined ProgramFiles set "MEGA_MCP_N_PF=%ProgramFiles%\nodejs\node.exe"
if defined ProgramW6432 set "MEGA_MCP_N_PF64=%ProgramW6432%\nodejs\node.exe"
if defined ProgramFiles(x86) set "MEGA_MCP_N_PF86=%ProgramFiles(x86)%\nodejs\node.exe"
if defined LOCALAPPDATA set "MEGA_MCP_N_LPROG=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if defined SCOOP set "MEGA_MCP_N_SCOOP=%SCOOP%\apps\nodejs\current\node.exe"
if defined SCOOP set "MEGA_MCP_N_SCOOPLTS=%SCOOP%\apps\nodejs-lts\current\node.exe"
if defined USERPROFILE set "MEGA_MCP_N_USCOOP=%USERPROFILE%\scoop\apps\nodejs\current\node.exe"
if defined USERPROFILE set "MEGA_MCP_N_USCOOPLTS=%USERPROFILE%\scoop\apps\nodejs-lts\current\node.exe"
if defined NVM_SYMLINK set "MEGA_MCP_N_NVM=%NVM_SYMLINK%\node.exe"
if defined FNM_DIR set "MEGA_MCP_N_FNM=%FNM_DIR%\aliases\default\node.exe"
if defined APPDATA set "MEGA_MCP_N_AFNM=%APPDATA%\fnm\aliases\default\node.exe"

rem The places searched, for the server to protect (it protects PATH's node itself): each
rem named node.exe and its folder (a folder that holds the profile, or a drive root, the
rem server leaves out; the file itself is still protected then).
rem (Each piece is built on its own and joined outside the FOR: a "%%I" inside a path already
rem in the list must not be taken for the loop's variable.)
if defined MEGA_MCP_NODE for %%I in ("%MEGA_MCP_NODE%") do set "MEGA_MCP_N_R1=;%%~fI;%%~dpI"
if defined CODEX_MCP_NODE_PATH for %%I in ("%CODEX_MCP_NODE_PATH%") do set "MEGA_MCP_N_R2=;%%~fI;%%~dpI"
if defined CODEX_BROWSER_USE_NODE_PATH for %%I in ("%CODEX_BROWSER_USE_NODE_PATH%") do set "MEGA_MCP_N_R3=;%%~fI;%%~dpI"
if defined CODEX_CLI_PATH for %%I in ("%CODEX_CLI_PATH%") do set "MEGA_MCP_N_R4=;%%~dpIcua_node"
set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_N_R1%%MEGA_MCP_N_R2%%MEGA_MCP_N_R3%%MEGA_MCP_N_R4%"
if defined ProgramFiles set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%ProgramFiles%\nodejs"
if defined ProgramW6432 set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%ProgramW6432%\nodejs"
if defined ProgramFiles(x86) set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%ProgramFiles(x86)%\nodejs"
if defined CODEX_ELECTRON_RESOURCES_PATH set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%CODEX_ELECTRON_RESOURCES_PATH%\cua_node"
if defined USERPROFILE set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%USERPROFILE%\.cache\codex-runtimes;%USERPROFILE%\scoop\apps\nodejs;%USERPROFILE%\scoop\apps\nodejs-lts"
if defined LOCALAPPDATA set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%LOCALAPPDATA%\OpenAI\Codex\runtimes;%LOCALAPPDATA%\Programs\nodejs;%LOCALAPPDATA%\Volta;%LOCALAPPDATA%\mise"
if defined APPDATA set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%APPDATA%\fnm"
if defined SCOOP set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%SCOOP%\apps\nodejs;%SCOOP%\apps\nodejs-lts"
rem (The folder a variable names, and the narrower places in it: the server leaves out a
rem folder that holds the profile or is a drive root.)
if defined NVM_SYMLINK set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%NVM_SYMLINK%;%NVM_SYMLINK%\node.exe"
if defined NVM_HOME set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%NVM_HOME%"
if defined FNM_DIR set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%FNM_DIR%;%FNM_DIR%\aliases;%FNM_DIR%\node-versions"
if defined VOLTA_HOME set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%VOLTA_HOME%;%VOLTA_HOME%\tools\image\node"
if defined MISE_DATA_DIR set "MEGA_MCP_NODE_ROOTS=%MEGA_MCP_NODE_ROOTS%;%MISE_DATA_DIR%;%MISE_DATA_DIR%\installs\node"

rem The first candidate that is Node 18+ ...
for %%N in (
  "%MEGA_MCP_NODE%"
  "%MEGA_MCP_N_PATH%"
  "%CODEX_MCP_NODE_PATH%"
  "%CODEX_BROWSER_USE_NODE_PATH%"
  "%MEGA_MCP_N_RES%"
  "%MEGA_MCP_N_CLI%"
  "%MEGA_MCP_N_CACHE%"
  "%MEGA_MCP_N_RT%"
  "%MEGA_MCP_N_PF%"
  "%MEGA_MCP_N_PF64%"
  "%MEGA_MCP_N_PF86%"
  "%MEGA_MCP_N_LPROG%"
  "%MEGA_MCP_N_SCOOP%"
  "%MEGA_MCP_N_SCOOPLTS%"
  "%MEGA_MCP_N_USCOOP%"
  "%MEGA_MCP_N_USCOOPLTS%"
  "%MEGA_MCP_N_NVM%"
  "%MEGA_MCP_N_FNM%"
  "%MEGA_MCP_N_AFNM%"
) do if not defined MEGA_MCP_N_FOUND if not "%%~N"=="" if /i "%%~xN"==".exe" if exist "%%~N" "%%~N" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~N"
rem ... else the first installed version that is, by folder name.
if not defined MEGA_MCP_N_FOUND if defined NVM_HOME for /d %%D in ("%NVM_HOME%\v*") do if not defined MEGA_MCP_N_FOUND if exist "%%~fD\node.exe" "%%~fD\node.exe" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~fD\node.exe"
if not defined MEGA_MCP_N_FOUND if defined VOLTA_HOME for /d %%D in ("%VOLTA_HOME%\tools\image\node\*") do if not defined MEGA_MCP_N_FOUND if exist "%%~fD\node.exe" "%%~fD\node.exe" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~fD\node.exe"
if not defined MEGA_MCP_N_FOUND if defined LOCALAPPDATA for /d %%D in ("%LOCALAPPDATA%\Volta\tools\image\node\*") do if not defined MEGA_MCP_N_FOUND if exist "%%~fD\node.exe" "%%~fD\node.exe" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~fD\node.exe"
if not defined MEGA_MCP_N_FOUND if defined FNM_DIR for /d %%D in ("%FNM_DIR%\node-versions\v*") do if not defined MEGA_MCP_N_FOUND if exist "%%~fD\installation\node.exe" "%%~fD\installation\node.exe" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~fD\installation\node.exe"
if not defined MEGA_MCP_N_FOUND if defined APPDATA for /d %%D in ("%APPDATA%\fnm\node-versions\v*") do if not defined MEGA_MCP_N_FOUND if exist "%%~fD\installation\node.exe" "%%~fD\installation\node.exe" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~fD\installation\node.exe"
if not defined MEGA_MCP_N_FOUND if defined MISE_DATA_DIR for /d %%D in ("%MISE_DATA_DIR%\installs\node\*") do if not defined MEGA_MCP_N_FOUND if exist "%%~fD\node.exe" "%%~fD\node.exe" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~fD\node.exe"
if not defined MEGA_MCP_N_FOUND if defined LOCALAPPDATA for /d %%D in ("%LOCALAPPDATA%\mise\installs\node\*") do if not defined MEGA_MCP_N_FOUND if exist "%%~fD\node.exe" "%%~fD\node.exe" -e "%MEGA_MCP_CHECK%" <nul >nul 2>&1 && set "MEGA_MCP_N_FOUND=%%~fD\node.exe"

if defined MEGA_MCP_N_FOUND (
  for %%V in (%MEGA_MCP_NAMES%) do set "MEGA_MCP_N_%%V="
  for %%V in (%MEGA_MCP_VARS% MEGA_MCP_NAMES MEGA_MCP_VARS MEGA_MCP_CHECK MEGA_MCP_SERVER) do set "%%V="
  "%MEGA_MCP_N_FOUND%" "%MEGA_MCP_SERVER%" %*
  exit /b
)

>&2 echo mega-mcp: Node.js 18 or later was not found, so the MEGA tools can't start.
if defined MEGA_MCP_N_SHIM >&2 echo A version manager's shim on PATH was passed over: "%MEGA_MCP_N_SHIM%"
>&2 echo Install Node.js from https://nodejs.org/ then quit and reopen the app. If Node is
>&2 echo installed somewhere this doesn't look, add MEGA_MCP_NODE='C:\full\path\to\node.exe'
>&2 echo to %%USERPROFILE%%\.codex\.env, with the single quotes, and restart Codex.
exit /b 127
