const mode = process.argv[2];

switch (mode) {
  case "json-crlf-chunks":
    process.stdout.write('{"type":"text","part":{"text":"First "}}\r');
    setTimeout(() => {
      process.stdout.write('\n{"type":"text","part":{"text":"Second"}}\r\n');
    }, 10);
    break;
  case "slow":
    setTimeout(() => {
      process.stdout.write("finished");
    }, 1000);
    break;
  case "delay":
    setTimeout(() => {}, 75);
    break;
  case "large-output":
    process.stdout.write("x".repeat(Number(process.argv[3] || 0)));
    process.stderr.write("y".repeat(Number(process.argv[3] || 0)));
    break;
  case "exit-immediately":
    process.exit(0);
    break;
  default:
    throw new Error(`Unsupported fixture mode: ${mode}`);
}
