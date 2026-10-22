"use strict";
// Narrow authentication bridge for the paired SimpleExperiment Mac one-click tunnel launcher.
// It returns only ssh arguments plus the existing askpass environment for one validated
// SSH identity; it never exposes credentials, never accepts remote commands and never
// starts any process. The caller owns the ssh child lifecycle and must release the nonce.
const { identity } = require("./mac-auth");

function createTunnelAuthBridge(getAuthentication, options = {}) {
  const ttlMs = Number.isInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 10 * 60 * 1000;
  const maxSessions = Number.isInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : 64;
  const sessions = new Map();
  let disposed = false;
  const release = nonce => {
    const key = typeof nonce === "string" ? nonce : "";
    const entry = sessions.get(key);
    if (!entry) return false;
    sessions.delete(key);
    clearTimeout(entry.timer);
    try { entry.release(); } catch { /* the askpass session release is best-effort */ }
    return true;
  };
  return {
    async acquire(target) {
      if (disposed) throw new Error("SimpleSFTP Mac 隧道认证桥已停用。");
      const authentication = getAuthentication();
      if (!authentication) throw new Error("SimpleSFTP Mac 认证服务尚未就绪。");
      const id = identity(target);
      if (sessions.size >= maxSessions) throw new Error("隧道认证会话已达到上限，请先释放现有隧道认证。");
      const invocation = authentication.invocation({ host: id.host, username: id.user, port: id.port });
      const nonce = invocation.env && invocation.env.SIMPLE_SFTP_AUTH_NONCE;
      if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce)) {
        try { invocation.release(); } catch { /* the invalid session is dropped below anyway */ }
        throw new Error("隧道认证会话身份无效。");
      }
      const expiresAt = Date.now() + ttlMs;
      const timer = setTimeout(() => release(nonce), ttlMs);
      if (typeof timer.unref === "function") timer.unref();
      sessions.set(nonce, { release: invocation.release, timer });
      return { ok: true, args: invocation.args, env: invocation.env, nonce, expiresAt };
    },
    release,
    size() { return sessions.size; },
    async dispose() { disposed = true; for (const nonce of [...sessions.keys()]) release(nonce); },
  };
}

module.exports = { createTunnelAuthBridge };
