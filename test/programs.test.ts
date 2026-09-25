import { describe, expect, test } from "bun:test";
import { commandFor, escapeArgument, execProgram, onPath } from "../mod/programs.ts";

const WIN_ENV = { Path: String.raw`C:\Windows\system32;"C:\Program Files\nodejs";C:\Users\someone\AppData\Roaming\npm;`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

describe("program lookup", () => {
  test("PATH splits on the system's delimiter", () => {
    expect(onPath("bd", { platform: "darwin", env: { PATH: "/opt/homebrew/bin::/usr/bin" } })).toEqual(["/opt/homebrew/bin/bd", "/usr/bin/bd"]);
    expect(onPath("bd", { platform: "linux", env: {} })).toEqual([]);
  });

  test("Windows tries each PATHEXT name in each folder, whatever case the variable has", () => {
    const found = onPath("letta", { platform: "win32", env: WIN_ENV });
    expect(found.slice(0, 4)).toEqual([String.raw`C:\Windows\system32\letta.com`, String.raw`C:\Windows\system32\letta.exe`, String.raw`C:\Windows\system32\letta.bat`, String.raw`C:\Windows\system32\letta.cmd`]);
    expect(found).toContain(String.raw`C:\Program Files\nodejs\letta.exe`); // a quoted folder loses its quotes
    expect(found).toContain(String.raw`C:\Users\someone\AppData\Roaming\npm\letta.cmd`);
    expect(found).toHaveLength(12);
    // No PATHEXT: Windows' own default list. A name with its extension is taken as is.
    expect(onPath("letta", { platform: "win32", env: { PATH: "C:\\npm" } })).toEqual(["C:\\npm\\letta.com", "C:\\npm\\letta.exe", "C:\\npm\\letta.bat", "C:\\npm\\letta.cmd"]);
    expect(onPath("tailscale.exe", { platform: "win32", env: { PATH: "C:\\ts" } })).toEqual(["C:\\ts\\tailscale.exe"]);
  });

  test("a .cmd runs through the shell, quoted so cmd.exe reads every character literally", () => {
    const bin = String.raw`C:\Users\some one\AppData\Roaming\npm\letta.cmd`;
    const c = commandFor(bin, ["install", "owner/repo&calc", "--agent", "agent-1"], "win32");
    expect(c.shell).toBe(true);
    expect(c.args).toEqual([]); // one command line: Node would only concatenate args under a shell
    expect(c.file).toBe(String.raw`C:\Users\some^ one\AppData\Roaming\npm\letta.cmd ^^^"install^^^" ^^^"owner/repo^^^&calc^^^" ^^^"--agent^^^" ^^^"agent-1^^^"`);
    expect(commandFor("C:\\x\\run.BAT", [], "win32").shell).toBe(true);
    // An .exe, and anything off Windows, runs directly with its arguments untouched.
    expect(commandFor("C:\\bd\\bd.exe", ["list", "a&b"], "win32")).toEqual({ file: "C:\\bd\\bd.exe", args: ["list", "a&b"], shell: false });
    expect(commandFor("/usr/local/bin/letta.cmd", ["x"], "linux")).toEqual({ file: "/usr/local/bin/letta.cmd", args: ["x"], shell: false });
  });

  test("argument escaping keeps quotes, backslashes and metacharacters", () => {
    expect(escapeArgument("plain", false)).toBe('^"plain^"');
    expect(escapeArgument('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(escapeArgument("C:\\dir\\", false)).toBe('^"C:\\dir\\\\^"'); // the trailing backslash would eat the quote
    expect(escapeArgument("%PATH%!", false)).toBe('^"^%PATH^%^!^"');
    expect(escapeArgument("", false)).toBe('^"^"');
  });

  test("execProgram runs a program directly here and hands back its output", async () => {
    const out = await new Promise<string>((resolve, reject) => execProgram(process.execPath, ["-e", "console.log('a&b')"], { timeout: 20_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
    expect(out.trim()).toBe("a&b");
  });
});
