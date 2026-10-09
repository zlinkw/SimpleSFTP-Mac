const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const source = fs.readFileSync(path.join(root, "extension.js"), "utf8");

test("public SimpleSFTP has no personal connection defaults", () => {
  assert.equal(packageJson.name, "simple-sftp");
  assert.equal(packageJson.displayName, "SimpleSFTP");
  assert.equal(packageJson.__metadata, undefined);
  for (const key of ["remoteBase", "localBase", "sshHost", "execHost", "userName"]) {
    assert.equal(packageJson.contributes.configuration.properties[`simpleSftp.${key}`].default, "");
  }
});

test("public SimpleSFTP migrates legacy profiles without keeping legacy branding", () => {
  assert.match(source, /SimpleSFTP/);
  assert.match(source, /LEGACY_SHARED_SERVER_FILE/);
  assert.match(source, /fs\.copyFileSync\(LEGACY_SHARED_SERVER_FILE, SHARED_SERVER_FILE\)/);
  assert.match(source, /\.simple-sftp-handoff\.json/);
  assert.match(source, /simple-sftp-target/);
  assert.doesNotMatch(source, /"zlk-target"/);
});
