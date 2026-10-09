"use strict";
const { spawnSync } = require("node:child_process");
const gate = require("./mac-update-gate");
const { registerMacCli } = require("./mac-cli");
let business;
async function activate(context) {
  const vscode = require("vscode");
  context.subscriptions.push(vscode.commands.registerCommand("simpleSftpMac.checkPreviewUpdates", async () => {
    const experiment = vscode.extensions.getExtension("simple-local.simple-experiment-mac");
    if (!experiment) {
      await vscode.window.showInformationMessage("首次安装请依次安装 SimpleSFTP Mac、SimpleExperiment Mac。配套 preview 更新由 SimpleExperiment Mac 的独立入口管理。");
      return;
    }
    if (!experiment.isActive) await experiment.activate();
    return vscode.commands.executeCommand("simpleExperimentMac.checkPreviewUpdates");
  }));
  const cli = registerMacCli(context, vscode);
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    await vscode.window.showWarningMessage("SimpleSFTP Mac preview 仅支持 Apple Silicon、macOS 26 及以上。"); return;
  }
  const version = spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8", timeout: 10000, windowsHide: true });
  if (version.status !== 0 || Number(version.stdout.trim().split(".")[0]) < 26) {
    await vscode.window.showErrorMessage("SimpleSFTP Mac preview 需要 macOS 26 及以上。"); return;
  }
  try { cli.refresh(); }
  catch (error) { void vscode.window.showWarningMessage(`Mac CLI 入口暂不可用：${error.message}。更新入口保留。`); }
  try { business = require("./extension"); await business.activate(context); }
  catch (error) { await vscode.window.showErrorMessage(`SimpleSFTP Mac 业务启动失败，更新入口仍可用：${error.message}`); }
}
async function deactivate() { await business?.deactivate?.(); }
module.exports = { activate, deactivate, setUpdateGate: gate.setUpdateGate, waitForUpdateIdle: async () => { await business?.waitForUpdateIdle?.(); } };
