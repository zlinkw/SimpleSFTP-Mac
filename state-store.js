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
exports.atomicWriteText = atomicWriteText;
exports.readJsonState = readJsonState;
exports.writeJsonState = writeJsonState;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const fsNode = __importStar(require("fs"));
const atomicWriteQueues = new Map();
async function atomicWriteText(file, text) {
    const resolved = path.resolve(file);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const previous = atomicWriteQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => writeFixedSlot(resolved, text));
    atomicWriteQueues.set(key, current);
    try {
        await current;
    }
    finally {
        if (atomicWriteQueues.get(key) === current)
            atomicWriteQueues.delete(key);
    }
}
async function writeFixedSlot(file, text) {
    const parent = path.dirname(file);
    await fs.mkdir(parent, { recursive: true });
    const staging = `${file}.writing`;
    let existing;
    try {
        existing = await fs.lstat(staging);
        if (!existing.isFile() || existing.isSymbolicLink())
            throw new Error(`状态暂存路径不是普通文件：${staging}`);
    }
    catch (error) {
        if (error?.code !== "ENOENT")
            throw error;
    }
    const flags = fsNode.constants.O_WRONLY | (fsNode.constants.O_NOFOLLOW || 0);
    const handle = await fs.open(staging, existing ? flags : flags | fsNode.constants.O_CREAT | fsNode.constants.O_EXCL, 0o600);
    try {
        const opened = await handle.stat();
        const current = await fs.lstat(staging);
        const changedIdentity = Boolean(current.dev && current.ino && opened.dev && opened.ino &&
            (current.dev !== opened.dev || current.ino !== opened.ino));
        const knownIdentityChanged = Boolean(existing?.dev && existing.ino && opened.dev && opened.ino &&
            (existing.dev !== opened.dev || existing.ino !== opened.ino));
        if (!opened.isFile() || opened.nlink > 1 || current.isSymbolicLink() || !current.isFile() || current.nlink > 1 || changedIdentity || knownIdentityChanged)
            throw new Error(`状态暂存文件身份发生变化：${staging}`);
        await handle.truncate(0);
        const bytes = Buffer.from(text, "utf8");
        let offset = 0;
        while (offset < bytes.length) {
            const result = await handle.write(bytes, offset, bytes.length - offset, offset);
            if (!result.bytesWritten)
                throw new Error(`状态暂存写入未前进：${staging}`);
            offset += result.bytesWritten;
        }
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    for (let attempt = 0;; attempt += 1) {
        try {
            await fs.rename(staging, file);
            break;
        }
        catch (error) {
            if (!error || !["EACCES", "EPERM", "EBUSY"].includes(error.code) || attempt >= 5)
                throw error;
            await new Promise(resolve => setTimeout(resolve, Math.min(250, 20 * (2 ** attempt))));
        }
    }
    if (process.platform !== "win32") {
        let directory;
        try {
            directory = await fs.open(parent, "r");
            await directory.sync();
        }
        catch {
            // Directory fsync is not supported by every filesystem.
        }
        finally {
            await directory?.close().catch(() => undefined);
        }
    }
}
async function readJsonState(file, validate, migrate, lastKnownGood) {
    try {
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        if (validate(parsed))
            return { ok: true, value: parsed };
        const migrated = migrate(parsed);
        if (validate(migrated))
            return { ok: true, value: migrated, migrated: true };
        return { ok: false, error: "schema validation failed", lastKnownGood };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), lastKnownGood };
    }
}
async function writeJsonState(file, value, schemaVersion, validate) {
    const next = { ...value, schemaVersion };
    if (!validate(next))
        throw new Error(`state validation failed: ${file}`);
    await atomicWriteText(file, JSON.stringify(next, null, 2));
}
