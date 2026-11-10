const mode = process.argv[2];
const body = Buffer.from(
  JSON.stringify({
    version: 1,
    kind: "result",
    code: 0,
    stdout: mode === "base64" ? "%%%" : "",
    stderr: "",
  }),
);
const header = Buffer.alloc(4);
header.writeUInt32BE(body.length);
process.stdin.resume();
process.stdout.write(
  Buffer.concat([header, body, mode === "trailing" ? Buffer.from([1]) : Buffer.alloc(0)]),
  () => {
    process.exit(mode === "exit" ? 23 : 0);
  },
);
