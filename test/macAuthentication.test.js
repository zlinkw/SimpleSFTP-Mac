const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { MacAuthentication, identity, profile, sshAuthArgs } = require("../mac-auth");
const target = (host = "worker.example.org") => ({ host, username: "scientist", port: 2222 });
function context() {
  const states = new Map(), secrets = new Map(), writes = [];
  return { states, storedSecrets: secrets, writes,
    globalState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { writes.push(key); secrets.set(key, value); } } };
}
function setProfile(ctx, dest, value) {
  const state = ctx.states.get("simple-sftp-mac.auth-profiles.v1") || {};
  ctx.states.set("simple-sftp-mac.auth-profiles.v1", { ...state, [identity(dest).key]: value });
}
function ask(invocation, prompt, nonce = invocation.env.SIMPLE_SFTP_AUTH_NONCE) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: Number(invocation.env.SIMPLE_SFTP_AUTH_PORT), path: "/askpass", method: "POST", headers: { "X-Simple-SFTP-Auth": nonce } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => text += chunk); response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    request.on("error", reject); request.end(JSON.stringify({ prompt }));
  });
}

test("key, agent and password modes enforce independent authentication without credentials in arguments", () => {
  const key = sshAuthArgs({ method: "key", privateKeyPath: "/Users/test/密钥 A" });
  assert.ok(key.includes("/Users/test/密钥 A")); assert.ok(key.includes("IdentitiesOnly=yes")); assert.ok(key.includes("IdentityAgent=none"));
  const agent = sshAuthArgs({ method: "agent" }); assert.ok(agent.includes("IdentityFile=none")); assert.ok(agent.includes("PreferredAuthentications=publickey"));
  const password = sshAuthArgs({ method: "password" }); assert.ok(password.includes("PubkeyAuthentication=no")); assert.ok(password.includes("BatchMode=no"));
  for (const args of [key, agent, password]) { assert.ok(args.includes("ForwardAgent=no")); assert.doesNotMatch(args.join(" "), /BatchMode=yes|sshpass|password=/); }
  assert.throws(() => profile({ method: "key", privateKeyPath: "~/id" }));
  assert.throws(() => identity({ ...target(), host: "-oProxyCommand=bad" }));
  assert.notEqual(identity(target()).key, identity({ ...target(), username: "Scientist" }).key);
  assert.equal(identity(target("[::1]")).host, "::1");
});

test("configuration offers an unchecked save checkbox and never writes plaintext credentials", async () => {
  for (const remember of [false, true]) {
    const ctx = context(); let count = 0;
    const ui = { showQuickPick: async (items, options) => { count++; if (count === 1) return items.find(item => item.method === "key"); assert.equal(options.canPickMany, true); assert.equal(items[0].picked, false); return remember ? [items[0]] : []; }, showOpenDialog: async () => [{ fsPath: "/Users/test/密钥 A" }] };
    const manager = new MacAuthentication(ctx, ui);
    assert.equal(await manager.configure(target()), true); assert.equal(manager.config(target()).remember, remember);
    assert.equal(ctx.writes.length, 0); assert.equal(manager.config(target()).privateKeyPath, "/Users/test/密钥 A");
  }
});

test("separate servers use isolated session credentials, with no implicit SecretStorage writes", async () => {
  const ctx = context(); let inputs = 0;
  const manager = new MacAuthentication(ctx, { showInputBox: async options => { assert.equal(options.password, true); return "秘密-" + ++inputs; } });
  await manager.start();
  try {
    const a = manager.invocation(target()), b = manager.invocation(target("other.example.org"));
    const ar = await ask(a, "scientist@worker.example.org's password: "); const br = await ask(b, "scientist@other.example.org's password: ");
    assert.equal(ar.status, 200); assert.equal(br.status, 200); assert.notEqual(ar.text, br.text); assert.equal(inputs, 2);
    const a2 = manager.invocation(target()); assert.equal((await ask(a2, "scientist@worker.example.org's password: ")).text, ar.text); assert.equal(inputs, 2);
    assert.equal((await ask(a2, "Password:")).status, 403);
    assert.equal(ctx.writes.length, 0); assert.ok(!JSON.stringify([...ctx.states]).includes("秘密")); assert.ok(!JSON.stringify(a.env).includes("秘密"));
    assert.equal((await ask(a, "scientist@other.example.org's password: ")).status, 403);
    a.release(); assert.equal((await ask(a, "Password:")).status, 403);
    assert.equal((await ask(b, "Password:", "0".repeat(64))).status, 403);
  } finally { await manager.dispose(); }
  assert.equal(manager.memory.size, 0); assert.equal(manager.sessions.size, 0);
});

test("explicit remember survives reload and unchecked sessions never read older saved secrets", async () => {
  const ctx = context(); setProfile(ctx, target(), { method: "password", remember: true });
  let inputs = 0; const ui = { showInputBox: async () => { inputs++; return "test secret"; } };
  let manager = new MacAuthentication(ctx, ui); await manager.start();
  assert.equal((await ask(manager.invocation(target()), "Password:")).text, "test secret"); assert.equal(ctx.writes.length, 1); await manager.dispose();
  manager = new MacAuthentication(ctx, ui); await manager.start();
  assert.equal((await ask(manager.invocation(target()), "Password:")).text, "test secret"); assert.equal(inputs, 1); await manager.dispose();
  setProfile(ctx, target(), { method: "password", remember: false }); manager = new MacAuthentication(ctx, ui); await manager.start();
  try { await ask(manager.invocation(target()), "Password:"); assert.equal(inputs, 2); assert.equal(ctx.writes.length, 1); } finally { await manager.dispose(); }
});

test("encrypted key prompts are bound to the selected path; retries reprompt and stop after three", async () => {
  const ctx = context(); setProfile(ctx, target(), { method: "key", privateKeyPath: "/Users/test/密钥 A", remember: false });
  let count = 0; const manager = new MacAuthentication(ctx, { showInputBox: async () => "phrase-" + ++count }); await manager.start();
  try {
    const request = manager.invocation(target());
    assert.equal((await ask(request, "Enter passphrase for key '/Users/test/other': ")).status, 403);
    const prompt = "Enter passphrase for key '/Users/test/密钥 A': ";
    for (let n = 1; n <= 3; n++) assert.equal((await ask(request, prompt)).text, "phrase-" + n);
    assert.equal((await ask(request, prompt)).status, 403); assert.equal(count, 3);
  } finally { await manager.dispose(); }
});

test("simultaneous connections coalesce input; cancelled input cannot produce a credential", async () => {
  const ctx = context(); let entered, finish, count = 0;
  const ready = new Promise(resolve => entered = resolve);
  const manager = new MacAuthentication(ctx, { showInputBox: async () => { count++; entered(); return new Promise(resolve => finish = resolve); } }); await manager.start();
  try {
    const first = ask(manager.invocation(target()), "scientist@worker.example.org's password: "); const second = ask(manager.invocation(target()), "scientist@worker.example.org's password: ");
    await ready; await new Promise(resolve => setTimeout(resolve, 20)); finish("coalesced");
    assert.equal((await first).text, "coalesced"); assert.equal((await second).text, "coalesced"); assert.equal(count, 1);
    manager.ui.showInputBox = async () => undefined;
    assert.equal((await ask(manager.invocation(target("cancel.example.org")), "scientist@cancel.example.org's password: ")).status, 403);
  } finally { await manager.dispose(); }
});

test("real Node askpass helper reads only the scoped IPC credential and exits without logging it", async () => {
  const ctx = context(); setProfile(ctx, target(), { method: "password" });
  const manager = new MacAuthentication(ctx, { showInputBox: async () => "中文 askpass secret" }); await manager.start();
  try {
    const invocation = manager.invocation(target());
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "../mac-ssh-askpass.js"), "Password:"], { env: invocation.env, windowsHide: true, timeout: 10000 });
      let stdout = "", stderr = ""; child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
      child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0); assert.equal(result.stdout, "中文 askpass secret\n"); assert.equal(result.stderr, "");
    const shell = fs.readFileSync(path.join(__dirname, "../mac-ssh-askpass.sh"), "utf8"); assert.ok(shell.startsWith("#!/bin/sh\n")); assert.ok(!shell.includes("\r"));
  } finally { await manager.dispose(); }
});

test("actual SSH process wrappers bind both relay identities and keep successful contexts until close", async () => {
  const Module = require("node:module"), original = Module._load;
  Module._load = function(name, ...args) { return name === "vscode" ? { TreeItem: class {} } : original.call(this, name, ...args); };
  let helpers; try { helpers = require("../extension").__test; } finally { Module._load = original; }
  const ctx = context(); setProfile(ctx, target(), { method: "password" }); setProfile(ctx, target("other.example.org"), { method: "agent" });
  const manager = new MacAuthentication(ctx, { showInputBox: async () => "scoped" }); await manager.start(); helpers.setMacAuthentication(manager);
  const processes = [], calls = [];
  const fake = (file, args, options) => { const child = new EventEmitter(); processes.push(child); calls.push({ file, args, options }); return child; };
  try {
    helpers.spawnSsh(target(), "tar read", { stdio: ["pipe", "pipe", "pipe"] }, fake, ["-A", "-o", "BatchMode=yes"]);
    helpers.spawnSsh(target("other.example.org"), "tar write", { stdio: ["pipe", "ignore", "pipe"] }, fake);
    assert.ok(calls[0].args.includes("PubkeyAuthentication=no")); assert.ok(calls[1].args.includes("IdentityFile=none"));
    assert.ok(!calls[0].args.includes("-A")); assert.notEqual(calls[0].options.env.SIMPLE_SFTP_AUTH_NONCE, calls[1].options.env.SIMPLE_SFTP_AUTH_NONCE);
    assert.equal(manager.sessions.size, 2); processes[0].emit("exit", 0); assert.equal(manager.sessions.size, 2);
    processes[0].emit("close", 0); assert.equal(manager.sessions.size, 1); processes[1].emit("error", Error("failed")); assert.equal(manager.sessions.size, 0);
    assert.throws(() => helpers.spawnSsh(target(), "cmd", {}, () => { throw Error("spawn failed"); }), /spawn failed/); assert.equal(manager.sessions.size, 0);
  } finally { helpers.setMacAuthentication(undefined); await manager.dispose(); }
});
