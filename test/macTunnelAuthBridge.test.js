const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { MacAuthentication, identity } = require("../mac-auth");
const { createTunnelAuthBridge } = require("../mac-tunnel-auth");

const target = (host = "worker.example.org") => ({ host, username: "scientist", port: 2222 });
function context() {
  const states = new Map(), secrets = new Map();
  return { globalState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) },
    secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); } } };
}
function setProfile(ctx, dest, value) {
  const state = ctx.globalState.get("simple-sftp-mac.auth-profiles.v1") || {};
  ctx.globalState.update("simple-sftp-mac.auth-profiles.v1", { ...state, [identity(dest).key]: value });
}
function ask(port, nonce, prompt) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/askpass", method: "POST", headers: { "X-Simple-SFTP-Auth": nonce } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => text += chunk); response.on("end", () => resolve({ status: response.statusCode, text }));
    });
    request.on("error", reject); request.end(JSON.stringify({ prompt }));
  });
}
async function service(ui, ctx = context()) {
  const manager = new MacAuthentication(ctx, ui);
  await manager.start();
  return { manager, ctx };
}

test("acquire returns identity-bound askpass materials and release ends the prompt session", async () => {
  const { manager, ctx } = await service({ showInputBox: async options => { assert.equal(options.password, true); return "秘密隧道"; } });
  setProfile(ctx, target(), { method: "password", privateKeyPath: "", remember: false });
  const bridge = createTunnelAuthBridge(() => manager);
  const acquired = await bridge.acquire(target());
  assert.equal(acquired.ok, true);
  assert.equal(acquired.env.SIMPLE_SFTP_AUTH_NONCE, acquired.nonce);
  assert.equal(acquired.env.SSH_ASKPASS, path.join(__dirname, "..", "mac-ssh-askpass.sh"));
  assert.ok(acquired.args.includes("PubkeyAuthentication=no"));
  assert.doesNotMatch(JSON.stringify(acquired), /秘密隧道/);
  const answered = await ask(Number(acquired.env.SIMPLE_SFTP_AUTH_PORT), acquired.nonce, "scientist@worker.example.org's password: ");
  assert.equal(answered.status, 200); assert.equal(answered.text, "秘密隧道");
  assert.equal(bridge.release(acquired.nonce), true);
  const after = await ask(Number(acquired.env.SIMPLE_SFTP_AUTH_PORT), acquired.nonce, "scientist@worker.example.org's password: ");
  assert.equal(after.status, 403);
  assert.equal(bridge.release(acquired.nonce), false);
  assert.equal(bridge.release(undefined), false);
  assert.equal(bridge.release("ffffffff".repeat(8)), false);
  await bridge.dispose(); await manager.dispose();
});

test("ttl expires the session without an explicit release and dispose clears every nonce", async () => {
  const { manager, ctx } = await service({ showInputBox: async () => "口令" });
  setProfile(ctx, target(), { method: "password", privateKeyPath: "", remember: false });
  const bridge = createTunnelAuthBridge(() => manager, { ttlMs: 120 });
  const short = await bridge.acquire(target());
  assert.equal(bridge.size(), 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(bridge.size(), 0);
  assert.equal((await ask(Number(short.env.SIMPLE_SFTP_AUTH_PORT), short.nonce, "scientist@worker.example.org's password: ")).status, 403);
  const held = await bridge.acquire(target("other.example.org"));
  assert.equal((await ask(Number(held.env.SIMPLE_SFTP_AUTH_PORT), held.nonce, "scientist@other.example.org's password: ")).status, 200);
  await bridge.dispose();
  assert.equal(bridge.size(), 0);
  assert.equal((await ask(Number(held.env.SIMPLE_SFTP_AUTH_PORT), held.nonce, "scientist@other.example.org's password: ")).status, 403);
  await assert.rejects(bridge.acquire(target()), /已停用/);
  await manager.dispose();
});

test("invalid identity, missing service and session capacity fail closed before any prompt", async () => {
  const { manager } = await service({ showInputBox: async () => { throw new Error("must not prompt"); } });
  await assert.rejects(createTunnelAuthBridge(() => manager).acquire({ ...target(), host: "-oProxyCommand=bad" }), /认证需要有效/);
  await assert.rejects(createTunnelAuthBridge(() => undefined).acquire(target()), /认证服务尚未就绪/);
  const bridge = createTunnelAuthBridge(() => manager, { maxSessions: 2 });
  await bridge.acquire(target());
  await bridge.acquire(target("other.example.org"));
  await assert.rejects(bridge.acquire(target("third.example.org")), /上限/);
  assert.equal(bridge.size(), 2);
  await bridge.dispose(); await manager.dispose();
});

test("a cancelled password prompt deactivates only the matching nonce session", async () => {
  let inputs = 0;
  const { manager } = await service({ showInputBox: async () => { inputs++; return undefined; } });
  const bridge = createTunnelAuthBridge(() => manager);
  const a = await bridge.acquire(target());
  const b = await bridge.acquire(target("other.example.org"));
  assert.equal((await ask(Number(a.env.SIMPLE_SFTP_AUTH_PORT), a.nonce, "scientist@worker.example.org's password: ")).status, 403);
  assert.equal(bridge.size(), 2);
  assert.equal((await ask(Number(a.env.SIMPLE_SFTP_AUTH_PORT), a.nonce, "scientist@worker.example.org's password: ")).status, 403);
  assert.equal((await ask(Number(b.env.SIMPLE_SFTP_AUTH_PORT), b.nonce, "scientist@other.example.org's password: ")).status, 403);
  assert.equal(inputs, 2);
  await bridge.dispose(); await manager.dispose();
});
