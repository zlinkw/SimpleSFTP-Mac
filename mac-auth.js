"use strict";
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const STATE = "simple-sftp-mac.auth-profiles.v1";
const digest = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");

function identity(target) {
  const host = String(target.host || "").trim().replace(/^\[|\]$/g, "");
  const user = String(target.username || target.user || "").trim();
  const port = Number(target.port ?? target.sshPort ?? 22);
  if ((!net.isIP(host) && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) || !/^[a-zA-Z0-9._-]+$/.test(user) || !Number.isInteger(port) || port < 1 || port > 65535) throw Error("认证需要有效 SSH 地址、用户名和端口。");
  return { host, user, port, key: digest(JSON.stringify([host.toLowerCase(), user, port])), label: `${user}@${host}:${port}` };
}
function profile(value = {}) {
  const method = value.method || "auto";
  if (!["auto", "key", "agent", "password"].includes(method)) throw Error("不支持的 SSH 认证方式。");
  const privateKeyPath = method === "key" ? value.privateKeyPath : "";
  if (method === "key" && (typeof privateKeyPath !== "string" || !privateKeyPath.startsWith("/") || /[\x00-\x1f\x7f]/.test(privateKeyPath))) throw Error("私钥必须选择 Mac 上的绝对路径。");
  return { method, privateKeyPath, remember: value.remember === true };
}
function sshAuthArgs(config) {
  config = profile(config);
  const args = ["-o", "BatchMode=no", "-o", "NumberOfPasswordPrompts=3", "-o", "StrictHostKeyChecking=accept-new", "-o", "ForwardAgent=no", "-o", "ControlMaster=no", "-o", "ControlPath=none"];
  if (config.method === "password") args.push("-F", "none", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=password,keyboard-interactive");
  if (config.method === "key") args.push("-F", "none", "-i", config.privateKeyPath, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "PreferredAuthentications=publickey");
  if (config.method === "agent") args.push("-F", "none", "-o", "IdentityFile=none", "-o", "PreferredAuthentications=publickey");
  return args;
}

class MacAuthentication {
  constructor(context, ui, options = {}) {
    this.context = context; this.ui = ui; this.options = options;
    this.memory = new Map(); this.pending = new Map(); this.sessions = new Map(); this.disposed = false;
  }
  config(target) { return profile(this.context.globalState.get(STATE, {})[identity(target).key]); }
  async configure(target) {
    const id = identity(target);
    const choice = await this.ui.showQuickPick([
      { label: "系统 SSH 配置 / 自动", method: "auto" }, { label: "选择私钥（支持口令）", method: "key" },
      { label: "ssh-agent", method: "agent" }, { label: "密码", method: "password" },
    ], { title: `SimpleSFTP Mac 认证：${id.label}` });
    if (!choice) return false;
    let privateKeyPath = "";
    if (choice.method === "key") {
      const files = await this.ui.showOpenDialog({ title: "选择本机 SSH 私钥", canSelectMany: false, canSelectFolders: false });
      if (!files?.length) return false;
      privateKeyPath = files[0].fsPath;
    }
    const remember = await this.ui.showQuickPick([
      { label: "使用 VS Code SecretStorage 保存密码 / 私钥口令", picked: false },
    ], { title: "凭据记忆方式", canPickMany: true, placeHolder: "默认不勾选，仅当前会话记忆；回车确认" });
    if (remember === undefined) return false;
    const next = profile({ method: choice.method, privateKeyPath, remember: remember.length > 0 });
    const stored = this.context.globalState.get(STATE, {});
    await this.context.globalState.update(STATE, { ...stored, [id.key]: next });
    for (const key of this.memory.keys()) if (key.startsWith(id.key + ":")) this.memory.delete(key);
    return true;
  }
  async start() {
    const helper = path.join(__dirname, "mac-ssh-askpass.sh");
    if ((this.options.platform || process.platform) === "darwin") {
      if (!fs.lstatSync(helper).isFile() || fs.lstatSync(helper).isSymbolicLink()) throw Error("SSH askpass helper 身份无效。");
      fs.chmodSync(helper, 0o700);
    }
    this.server = http.createServer((request, response) => { void this.handle(request, response); });
    this.server.requestTimeout = 90000; this.server.headersTimeout = 5000;
    await new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.server.unref();
  }
  invocation(target) {
    if (this.disposed || !this.server?.listening) throw Error("Mac 认证服务尚未就绪。");
    const id = identity(target), config = this.config(target), nonce = crypto.randomBytes(32).toString("hex");
    this.sessions.set(nonce, { id, config, attempts: {}, active: true });
    const env = { ...process.env, SSH_ASKPASS: path.join(__dirname, "mac-ssh-askpass.sh"), SSH_ASKPASS_REQUIRE: "force", DISPLAY: process.env.DISPLAY || ":0",
      ELECTRON_RUN_AS_NODE: "1", SIMPLE_SFTP_NODE: process.execPath, SIMPLE_SFTP_HELPER: path.join(__dirname, "mac-ssh-askpass.js"),
      SIMPLE_SFTP_AUTH_PORT: String(this.server.address().port), SIMPLE_SFTP_AUTH_NONCE: nonce };
    return { args: sshAuthArgs(config), env, release: () => { const session = this.sessions.get(nonce); if (session) session.active = false; this.sessions.delete(nonce); } };
  }
  async handle(request, response) {
    const deny = () => { if (!response.destroyed) { response.writeHead(403); response.end(); } };
    const session = this.sessions.get(request.headers["x-simple-sftp-auth"]);
    if (request.method !== "POST" || request.url !== "/askpass" || request.socket.remoteAddress !== "127.0.0.1" || !session?.active || request.headers.origin) { deny(); request.resume(); return; }
    let text = "", oversized = false;
    request.setEncoding("utf8");
    request.on("data", chunk => { if (Buffer.byteLength(text) + Buffer.byteLength(chunk) > 8192) { oversized = true; text = ""; } else if (!oversized) text += chunk; });
    request.on("error", deny);
    request.on("end", async () => {
      try {
        if (oversized) throw Error("prompt too large");
        const prompt = JSON.parse(text).prompt;
        if (typeof prompt !== "string" || /[\x00-\x1f\x7f]/.test(prompt)) throw Error("invalid prompt");
        const kind = this.promptKind(prompt, session);
        session.attempts[kind] = (session.attempts[kind] || 0) + 1;
        if (!kind || session.attempts[kind] > 3) throw Error("unsupported prompt");
        const value = await this.secret(session, kind, prompt, session.attempts[kind] > 1);
        if (!session.active || this.disposed || response.destroyed || value === undefined) { deny(); return; }
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); response.end(value);
      } catch { deny(); }
    });
  }
  promptKind(prompt, session) {
    if (session.config.method !== "password" && session.config.method !== "agent" && /^Enter passphrase for key /i.test(prompt)) {
      if (session.config.method === "key" && !prompt.includes("'" + session.config.privateKeyPath + "'")) return "";
      return "passphrase";
    }
    if (!["key", "agent"].includes(session.config.method) && (session.config.method === "password" && /^password:\s*$/i.test(prompt) || prompt === `${session.id.user}@${session.id.host}'s password: ` || prompt === `${session.id.user}@${session.id.host}'s password:`)) return "password";
    return "";
  }
  async secret(session, kind, prompt, fresh) {
    const key = `${session.id.key}:${session.config.method}:${digest(session.config.privateKeyPath || prompt)}:${kind}`;
    if (fresh) this.memory.delete(key);
    if (!fresh && this.memory.has(key)) return this.memory.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const work = (async () => {
      if (!fresh && session.config.remember) {
        const stored = await this.context.secrets.get("simple-sftp-mac.auth." + key);
        if (stored !== undefined) { if (!session.active || this.disposed) return undefined; this.memory.set(key, stored); return stored; }
      }
      const value = await this.ui.showInputBox({ title: `SimpleSFTP Mac：${session.id.label}`, prompt: kind === "password" ? "输入此服务器 SSH 密码" : `输入私钥口令：${prompt}`, password: true, ignoreFocusOut: true });
      if (!session.active || this.disposed || value === undefined) return undefined;
      if (/\r|\n|\0/.test(value) || Buffer.byteLength(value) > 4096) throw Error("凭据格式无效。");
      this.memory.set(key, value);
      if (session.config.remember) await this.context.secrets.store("simple-sftp-mac.auth." + key, value);
      return value;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
  async dispose() {
    this.disposed = true; for (const session of this.sessions.values()) session.active = false;
    this.sessions.clear(); this.memory.clear(); this.pending.clear();
    if (this.server) { this.server.closeAllConnections(); await new Promise(resolve => this.server.close(resolve)); }
  }
}
module.exports = { MacAuthentication, identity, profile, sshAuthArgs };
