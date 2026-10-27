import { describe, expect, it } from "vitest";
import {
  CLI_ENTRY_FILE_NAME,
  SERVER_ENTRY_FILE_NAME,
  renderPortableLauncherCmd,
} from "../scripts/portable-launcher-cmd.mjs";

function renderLines(kind, entryFileName) {
  const command = renderPortableLauncherCmd({ kind, entryFileName });
  return { command, lines: command.split("\r\n") };
}

function indexAfterColonRun(lines) {
  const runIndex = lines.indexOf(":run");
  expect(runIndex).not.toBe(-1);
  return lines[runIndex + 1];
}

describe("renderPortableLauncherCmd", () => {
  it("server launcher invokes node.exe with the bb-app.js entry", () => {
    const { lines } = renderLines("server", SERVER_ENTRY_FILE_NAME);
    expect(indexAfterColonRun(lines)).toBe(
      '"%~dp0node.exe" "%~dp0node_modules\\bb-app\\dist\\bb-app.js" %*',
    );
  });

  it("cli launcher invokes node.exe with the bb.js entry", () => {
    const { lines } = renderLines("cli", CLI_ENTRY_FILE_NAME);
    expect(indexAfterColonRun(lines)).toBe(
      '"%~dp0node.exe" "%~dp0node_modules\\bb-app\\dist\\bb.js" %*',
    );
  });

  it("sets BB_DATA_DIR next to the launcher, only when it is unset", () => {
    const { lines } = renderLines("server", SERVER_ENTRY_FILE_NAME);
    expect(lines).toContain(
      'if not defined BB_DATA_DIR set "BB_DATA_DIR=%~dp0data"',
    );
    expect(
      lines.filter(
        (line) => line.includes("BB_DATA_DIR=") && !line.startsWith("if not"),
      ),
    ).toEqual([]);
  });

  it("switches to UTF-8 before running and restores the code page before exiting", () => {
    const { lines } = renderLines("server", SERVER_ENTRY_FILE_NAME);
    const switchIndex = lines.indexOf("chcp 65001 >nul");
    const restoreIndex = lines.lastIndexOf("chcp %bb_codepage% >nul");
    const exitIndex = lines.indexOf("exit /b %bb_exit%");
    expect(lines).toContain(
      "setlocal EnableExtensions DisableDelayedExpansion",
    );
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    expect(restoreIndex).toBeGreaterThan(switchIndex);
    expect(exitIndex).toBeGreaterThan(restoreIndex);
  });

  it("propagates the run exit code and exits 127 when the runtime files are absent", () => {
    const { lines } = renderLines("server", SERVER_ENTRY_FILE_NAME);
    expect(lines).toContain('set "bb_exit=%ERRORLEVEL%"');
    expect(lines).toContain('set "bb_exit=127"');
    expect(lines.at(-1)).toBe("");
  });

  it("writes the missing-runtime diagnostics to stderr", () => {
    const { lines } = renderLines("server", SERVER_ENTRY_FILE_NAME);
    const diagnosticsLine = lines.find(
      (line) =>
        line.startsWith("echo bb portable") && line.includes("is missing"),
    );
    expect(diagnosticsLine).toBeDefined();
    expect(diagnosticsLine?.endsWith(">&2")).toBe(true);
    expect(diagnosticsLine).toContain("node.exe");
  });

  it("renders CRLF endings and distinguishes the server and cli markers", () => {
    const server = renderPortableLauncherCmd({
      kind: "server",
      entryFileName: SERVER_ENTRY_FILE_NAME,
    });
    const cli = renderPortableLauncherCmd({
      kind: "cli",
      entryFileName: CLI_ENTRY_FILE_NAME,
    });
    expect(server.endsWith("\r\n")).toBe(true);
    expect(server).toContain("bb portable server launcher");
    expect(cli).toContain("bb portable CLI launcher");
    expect(server).not.toBe(cli);
  });
});
