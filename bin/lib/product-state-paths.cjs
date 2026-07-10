const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function productAppStateRoot() {
  return path.join(os.homedir(), ".exxperts", "app");
}

function productAppStatePath(...segments) {
  return path.join(productAppStateRoot(), ...segments);
}

function ensureProductAppStateRoot() {
  const root = productAppStateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function ensureProductAppStateDir(...segments) {
  const dir = productAppStatePath(...segments);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function ensureProductAppUserDirs() {
  ensureProductAppStateRoot();
  ensureProductAppStateDir("agents");
  ensureProductAppStateDir("skills");
}

function cliLauncherStateDir() {
  const fromEnv = process.env.EXXPERTS_LAUNCHER_STATE_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv;
  return productAppStatePath("run", "cli");
}

function ensureCliLauncherStateDir() {
  const dir = cliLauncherStateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function cliLauncherStatePath(...segments) {
  return path.join(cliLauncherStateDir(), ...segments);
}

module.exports = {
  productAppStateRoot,
  productAppStatePath,
  ensureProductAppStateRoot,
  ensureProductAppStateDir,
  ensureProductAppUserDirs,
  cliLauncherStateDir,
  ensureCliLauncherStateDir,
  cliLauncherStatePath,
};
