export const BB_APP_BIN_DIRECTORY = "node_modules\\bb-app\\dist";

export const SERVER_ENTRY_FILE_NAME = "bb-app.js";
export const CLI_ENTRY_FILE_NAME = "bb.js";

export const PORTABLE_DATA_DIRECTORY = "data";

export function renderPortableLauncherCmd({ kind, entryFileName }) {
  const entryPath = `${BB_APP_BIN_DIRECTORY}\\${entryFileName}`;
  const marker =
    kind === "server"
      ? "bb portable server launcher"
      : "bb portable CLI launcher";
  const lines = [
    "@echo off",
    `rem ${marker}`,
    "setlocal EnableExtensions DisableDelayedExpansion",
    'for /f "tokens=2 delims=:." %%c in (\'chcp\') do set "bb_codepage=%%c"',
    "chcp 65001 >nul",
    `if not defined BB_DATA_DIR set "BB_DATA_DIR=%~dp0${PORTABLE_DATA_DIRECTORY}"`,
    `if exist "%~dp0node.exe" if exist "%~dp0${entryPath}" goto run`,
    `echo ${marker}: node.exe or ${entryPath} is missing >&2`,
    'set "bb_exit=127"',
    "goto done",
    ":run",
    `"%~dp0node.exe" "%~dp0${entryPath}" %*`,
    'set "bb_exit=%ERRORLEVEL%"',
    ":done",
    "chcp %bb_codepage% >nul",
    "exit /b %bb_exit%",
    "",
  ];
  return lines.join("\r\n");
}
