import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { alive } from "../daemon/parent-watch.ts";
import { killTree } from "../daemon/tree-kill.ts";

const GRANDCHILD = "setInterval(() => {}, 1000)";
const CHILD = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(GRANDCHILD)}], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);`;

async function gone(pid: number, within: number): Promise<boolean> {
  const until = Date.now() + within;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

void test("ending a process also ends the process it started", async () => {
  const child = spawn(process.execPath, ["-e", CHILD], { stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32" });
  const [line] = (await once(child.stdout, "data")) as [Buffer];
  const grandchild = Number(line.toString().trim());
  assert.ok(child.pid !== undefined && Number.isInteger(grandchild) && alive(grandchild));
  try {
    killTree(child.pid);
    assert.ok(await gone(child.pid, 5000), "the child lives on");
    assert.ok(await gone(grandchild, 5000), "the grandchild lives on");
  } finally {
    for (const pid of [child.pid, grandchild]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
});
