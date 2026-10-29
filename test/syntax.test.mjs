// Every extension module must parse. A syntax error in one page script (such
// as a duplicate declaration) silently stops that whole page in Chrome.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "lib" ? [] : files(path);
    return name.endsWith(".js") ? [path] : [];
  });
}

for (const file of files(root)) {
  test(`parses: ${file.slice(root.length)}`, () => {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  });
}
