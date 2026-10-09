"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough, Writable } = require("node:stream");
const { LatestSnapshotWriter } = require("../latest-snapshot-writer");
const { writeTarEntriesToStream } = require("../tar-writer");
const fs = require("node:fs");

test("a thousand receipt updates retain only the active and latest durable snapshot", async () => {
  let release;
  const writes = [];
  const writer = new LatestSnapshotWriter(async value => {
    writes.push(value);
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
  });
  const first = writer.enqueue(0);
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 1; i <= 1000; i++) assert.equal(writer.enqueue(i), first);
  release();
  await first;
  assert.deepEqual(writes, [0, 1000]);
});
test("generated UTF-8 metadata and logical directories need no temporary files", async () => {
  const chunks = [];
  const stream = new Writable({ write(chunk, _encoding, next) { chunks.push(chunk); next(); } });
  const content = Buffer.from('{"说明":"仅驻内存"}', "utf8");
  await writeTarEntriesToStream({ localPath: "/path/that/does/not/exist", files: [{ relativePath: "logical/path/state.json", content }], stream });
  const archive = Buffer.concat(chunks);
  assert.ok(archive.includes(content));
  for (const name of ["../escape", "nested/../../escape", "C:/file", "/absolute", "a\0b"])
    await assert.rejects(writeTarEntriesToStream({ localPath: "unused", files: [{ relativePath: name, content }], stream }), /不安全/);
});
test("closed consumers reject a backpressured tar write", async () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  const writing = writeTarEntriesToStream({ localPath: "unused", files: [{ relativePath: "state.json", content: Buffer.from("x") }], stream });
  stream.destroy();
  await assert.rejects(writing, /关闭/);
});
test("source descriptor is released when its first identity probe fails", async () => {
  const originalStat=fs.promises.lstat, originalOpen=fs.promises.open;
  let closed=0;
  fs.promises.lstat=async()=>({isSymbolicLink:()=>false,isFile:()=>true,mode:0o644,size:1,mtimeMs:0});
  fs.promises.open=async()=>({stat:async()=>{throw new Error("source unavailable");},close:async()=>{closed++;}});
  const stream=new Writable({write(_chunk,_encoding,next){next();}});
  try {
    await assert.rejects(writeTarEntriesToStream({localPath:"/virtual",files:[{relativePath:"one.txt"}],stream}),/source unavailable/);
    assert.equal(closed,1);
  } finally { fs.promises.lstat=originalStat;fs.promises.open=originalOpen; }
});
