import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setTimeout(() => {}, 10000)"],
  {
  detached: process.platform === "win32",
  stdio: ["ignore", "pipe", "ignore"],
  windowsHide: true,
  },
);

grandchild.unref();
grandchild.stdout.once("data", () => {
  console.log(`grandchild-ready:${grandchild.pid}`);
});
setTimeout(() => {}, 10000);
