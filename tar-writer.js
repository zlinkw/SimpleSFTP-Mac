"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Buffer } = require("node:buffer");

const BLOCK_SIZE = 512;

async function writeTarEntriesToStream({ localPath, files, stream, onFileBytes }) {
  if (!Array.isArray(files)) throw new TypeError("files must be an array");
  if (!stream || typeof stream.write !== "function") throw new TypeError("stream is required");

  const seenDirectories = new Set(["."]);
  for (const file of files) {
    const rawPath = String(file.relativePath || "").replace(/\\/g, "/");
    const relativePath = toTarPath(rawPath);
    if (!relativePath || /[:\0\r\n]/.test(rawPath) || rawPath.startsWith("/") || rawPath.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`上传清单包含不安全路径：${file.relativePath}`);
    }
    for (const directory of ancestorPaths(relativePath)) {
      if (seenDirectories.has(directory)) continue;
      seenDirectories.add(directory);
      await writeLocalDirectoryEntry(stream, localPath, directory);
    }
    if (Buffer.isBuffer(file.content)) {
      if (file.content.length > 2 * 1024 * 1024) throw new Error("上传生成数据超过 2MiB 上限");
      await write(stream, tarHeader({ path: relativePath, size: file.content.length }));
      await write(stream, file.content);
      if (onFileBytes) onFileBytes(file.content.length);
      await write(stream, padBlock(file.content.length));
    } else await writeLocalFileEntry(stream, localPath, relativePath, file.fullPath || path.join(localPath, relativePath), onFileBytes);
  }
  await write(stream, Buffer.alloc(BLOCK_SIZE * 2));
}

async function writeLocalDirectoryEntry(stream, localPath, relativePath) {
  const header = tarHeader({
    path: relativePath,
    typeflag: "5",
    mode: 0o755,
  });
  await write(stream, header);
}

async function writeLocalFileEntry(stream, localPath, relativePath, fullPath, onFileBytes) {
  const stat = await fs.promises.lstat(fullPath);
  if (stat.isSymbolicLink()) throw new Error(`上传清单包含符号链接：${relativePath}`);
  if (!stat.isFile()) throw new Error(`上传清单包含非普通文件：${relativePath}`);
  const header = tarHeader({
    path: relativePath,
    typeflag: "0",
    mode: stat.mode & 0o7777,
    size: stat.size,
    mtime: stat.mtimeMs / 1000,
  });
  await write(stream, header);

  const handle = await fs.promises.open(fullPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const identity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
  let input;
  let bytes = 0;
  try {
    if (identity(await handle.stat()) !== identity(stat)) throw new Error("上传源身份发生变化");
    input = handle.createReadStream({ highWaterMark: 128 * 1024, autoClose: false, end: Math.max(0, stat.size - 1) });
    if (stat.size > 0) for await (const chunk of input) {
      bytes += chunk.length;
      await write(stream, chunk);
      if (onFileBytes) onFileBytes(chunk.length);
    }
    if (bytes !== stat.size || identity(await handle.stat()) !== identity(stat) || identity(await fs.promises.lstat(fullPath)) !== identity(stat)) throw new Error("上传源在读取期间发生变化");
  } finally {
    input?.destroy();
    await handle.close();
  }
  const padding = (BLOCK_SIZE - (stat.size % BLOCK_SIZE)) % BLOCK_SIZE;
  if (padding) await write(stream, Buffer.alloc(padding));
}

function tarHeader({ path: entryPath, typeflag = "0", mode = 0o644, uid = 0, gid = 0, size = 0, mtime = Date.now() / 1000 }) {
  const normalized = toTarPath(entryPath);
  const paxPath = fitsUstar(normalized) ? undefined : normalized;
  const headerName = paxPath ? `simple-sftp/pax/data` : splitUstarName(normalized).name;
  const headerPrefix = paxPath ? "" : splitUstarName(normalized).prefix;

  if (paxPath !== undefined) {
    const records = paxRecords({ path: paxPath });
    const paxHeader = ustarHeader({
      name: `simple-sftp/pax/header`,
      typeflag: "x",
      size: records.length,
    });
    return Buffer.concat([
      paxHeader,
      records,
      padBlock(records.length),
      ustarHeader({
        name: headerName,
        prefix: headerPrefix,
        typeflag,
        mode,
        uid,
        gid,
        size,
        mtime,
      }),
    ]);
  }

  return ustarHeader({
    name: headerName,
    prefix: headerPrefix,
    typeflag,
    mode,
    uid,
    gid,
    size,
    mtime,
  });
}

function ustarHeader({ name, prefix = "", typeflag, mode = 0o644, uid = 0, gid = 0, size = 0, mtime = Math.floor(Date.now() / 1000) }) {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeAscii(header, name, 0, 100);
  writeOctal(header, mode, 100, 7, false);
  writeOctal(header, uid, 108, 7, true);
  writeOctal(header, gid, 116, 7, true);
  writeOctal(header, size, 124, 12, true);
  writeOctal(header, Math.max(0, Math.floor(mtime)), 136, 12, true);
  header.fill(0x20, 148, 156);
  header.write(String(typeflag), 156, "ascii");
  writeAscii(header, "", 157, 100);
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  writeAscii(header, "", 265, 32);
  writeAscii(header, "", 297, 32);
  writeOctal(header, 0, 329, 7, true);
  writeOctal(header, 0, 337, 7, true);
  writeAscii(header, prefix, 345, 155);
  const checksum = header.reduce((total, value) => total + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return header;
}

function paxRecords(records) {
  const parts = Object.entries(records).map(([key, value]) => {
    const valueText = String(value);
    let length = Buffer.byteLength(` ${key}=${valueText}\n`, "utf8");
    let text = `${length} ${key}=${valueText}\n`;
    while (Buffer.byteLength(text, "utf8") !== length) {
      length = Buffer.byteLength(text, "utf8");
      text = `${length} ${key}=${valueText}\n`;
    }
    return text;
  });
  return Buffer.from(parts.join(""), "utf8");
}

function fitsUstar(value) {
  if (!/^[\x20-\x7e]+$/.test(value)) return false;
  const split = splitUstarName(value);
  return Boolean(split && split.name.length <= 100 && split.prefix.length <= 155);
}

function splitUstarName(value) {
  const normalized = toTarPath(value);
  const leaf = normalized.split("/").pop();
  if (!leaf || leaf.length > 100) return null;
  const prefix = normalized.length > leaf.length ? normalized.slice(0, normalized.length - leaf.length - 1) : "";
  if (prefix.length > 155) return null;
  return { name: leaf, prefix };
}

function writeAscii(buffer, value, offset, length) {
  const bytes = Buffer.from(String(value), "ascii");
  if (bytes.length > length) throw new Error(`tar 字段超长：${value}`);
  bytes.copy(buffer, offset);
}

function writeOctal(header, value, offset, length, nullTerminated) {
  const digits = nullTerminated ? length - 1 : length;
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(digits, "0");
  if (text.length > digits) throw new Error(`tar 数值超长：${value}`);
  writeAscii(header, text, offset, digits);
  if (nullTerminated) header[offset + digits] = 0;
}

function padBlock(size) {
  const padding = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
  return Buffer.alloc(padding);
}

async function write(stream, chunk) {
  if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
  if (stream.destroyed) throw new Error("tar 输出流已关闭");
  if (!stream.write(chunk)) {
    await new Promise((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => onError(new Error("tar 输出流已关闭"));
      const cleanup = () => {
        stream.off("drain", onDrain);
        stream.off("error", onError);
        stream.off("close", onClose);
      };
      stream.once("drain", onDrain);
      stream.once("error", onError);
      stream.once("close", onClose);
    });
  }
}

function toTarPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/^(\.\.\/)+/, "").replace(/\/+$/, "");
}

function ancestorPaths(relativePath) {
  const parts = toTarPath(relativePath).split("/").slice(0, -1);
  const out = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    out.push(current);
  }
  return out;
}

module.exports = {
  ancestorPaths,
  fitsUstar,
  paxRecords,
  splitUstarName,
  tarHeader,
  toTarPath,
  ustarHeader,
  writeTarEntriesToStream,
};
