import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setTimeout(() => {}, 10000)"],
  {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  },
);

grandchild.stdout.once("data", () => {
  console.log(`grandchild-ready:${grandchild.pid}`);
});
setTimeout(() => {}, 10000);
