"use strict";
const http = require("node:http");
const port = Number(process.env.SIMPLE_SFTP_AUTH_PORT), nonce = process.env.SIMPLE_SFTP_AUTH_NONCE;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[0-9a-f]{64}$/.test(nonce || "")) process.exit(1);
const payload = Buffer.from(JSON.stringify({ prompt: process.argv[2] || "" }), "utf8");
const request = http.request({ host: "127.0.0.1", port, path: "/askpass", method: "POST", headers: { "X-Simple-SFTP-Auth": nonce, "Content-Type": "application/json", "Content-Length": payload.length } }, response => {
  let value = "";
  response.setEncoding("utf8");
  response.on("data", chunk => { value += chunk; if (Buffer.byteLength(value) > 4096) request.destroy(); });
  response.on("end", () => {
    if (response.statusCode !== 200 || /[\r\n\0]/.test(value)) { process.exitCode = 1; return; }
    process.stdout.write(value + "\n");
  });
  response.on("error", () => { process.exitCode = 1; });
});
request.setTimeout(90000, () => request.destroy());
request.on("error", () => { process.exitCode = 1; });
request.end(payload);
