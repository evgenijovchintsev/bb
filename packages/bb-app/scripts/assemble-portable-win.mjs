import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPortableLauncherCmd } from "./portable-launcher-cmd.mjs";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = resolve(scriptDirectory, "..");

const DEFAULT_NODE_VERSION = "22.22.1";
const DEFAULT_NODE_DIST_URL = "https://nodejs.org/dist";

const WATCHER_WIN_DIRECTORY = join(
  "node_modules",
  "@parcel",
  "watcher-win32-x64",
);

const EXPECTED_ARTIFACTS = [
  join("node_modules", "better-sqlite3", "prebuilds", "win32-x64.node"),
  join("node_modules", "node-pty", "prebuilds", "win32-x64", "conpty.node"),
  join(
    "node_modules",
    "node-pty",
    "prebuilds",
    "win32-x64",
    "conpty",
    "conpty.dll",
  ),
  join(
    "node_modules",
    "node-pty",
    "prebuilds",
    "win32-x64",
    "conpty",
    "OpenConsole.exe",
  ),
  join(
    "node_modules",
    "fs-native-extensions",
    "prebuilds",
    "win32-x64",
    "fs-native-extensions.bare",
  ),
  join(WATCHER_WIN_DIRECTORY, "watcher.node"),
  join("node_modules", "bb-app", "dist", "bb-app.js"),
  join("node_modules", "bb-app", "dist", "bb.js"),
  "node.exe",
];

function requiredString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The bb-app package must declare ${description}.`);
  }
  return value;
}

function readArguments(argv, flags) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flags.has(flag)) {
      throw new Error(
        `Unexpected argument "${flag}". Expected ${[...flags.keys()].join(" ")}.`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined) {
      throw new Error(`Flag "${flag}" is missing its value.`);
    }
    values.set(flag, value);
    index += 1;
  }
  return values;
}

function execFile(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFileCallback(
      file,
      args,
      { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(
            new Error(
              `${file} ${args.join(" ")} failed: ${error.message}${stderr ? `\n${stderr.trim()}` : ""}`,
            ),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function assertResponseOk(response, url) {
  if (!response.ok) {
    throw new Error(
      `GET ${url} returned ${response.status} ${response.statusText}.`,
    );
  }
}

function tar(args) {
  const run = spawnSync("tar", args, {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.status !== 0) {
    throw new Error(`tar ${args.join(" ")} exited with code ${run.status}.`);
  }
}

async function npmMajorAndMinorVersion() {
  const output = (await execFile("npm", ["--version"])).trim();
  const [major, minor] = output.split(".").map(Number);
  if (Number.isNaN(major) || Number.isNaN(minor)) {
    throw new Error(
      `npm --version printed "${output}", which is not a version.`,
    );
  }
  return { major, minor };
}

async function registryUrl() {
  const url = (await execFile("npm", ["config", "get", "registry"])).trim();
  if (url.length === 0) {
    throw new Error("npm config get registry returned no value.");
  }
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function packedTarballPath() {
  const builtEntryPoint = join(packageRoot, "dist", "bb-app.js");
  await readFile(builtEntryPoint);
  const destinationDirectory = await mkdtemp(join(tmpdir(), "bb-app-pack-"));
  await execFile("npm", ["pack", "--pack-destination", destinationDirectory], {
    cwd: packageRoot,
  });
  const entries = await readdir(destinationDirectory);
  const packedName = entries.find((entry) => entry.endsWith(".tgz"));
  if (packedName === undefined) {
    throw new Error("npm pack did not produce a tarball.");
  }
  return resolve(destinationDirectory, packedName);
}

async function installTarball({
  outDirectory,
  tarballPath,
  crossPlatformFlags,
}) {
  const installArgs = [
    "install",
    tarballPath,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
  ];
  if (crossPlatformFlags) {
    installArgs.push("--os=win32", "--cpu=x64");
  }
  await execFile("npm", installArgs, { cwd: outDirectory });
}

async function addWatcherWinTarball({ outDirectory, watcherVersion }) {
  const registry = await registryUrl();
  const metadataUrl = `${registry}/@parcel/watcher-win32-x64/${watcherVersion}`;
  const metadataResponse = await fetch(metadataUrl);
  await assertResponseOk(metadataResponse, metadataUrl);
  const metadata = await metadataResponse.json();
  const integrity = metadata?.dist?.integrity;
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
    throw new Error(
      `Registry metadata ${metadataUrl} is missing a sha512 dist integrity.`,
    );
  }
  const tarballUrl = `${registry}/@parcel/watcher-win32-x64/-/watcher-win32-x64-${watcherVersion}.tgz`;
  const tarballResponse = await fetch(tarballUrl);
  await assertResponseOk(tarballResponse, tarballUrl);
  const bytes = await downloadBytes(tarballResponse.body);
  const sha512Base64 = createHash("sha512").update(bytes).digest("base64");
  if (sha512Base64 !== integrity.slice("sha512-".length)) {
    throw new Error(
      `Downloaded watcher-win32-x64 tarball sha512 ${sha512Base64} does not match the registry integrity.`,
    );
  }
  const tarballPath = join(outDirectory, "watcher-win32-x64.tgz");
  await writeFile(tarballPath, bytes);
  const targetDirectory = join(outDirectory, WATCHER_WIN_DIRECTORY);
  await mkdir(targetDirectory, { recursive: true });
  tar(["-xzf", tarballPath, "-C", targetDirectory, "--strip-components", "1"]);
  await rm(tarballPath, { force: true });
}

async function downloadBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function downloadNodeExecutable({
  outDirectory,
  nodeVersion,
  nodeDistUrl,
}) {
  const shasumsUrl = `${nodeDistUrl}/v${nodeVersion}/SHASUMS256.txt`;
  const shasumsResponse = await fetch(shasumsUrl);
  await assertResponseOk(shasumsResponse, shasumsUrl);
  const shasumsText = await shasumsResponse.text();
  const shasumsLine = shasumsText
    .split("\n")
    .find((line) => line.trimEnd().endsWith("win-x64/node.exe"));
  if (shasumsLine === undefined) {
    throw new Error(
      `SHASUMS256.txt for Node ${nodeVersion} lacks win-x64/node.exe.`,
    );
  }
  const expectedSha256 = shasumsLine.trim().split(/\s+/)[0];
  const nodeUrl = `${nodeDistUrl}/v${nodeVersion}/win-x64/node.exe`;
  const nodeResponse = await fetch(nodeUrl);
  await assertResponseOk(nodeResponse, nodeUrl);
  const bytes = await downloadBytes(nodeResponse.body);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(
      `Node ${nodeVersion} win-x64/node.exe sha256 ${sha256} does not match SHASUMS256.txt ${expectedSha256}.`,
    );
  }
  await writeFile(join(outDirectory, "node.exe"), bytes);
}

function launchers() {
  return [
    ["bb-server.cmd", { kind: "server", entryFileName: "bb-app.js" }],
    ["bb.cmd", { kind: "cli", entryFileName: "bb.js" }],
  ];
}

async function validateAssembledTree(outDirectory) {
  const missing = [];
  for (const artifact of EXPECTED_ARTIFACTS) {
    try {
      await readFile(join(outDirectory, artifact));
    } catch {
      missing.push(artifact);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Assembled portable tree lacks expected artifacts:\n${missing.join("\n")}`,
    );
  }
}

async function assemble({
  outDirectory,
  nodeVersion,
  nodeDistUrl,
  tarballOverride,
}) {
  await rm(outDirectory, { recursive: true, force: true });
  const bbAppPackage = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const bbAppVersion = requiredString(bbAppPackage.version, "bb-app version");
  const watcherVersion = requiredString(
    bbAppPackage.dependencies?.["@parcel/watcher"],
    "@parcel/watcher version in bb-app dependencies",
  );
  const tarballPath = tarballOverride
    ? resolve(tarballOverride)
    : await packedTarballPath();
  const { major, minor } = await npmMajorAndMinorVersion();
  const crossPlatformFlags = major > 10 || (major === 10 && minor >= 5);
  await mkdir(outDirectory, { recursive: true });
  await writeFile(
    join(outDirectory, "package.json"),
    `${JSON.stringify(
      { name: "bb-portable-win-x64", version: bbAppVersion, private: true },
      null,
      2,
    )}\n`,
  );
  await installTarball({ outDirectory, tarballPath, crossPlatformFlags });
  try {
    await readFile(join(outDirectory, WATCHER_WIN_DIRECTORY, "watcher.node"));
  } catch {
    if (crossPlatformFlags) {
      throw new Error(
        `npm install with --os=win32 --cpu=x64 produced no ${WATCHER_WIN_DIRECTORY}.`,
      );
    }
    await addWatcherWinTarball({ outDirectory, watcherVersion });
  }
  await rm(join(outDirectory, "package-lock.json"), { force: true });
  await downloadNodeExecutable({ outDirectory, nodeVersion, nodeDistUrl });
  for (const [launcherName, launcherArgs] of launchers()) {
    await writeFile(
      join(outDirectory, launcherName),
      renderPortableLauncherCmd(launcherArgs),
    );
  }
  await validateAssembledTree(outDirectory);
  return { bbAppVersion };
}

function compress(outDirectory, zipPath) {
  if (process.platform === "win32") {
    const run = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Compress-Archive -Force -DestinationPath '${zipPath}' -Path '${outDirectory}\\*'`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (run.status !== 0) {
      throw new Error(`Compress-Archive exited with code ${run.status}.`);
    }
    return;
  }
  const run = spawnSync("zip", ["-r", "-q", zipPath, "."], {
    cwd: outDirectory,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.status !== 0) {
    if (run.error?.code === "ENOENT") {
      throw new Error(
        `zip executable is unavailable; the assembled tree stays at ${outDirectory}.`,
      );
    }
    throw new Error(`zip exited with code ${run.status}.`);
  }
}

async function main() {
  const flags = readArguments(
    process.argv.slice(2),
    new Set(["--out", "--node-version", "--node-dist-url", "--tarball"]),
  );
  const outDirectory = resolve(
    packageRoot,
    flags.get("--out") ?? join("dist", "portable-win-x64"),
  );
  const nodeVersion = flags.get("--node-version") ?? DEFAULT_NODE_VERSION;
  const nodeDistUrl = (
    flags.get("--node-dist-url") ?? DEFAULT_NODE_DIST_URL
  ).replace(/\/+$/, "");
  const tarballOverride = flags.get("--tarball");
  const { bbAppVersion } = await assemble({
    outDirectory,
    nodeVersion,
    nodeDistUrl,
    tarballOverride,
  });
  const zipPath = resolve(
    outDirectory,
    "..",
    `bb-portable-win-x64-${bbAppVersion}.zip`,
  );
  await rm(zipPath, { force: true });
  compress(outDirectory, zipPath);
  const zipBytes = statSync(zipPath).size;
  console.log(
    `Assembled bb-portable-win-x64 ${bbAppVersion} at ${outDirectory}`,
    `\nZip: ${zipPath} (${zipBytes} bytes)`,
  );
}

const scriptPath = resolve(fileURLToPath(import.meta.url));
if (resolve(process.argv[1] ?? "") === scriptPath) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
