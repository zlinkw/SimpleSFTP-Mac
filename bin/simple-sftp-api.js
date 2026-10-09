#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { callLocalRpc, readLocalDiscovery, requestLocalJson } = require("../mac-api-client");

const APPDATA = require("../mac-paths").applicationDataRoot();
const discoveryPath =
  process.env.SIMPLE_SFTP_MAC_API_FILE ||
  path.join(APPDATA, "SimpleSFTPMac", "api.json");

async function main(argv) {
  const [method, ...rest] = argv;
  if (!method || method.startsWith("-")) {
    console.error("Usage: simple-sftp-mac-api <method> --json <params.json>");
    return 2;
  }
  if (method === "self-check") {
    return runSelfCheck();
  }
  const paramsFile = option(rest, "--json") || option(rest, "--params");
  let params = {};
  if (paramsFile) {
    if (!fs.existsSync(paramsFile)) throw new Error(`params file not found: ${paramsFile}`);
    params = JSON.parse(fs.readFileSync(paramsFile, "utf8"));
  }
  const result = await callLocalRpc(readDiscovery, method, params);
  if (result && result.error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: {
            code: result.error.code,
            message: result.error.message,
            data: result.error.data || {},
          },
        },
        null,
        2
      )
    );
    return 1;
  }
  console.log(JSON.stringify({ ok: true, result: result && result.result }, null, 2));
  return 0;
}

async function runSelfCheck() {
  const checks = [{ name: "cli", ok: true, detail: process.execPath }];
  if (!fs.existsSync(discoveryPath)) {
    checks.push({ name: "discovery", ok: false, detail: `missing discovery: ${discoveryPath}` });
    checks.push({ name: "listener", ok: false, detail: "missing listener: discovery file absent" });
  } else {
    let discovery;
    try {
      discovery = readDiscovery();
      checks.push({ name: "discovery", ok: true, detail: discoveryPath });
    } catch (error) {
      checks.push({ name: "discovery", ok: false, detail: error.message });
    }
    if (discovery) {
      checks.push(await checkListener(discovery));
    } else {
      checks.push({ name: "listener", ok: false, detail: "missing listener: discovery invalid" });
    }
  }
  const ok = checks.every((item) => item.ok);
  console.log(JSON.stringify({ ok, status: ok ? "ok" : "missing", checks }, null, 2));
  return ok ? 0 : 1;
}

async function checkListener(discovery) {
  try {
    const body = await requestLocalJson(discovery, "/api/v1/health", undefined, 64 * 1024, 3000);
    if (body.ok !== true) throw new Error("invalid health response");
    return { name: "listener", ok: true, detail: `${body.name || discovery.name} ${body.version || discovery.version}` };
  } catch (error) {
    return { name: "listener", ok: false, detail: `missing listener: ${error.message}` };
  }
}

function readDiscovery() {
  if (!fs.existsSync(discoveryPath)) {
    throw new Error(`SimpleSFTP API discovery not found: ${discoveryPath}. Open VS Code once to start the extension host.`);
  }
  return readLocalDiscovery(discoveryPath);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

module.exports = { main, readDiscovery };
