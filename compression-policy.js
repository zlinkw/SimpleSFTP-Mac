"use strict";
const crypto = require("node:crypto");

const MAX_SAMPLE_BYTES = 256 * 1024;
const MAX_SAMPLE_FILES = 8;
const SAMPLE_TIMEOUT_MS = 5000;
const DEFAULT_LINK_BYTES_PER_SECOND = 8 * 1024 * 1024;

function chooseSampleFiles(paths, sizes = {}) {
  const sorted = [...new Set(paths)].sort((a, b) => Number(sizes[b] || 0) - Number(sizes[a] || 0) || a.localeCompare(b));
  if (sorted.length <= MAX_SAMPLE_FILES) return sorted;
  // Largest entries dominate bytes; quantiles also cover smaller files across the batch.
  return [...new Set([sorted[0], sorted[1], ...Array.from({ length: 6 }, (_, i) => sorted[Math.floor((i + 1) * (sorted.length - 1) / 6)])])];
}

function chooseCompression(sample, allowed, linkBytesPerSecond = DEFAULT_LINK_BYTES_PER_SECOND, measuredLink = false) {
  const bytes = Number(sample?.sampleBytes);
  const sampleMs = Number(sample?.sampleMs);
  const rate = Number(linkBytesPerSecond);
  if (!Number.isFinite(bytes) || bytes < 512 || bytes > MAX_SAMPLE_BYTES || !Number.isFinite(sampleMs) || sampleMs < 0 || sampleMs > SAMPLE_TIMEOUT_MS || !Number.isFinite(rate) || rate <= 0)
    return { compression: "gzip", reason: "sample-unavailable", sampleBytes: 0, measuredLink: false };
  const rawMs = bytes * 1000 / rate;
  let chosen = { compression: "none", costMs: rawMs };
  const candidates = [];
  for (const compression of allowed) {
    const item = sample[compression];
    const compressedBytes = Number(item?.bytes), cpuMs = Number(item?.cpuMs), wallMs = Number(item?.wallMs);
    if (!Number.isFinite(compressedBytes) || compressedBytes < 0 || compressedBytes > bytes * 2 || !Number.isFinite(cpuMs) || cpuMs < 0 || cpuMs > SAMPLE_TIMEOUT_MS || !Number.isFinite(wallMs) || wallMs < 0 || wallMs > SAMPLE_TIMEOUT_MS) continue;
    const ratio = compressedBytes / bytes;
    // Conservative serial cost (including decode allowance), not a claimed speed measurement.
    const costMs = compressedBytes * 1000 / rate + Math.max(cpuMs, wallMs) * 1.25;
    candidates.push({ compression, ratio, cpuMs, wallMs, costMs });
    if (ratio <= 0.95 && costMs < chosen.costMs * 0.95) chosen = { compression, costMs };
  }
  if (!candidates.length) return { compression: "gzip", reason: "sample-unavailable", sampleBytes: 0, measuredLink: false };
  return { compression: chosen.compression, reason: chosen.compression === "none" ? "low-benefit-or-cpu-cost" : "sample-benefit", sampleBytes: bytes, sampleMs, linkBytesPerSecond: rate, measuredLink: measuredLink === true, candidates };
}

class CompressionHistory {
  constructor(clock = Date.now) { this.clock = clock; this.rows = new Map(); this.ttlMs = 15 * 60 * 1000; this.limit = 64; }
  key(source, destination) { return crypto.createHash("sha256").update(JSON.stringify([source.host, source.port, source.username, source.remotePath, destination.host, destination.port, destination.username, destination.remotePath])).digest("hex"); }
  get(key) {
    const item = this.rows.get(key);
    if (!item || this.clock() - item.at > this.ttlMs) { this.rows.delete(key); return null; }
    return item;
  }
  record(key, wireBytes, durationMs) {
    if (!Number.isFinite(wireBytes) || wireBytes < 64 * 1024 || !Number.isFinite(durationMs) || durationMs < 10) return;
    const rate = wireBytes * 1000 / durationMs;
    if (!Number.isFinite(rate) || rate <= 0) return;
    const previous = this.get(key);
    this.rows.delete(key);
    this.rows.set(key, { bytesPerSecond: previous ? previous.bytesPerSecond * 0.5 + rate * 0.5 : rate, wireBytes, durationMs, at: this.clock() });
    while (this.rows.size > this.limit) this.rows.delete(this.rows.keys().next().value);
  }
}

module.exports = { MAX_SAMPLE_BYTES, MAX_SAMPLE_FILES, SAMPLE_TIMEOUT_MS, chooseSampleFiles, chooseCompression, CompressionHistory };
