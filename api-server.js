"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { atomicWriteText } = require("./state-store");
const { HostOperationLeaseManager } = require("./host-operation-lease");
const { AsyncLocalStorage } = require("node:async_hooks");
const { READ_ONLY_SETTLEMENT_METHODS } = require("./transfer-settlement");
const apiRequestContext = new AsyncLocalStorage();

const LOOPBACK_REMOTE_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);
const DEFAULT_MAX_EVENTS = 0;
const DEFAULT_EVENT_BUFFER_LIMIT = 128;
const DEFAULT_SSE_TIMEOUT_MS = 0;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const BODY_IDLE_MS = 5000;
const MAX_PORT = 65535;
function sseGapFrame(reason) {
  return `event: gap\ndata: ${JSON.stringify({ code: "journal_gap", snapshotRequired: true, reason })}\n\n`;
}

function apiError(code, message, data) {
  const error = new Error(message);
  error.apiCode = code;
  if (data !== undefined) error.apiData = data;
  return error;
}

function confirmationRequired(preview) {
  return apiError(2001, "CONFIRM_REQUIRED", preview);
}

function parseRemoteAddress(value) {
  const raw = String(value || "").toLowerCase();
  if (raw.startsWith("::ffff:") && raw.length > 7) return raw.slice(7);
  return raw;
}

class LocalApiServer {
  constructor(options = {}) {
    this.name = String(options.name || "Local API");
    this.version = String(options.version || "");
    this.preferredPort = positivePort(options.preferredPort, 19766);
    this.host = "127.0.0.1";
    this.token =
      options.token ||
      crypto.randomBytes(32).toString("base64url").replace(/[^a-zA-Z0-9]/g, "");
    this.methods = options.methods && typeof options.methods === "object" ? options.methods : {};
    this.methodOptions = options.methodOptions || {};
    this.discoveryPath = options.discoveryPath || "";
    this.sseTimeoutMs = positiveNumber(options.sseTimeoutMs, DEFAULT_SSE_TIMEOUT_MS);
    this.maxEvents = Math.max(
      0,
      Math.min(1024, positiveNumber(options.maxEvents, DEFAULT_MAX_EVENTS))
    );
    this.events = [];
    this.listeners = new Set();
    this.eventSequence = 0;
    this.server = undefined;
    this.port = 0;
    this.startedAt = "";
    this.disposed = false;
    this.sseClosers = new Set();
    this.eventBufferBytes = 0;
    this.maxSseClients = Math.max(1, Math.min(8, Number(options.maxSseClients) || 8));
    this.maxEventBufferBytes = Math.max(256, Math.min(1024 * 1024, Number(options.maxEventBufferBytes) || 1024 * 1024));
    this.maxSsePendingBytes = Math.max(256, Math.min(1024 * 1024, Number(options.maxSsePendingBytes) || 1024 * 1024));
    this.activeRpc = 0;
    this.discoveryLease = options.discoveryLease || new HostOperationLeaseManager();
  }

  async start() {
    if (this.disposed) throw new Error("LocalApiServer is disposed");
    await this.listen();
    this.startedAt = new Date().toISOString();
    try { await this.writeDiscovery(); }
    catch (error) {
      const server = this.server; this.server = undefined; this.port = 0;
      server?.closeAllConnections?.();
      if (server) await new Promise(resolve => server.close(resolve));
      throw error;
    }
    return this.discovery();
  }

  async listen() {
    const startPort = Math.max(1024, Math.min(this.preferredPort, MAX_PORT));
    for (let port = startPort; port <= MAX_PORT; port += 1) {
      try {
        await this.listenOnce(port);
        this.port = port;
        return;
      } catch (error) {
        if (!isPortConflict(error) || port === MAX_PORT) throw error;
      }
    }
  }

  listenOnce(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handleRequest(request, response).catch((error) => {
          if (!response.headersSent) {
            sendJson(response, 500, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          response.end();
        });
      });
      server.once("error", reject);
      server.listen(port, this.host, () => {
        server.removeListener("error", reject);
        this.server = server;
        resolve();
      });
    });
  }

  async handleRequest(request, response) {
    if (!loopbackRequest(request)) {
      sendJson(response, 403, { ok: false, error: "FORBIDDEN_REMOTE" });
      return;
    }
    const url = new URL(request.url || "/", `http://${this.host}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (!this.authorized(request)) {
      sendJson(response, 401, { ok: false, error: "UNAUTHORIZED" });
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/health") {
      sendJson(response, 200, this.health());
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/capabilities") {
      sendJson(response, 200, this.capabilities());
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/openapi.json") {
      sendJson(response, 200, this.openapi());
      return;
    }
    if (request.method === "GET" && pathname === "/api/v1/events") {
      this.streamEvents(request, response, url);
      return;
    }
    if (request.method === "POST" && pathname === "/api/v1/rpc") {
      await this.handleRpc(request, response);
      return;
    }
    sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
  }

  async handleRpc(request, response) {
    if (this.activeRpc >= 8) { sendJson(response, 503, rpcError(undefined, 429, "API_CAPACITY_EXCEEDED")); return; }
    this.activeRpc += 1;
    try { await this.handleRpcCore(request, response); }
    finally { this.activeRpc -= 1; }
  }

  async handleRpcCore(request, response) {
    const payload = await readJsonBody(request);
    if (
      !payload ||
      payload.jsonrpc !== "2.0" ||
      typeof payload.method !== "string" ||
      !payload.method
    ) {
      sendJson(response, 400, rpcError(undefined, -32600, "Invalid Request"));
      return;
    }
    const id = payload.id;
    try {
      const handler = this.methods[payload.method];
      if (typeof handler !== "function") {
        sendJson(response, 200, rpcError(id, -32601, "Method not found"));
        return;
      }
      const controller = new AbortController();
      const readOnly = /\.(list|get|status|schema)$/.test(payload.method) || /^(project\.(inventory|fileStats|tree)|sync\.(?:projectInventory|projectFileStats|projectTree|planLogPaths|listPlanLogs)|transfers\.reconcile)$/.test(payload.method);
      const cancelRead = () => { if (readOnly) controller.abort(new Error("API_READ_CANCELLED")); };
      request.on("aborted", cancelRead); response.on("close", cancelRead);
      if (request.aborted || response.destroyed) cancelRead();
      let result;
      try {
        result = await apiRequestContext.run({ readOnly, signal: controller.signal }, () => {
          controller.signal.throwIfAborted();
          return handler(normalParams(payload.params), this, { signal: controller.signal });
        });
      } finally { request.removeListener("aborted", cancelRead); response.removeListener("close", cancelRead); }
      if (id === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      sendJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: result === undefined ? null : result,
      });
    } catch (error) {
      if (id === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      const code = Number(error && error.apiCode) || -32000;
      const message = error instanceof Error ? error.message : String(error);
      const data = error && error.apiData !== undefined ? error.apiData : { method: payload.method };
      sendJson(response, 200, rpcError(id, code, message, data));
    }
  }

  authorized(request) {
    const expected = Buffer.from(String(this.token || ""));
    const header = String(request.headers.authorization || "");
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || expected.length !== match[1].length) return false;
    const actual = Buffer.from(match[1]);
    const a = crypto.timingSafeEqual(expected, actual);
    const b = expected.length === actual.length;
    return a && b;
  }


    publish(event) {
        const data = event && event.data !== undefined ? event.data : null;
        const serializedData = JSON.stringify(data);
        const type = String((event && event.type) || "event").replace(/[\r\n]/g, "").slice(0, 128) || "event";
        const item = {
            seq: this.eventSequence + 1,
            type,
            data,
            publishedAt: new Date().toISOString(),
            frame: `id: ${this.eventSequence + 1}\nevent: ${type}\ndata: ${serializedData}\n\n`,
            bytes: 0,
        };
        item.bytes = Buffer.byteLength(item.frame, "utf8");
        this.eventSequence = item.seq;
        this.events.push(item);
        this.eventBufferBytes += item.bytes;
        while (this.events.length > DEFAULT_EVENT_BUFFER_LIMIT || this.eventBufferBytes > this.maxEventBufferBytes) {
            const removed = this.events.shift();
            if (!removed)
                break;
            this.eventBufferBytes = Math.max(0, this.eventBufferBytes - removed.bytes);
        }
        for (const listener of [...this.listeners])
            listener(item);
        return item;
    }
    streamEvents(request, response, url) {
        if (this.listeners.size >= this.maxSseClients) {
            response.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                "X-Accel-Buffering": "no",
            });
            response.end(sseGapFrame("subscriber_limit"));
            return;
        }
        const since = positiveNumber(Number(url.searchParams.get("since") || 0), 0);
        response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        });
        let sent = 0;
        let closed = false;
        let backpressured = false;
        let finishWhenDrained = false;
        let queuedBytes = 0;
        const pending = [];
        let timer;
        let closeFromServer = () => undefined;
        const gapFrame = sseGapFrame("slow_consumer");
        const gapBytes = Buffer.byteLength(gapFrame, "utf8");
        const close = (endResponse = true) => {
            if (closed)
                return;
            closed = true;
            if (timer)
                clearTimeout(timer);
            this.listeners.delete(listener);
            this.sseClosers.delete(closeFromServer);
            response.removeListener("drain", onDrain);
            request.removeListener("aborted", onRequestAborted);
            response.removeListener("close", onResponseClosed);
            response.removeListener("error", onResponseError);
            if (endResponse && !response.writableEnded && !response.destroyed) {
                try {
                    response.end();
                }
                catch { /* peer may disappear between the state check and write */ }
            }
        };
        const sendGap = () => {
            if (closed)
                return;
            pending.length = 0;
            queuedBytes = 0;
            closed = true;
            if (timer)
                clearTimeout(timer);
            this.listeners.delete(listener);
            this.sseClosers.delete(closeFromServer);
            response.removeListener("drain", onDrain);
            request.removeListener("aborted", onRequestAborted);
            response.removeListener("close", onResponseClosed);
            response.removeListener("error", onResponseError);
            if (!response.writableEnded && !response.destroyed) {
                try {
                    response.end(gapFrame);
                }
                catch { /* the gap is best effort after peer failure */ }
            }
        };
        const pendingBytes = () => Number(response.writableLength || 0) + queuedBytes;
        const writeFrame = (frame) => {
            try {
                return response.write(frame);
            }
            catch {
                close(false);
                return false;
            }
        };
        const sendFrame = (frame, bytes) => {
            if (closed || this.maxEvents > 0 && sent >= this.maxEvents)
                return;
            if (pendingBytes() + bytes + gapBytes > this.maxSsePendingBytes) {
                sendGap();
                return;
            }
            sent += 1;
            if (backpressured || pending.length) {
                pending.push({ frame, bytes });
                queuedBytes += bytes;
            }
            else if (!writeFrame(frame)) {
                backpressured = true;
            }
            if (this.maxEvents > 0 && sent >= this.maxEvents) {
                finishWhenDrained = true;
                if (!backpressured && !pending.length)
                    close();
            }
        };
        const sendEvent = (item) => sendFrame(item.frame, item.bytes);
        const onDrain = () => {
            if (closed)
                return;
            backpressured = false;
            while (!backpressured && pending.length && !closed) {
                const item = pending.shift();
                if (!item)
                    break;
                queuedBytes = Math.max(0, queuedBytes - item.bytes);
                if (!writeFrame(item.frame))
                    backpressured = true;
            }
            if (!closed && finishWhenDrained && !backpressured && !pending.length)
                close();
        };
        const onRequestAborted = () => close(false);
        const onResponseClosed = () => close(false);
        const onResponseError = () => close(false);
        closeFromServer = () => close();
        const listener = (item) => sendEvent(item);
        response.on("drain", onDrain);
        request.on("aborted", onRequestAborted);
        response.on("close", onResponseClosed);
        response.on("error", onResponseError);
        this.listeners.add(listener);
        this.sseClosers.add(closeFromServer);
        const firstAvailableSeq = this.events[0]?.seq;
        const historyGap = firstAvailableSeq !== undefined
            ? since < firstAvailableSeq - 1
            : since < this.eventSequence;
        if (historyGap) {
            sendGap();
            return;
        }
        for (const item of this.events) {
            if (item.seq > since)
                sendEvent(item);
            if (closed)
                return;
        }
        if (this.maxEvents > 0 && sent >= this.maxEvents && !backpressured && !pending.length) {
            close();
            return;
        }
        if (this.sseTimeoutMs > 0) timer = setTimeout(close, this.sseTimeoutMs);
    }

  health() {
    return {
      ok: true,
      schemaVersion: 1,
      name: this.name,
      version: this.version,
      instanceId: this.instanceId(),
      pid: process.pid,
      port: this.port,
      startedAt: this.startedAt,
      status: this.disposed ? "stopped" : "running",
    };
  }

  capabilities() {
    return {
      schemaVersion: 1,
      name: this.name,
      version: this.version,
      instanceId: this.instanceId(),
      features: { transferSettlementReceipts: true,
        ...(typeof this.methods["transfers.reconcile"] === "function" ? { transferSettlementReconciliation: true,
          transferReconciliationMethods: ["sync.serverToServerFpsync", ...READ_ONLY_SETTLEMENT_METHODS] } : {}),
        ...(this.methodOptions["sync.projectInventory"]?.scopeTransport === "stdin" ? { projectInventoryStdinScopes: true } : {}) },
      transport: ["http", "cli"],
      rpc: "json-rpc-2.0",
      methods: Object.keys(this.methods).sort(),
      methodOptions: this.methodOptions,
      confirmation: {
        required: true,
        categories: ["confirm", "pathConfirmed"],
      },
    };
  }

  instanceId() {
    return this.startedAt ? `${process.pid}:${this.startedAt}` : "";
  }

  openapi() {
    const methods = Object.keys(this.methods).sort();
    return {
      openapi: "3.0.0",
      info: {
        title: `${this.name} Local API`,
        version: this.version,
      },
      servers: [{ url: `http://127.0.0.1:${this.port}` }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
      paths: {
        "/api/v1/rpc": {
          post: {
            security: [{ bearerAuth: [] }],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["jsonrpc", "method"],
                    properties: {
                      jsonrpc: { const: "2.0" },
                      id: { type: ["string", "number", "null"] },
                      method: { type: "string", enum: methods },
                      params: { type: "object" },
                    },
                  },
                },
              },
            },
            responses: { 200: { description: "JSON-RPC response" } },
          },
        },
        "/api/v1/health": { get: { responses: { 200: { description: "Health" } } } },
        "/api/v1/capabilities": { get: { responses: { 200: { description: "Capabilities" } } } },
        "/api/v1/events": { get: { responses: { 200: { description: "Persistent SSE stream" } } } },
      },
    };
  }

  discovery() {
    return {
      schemaVersion: 1,
      name: this.name,
      version: this.version,
      baseUrl: `http://${this.host}:${this.port}`,
      host: this.host,
      port: this.port,
      token: this.token,
      pid: process.pid,
      startedAt: this.startedAt,
    };
  }

  async writeDiscovery() {
    if (!this.discoveryPath) return;
    await this.withDiscoveryLease(() => atomicWriteText(this.discoveryPath, `${JSON.stringify(this.discovery(), null, 2)}\n`));
  }

  withDiscoveryLease(work) {
    const project = path.dirname(path.resolve(this.discoveryPath));
    return this.discoveryLease.run({ pluginId: "simple-local.simple-sftp-mac", workspaceUri: "file://" + project, hostProjectPath: project, actionType: "api-discovery", waitForConflict: true,
      resources: [{ server: "local", project, target: path.resolve(this.discoveryPath) }] }, work);
  }

  async removeDiscovery() {
    if (!this.discoveryPath) return;
    return this.withDiscoveryLease(async () => {
      try {
      const info = fs.lstatSync(this.discoveryPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) throw new Error("API discovery identity is unsafe");
      const current = JSON.parse(fs.readFileSync(this.discoveryPath, "utf8"));
      // Logical invalidation preserves a fixed metadata slot and never removes another instance's file.
      if (Number(current.pid) === process.pid && current.startedAt === this.startedAt)
        return atomicWriteText(this.discoveryPath, JSON.stringify({ ...this.discovery(), status: "stopped", token: "", stoppedAt: new Date().toISOString() }));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    });
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const closer of [...this.sseClosers]) closer();
    this.sseClosers.clear();
    this.listeners.clear();
    let failure;
    try { await this.removeDiscovery(); } catch (error) { failure = error; }
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((resolve) => this.server.close(() => resolve()));
    }
    if (failure) throw failure;
  }
}

function normalParams(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function loopbackRequest(request) {
  const address = parseRemoteAddress(request.socket.remoteAddress);
  return LOOPBACK_REMOTE_ADDRESSES.has(address);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => { finish(apiError(408, "REQUEST_BODY_IDLE")); request.destroy(); }, BODY_IDLE_MS);
    timer.unref?.();
    function finish(error, value) {
      if (settled) return; settled = true;
      clearTimeout(timer); chunks.length = 0;
      request.removeListener("data", onData); request.removeListener("end", onEnd);
      request.removeListener("error", onError); request.removeListener("aborted", onAbort);
      error ? reject(error) : resolve(value);
    }
    function onError(error) { finish(error); }
    function onAbort() { finish(apiError(499, "REQUEST_ABORTED")); }
    function onData(chunk) {
      timer.refresh();
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(apiError(413, "PAYLOAD_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      try {
        finish(undefined, chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        finish(apiError(-32700, "Parse error", { detail: error instanceof Error ? error.message : String(error) }));
      }
    }
    request.on("data", onData); request.once("end", onEnd);
    request.once("error", onError); request.once("aborted", onAbort);
  });
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  let body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
    body = JSON.stringify(rpcError(value?.id, 413, "RESPONSE_TOO_LARGE")) + "\n"; status = 413;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

function isPortConflict(error) {
  return error && ["EADDRINUSE", "EACCES"].includes(error.code);
}

function positivePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = {
  LocalApiServer,
  apiError,
  confirmationRequired,
  loopbackRequest,
  parseRemoteAddress,
  currentApiRequestContext: () => apiRequestContext.getStore(),
};
