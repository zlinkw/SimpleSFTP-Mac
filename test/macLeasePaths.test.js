const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
function darwinModule(file, extra = "") {
  const localRequire=createRequire(file),exports={};
  const context={module:{exports},exports,process:{...process,platform:"darwin",arch:"arm64"},Buffer,console,setTimeout,clearTimeout,setInterval,clearInterval,
    require:name=>["path","node:path"].includes(name)?{...path.posix,posix:path.posix,win32:path.win32}:localRequire(name)};
  vm.runInNewContext(fs.readFileSync(file,"utf8")+extra,context,{filename:file});return context.module.exports;
}
test("Mac SFTP leases preserve POSIX paths and separate case-sensitive roots",()=>{
  const host=darwinModule(path.resolve(__dirname,"../host-operation-lease.js"),"\nmodule.exports.Legacy = LegacyHostOperationLeaseManager; module.exports.sessionKey = sessionKey;");
  const manager=new host.Legacy({leasePath:"/tmp/lease",windowId:"test",heartbeatMs:0});
  const project="/Users/test/研究 项目/Model/尾部 ";
  assert.equal(manager.createRecord({pluginId:"mac",workspaceUri:"file:///test",hostProjectPath:project,actionType:"write"}).hostProjectPath,project);
  assert.notEqual(host.sessionKey("/tmp/Model/lease"),host.sessionKey("/tmp/model/lease"));
  const resource=darwinModule(path.resolve(__dirname,"../resource-operation-lease.js"));
  const a=new resource.ResourceOperationLeaseManager({leasePath:"/tmp/Model/lease",windowId:"test"});
  const b=new resource.ResourceOperationLeaseManager({leasePath:"/tmp/model/lease",windowId:"test"});
  assert.notEqual(a.state,b.state);
});
