import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 10000)"],
  {
  detached: process.platform === "win32",
  stdio: "ignore",
  windowsHide: true,
  },
);

grandchild.unref();
console.log(`grandchild:${grandchild.pid}`);
setTimeout(() => {}, 10000);
