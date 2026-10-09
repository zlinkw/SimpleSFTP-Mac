"use strict";
const path = require("node:path");
const os = require("node:os");

function applicationDataRoot(platform = process.platform, home = os.homedir(), env = process.env) {
  return platform === "darwin" ? path.join(home, "Library", "Application Support")
    : env.APPDATA || path.join(home, "AppData", "Roaming");
}
function macComponentDirectory(component, platform, home, env) {
  if (!["SimpleExperimentMac", "SimpleSFTPMac", "SimpleLocalMac"].includes(component)) throw new Error("Unknown Mac component");
  return path.join(applicationDataRoot(platform, home, env), component);
}
module.exports = { applicationDataRoot, macComponentDirectory };
