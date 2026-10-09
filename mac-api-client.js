"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateDiscovery = validateDiscovery;
exports.readLocalDiscovery = readLocalDiscovery;
exports.requestLocalJson = requestLocalJson;
exports.callLocalRpc = callLocalRpc;
const fs = __importStar(require("node:fs"));
const http = __importStar(require("node:http"));
const MAX_DISCOVERY_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
function validateDiscovery(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid local API discovery");
    const discovery = value;
    if (typeof discovery.baseUrl !== "string" || typeof discovery.token !== "string"
        || !/^[\x21-\x7e]{1,4096}$/.test(discovery.token))
        throw new Error("Invalid local API discovery");
    let url;
    try {
        url = new URL(discovery.baseUrl);
    }
    catch {
        throw new Error("Invalid local API discovery URL");
    }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || url.username || url.password || url.pathname !== "/" || url.search || url.hash
        || !url.port || Number(url.port) < 1 || Number(url.port) > 65535
        || discovery.status === "stopped")
        throw new Error("Local API discovery must describe a running loopback listener with an explicit port");
    return discovery;
}
function readLocalDiscovery(file) {
    const fd = fs.openSync(file, "r");
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_DISCOVERY_BYTES)
            throw new Error("Invalid local API discovery file");
        const bytes = Buffer.alloc(MAX_DISCOVERY_BYTES + 1);
        const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (size > MAX_DISCOVERY_BYTES)
            throw new Error("Local API discovery file exceeds size limit");
        return validateDiscovery(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))));
    }
    finally {
        fs.closeSync(fd);
    }
}
function requestLocalJson(discovery, route, body, maxBytes = 16 * 1024 * 1024, timeoutMs = 15000) {
    validateDiscovery(discovery);
    if (!["/api/v1/capabilities", "/api/v1/rpc", "/api/v1/health"].includes(route))
        throw new Error("Invalid local API route");
    const url = new URL(route, String(discovery.baseUrl));
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: url.hostname === "[::1]" ? "::1" : url.hostname === "localhost" ? "127.0.0.1" : url.hostname, port: url.port, path: url.pathname,
            method: body ? "POST" : "GET",
            headers: { Authorization: `Bearer ${discovery.token}`, ...(body ? { "Content-Type": "application/json", "Content-Length": body.length } : {}) },
        }, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`Local API HTTP ${res.statusCode}`));
                res.destroy();
                req.destroy();
                return;
            }
            const chunks = [];
            let size = 0;
            res.on("data", (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    reject(new Error("Local API response exceeds size limit"));
                    res.destroy();
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            res.on("error", reject);
            res.on("aborted", () => reject(new Error("Local API response was interrupted")));
            res.on("end", () => {
                try {
                    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
                    if (!value || typeof value !== "object" || Array.isArray(value))
                        throw new Error("expected JSON object");
                    resolve(value);
                }
                catch {
                    reject(new Error("Invalid local API JSON response"));
                }
            });
        });
        const timer = setTimeout(() => { reject(new Error("Local API request timed out")); req.destroy(); }, timeoutMs);
        req.on("close", () => clearTimeout(timer));
        req.on("error", reject);
        req.end(body);
    });
}
async function callLocalRpc(readDiscovery, method, params) {
    if (typeof method !== "string" || !method || !params || typeof params !== "object" || Array.isArray(params))
        throw new Error("API method and object params required");
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), "utf8");
    if (body.length > MAX_REQUEST_BYTES)
        throw new Error("Local API request exceeds size limit");
    const discovery = validateDiscovery(readDiscovery());
    const contract = await requestLocalJson(discovery, "/api/v1/capabilities", undefined, 1024 * 1024);
    if (contract.schemaVersion !== 1 || contract.rpc !== "json-rpc-2.0" || !Array.isArray(contract.methods)
        || !contract.methods.every((item) => typeof item === "string")
        || (discovery.name && contract.name !== discovery.name) || (discovery.version && contract.version !== discovery.version))
        throw new Error("Invalid or mismatched live API capabilities");
    if (!contract.methods.includes(method))
        throw new Error(`Method unavailable in live API: ${method}`);
    const fresh = validateDiscovery(readDiscovery());
    for (const key of ["baseUrl", "token", "name", "version", "pid", "startedAt"]) {
        if (fresh[key] !== discovery[key])
            throw new Error("Local API discovery changed during preflight; check the current listener before retrying");
    }
    const result = await requestLocalJson(fresh, "/api/v1/rpc", body);
    if (result.jsonrpc !== "2.0" || result.id !== 1 || !(Object.hasOwn(result, "result") !== Object.hasOwn(result, "error"))
        || (Object.hasOwn(result, "error") && (!result.error || typeof result.error !== "object" || Array.isArray(result.error))))
        throw new Error("Invalid local API JSON-RPC response");
    return result;
}
