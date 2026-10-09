"use strict";
const fs = require("node:fs");
const { defaultHostOperationLeasePath } = require("./host-operation-lease");
let blocked = false;
function setUpdateGate(value) { blocked = value === true; }
function assertBusinessAllowed() {
  if (blocked) throw new Error("Mac 配套插件正在更新，暂不接受新业务操作。");
  try {
    const record = JSON.parse(fs.readFileSync(defaultHostOperationLeasePath(), "utf8"));
    if (record.actionType === "mac-preview-update" && Date.parse(record.expiresAt) > Date.now()) throw new Error("Mac 配套插件正在更新，暂不接受新业务操作。");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
module.exports = { setUpdateGate, assertBusinessAllowed };
