import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { changeList, readChanges } from "../daemon/changes.ts";

const noSh = process.platform === "win32" ? "the hostile config's programs are shell scripts" : false;

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "loki-changes-"));
  roots.push(root);
  return root;
}

const plainEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^git_/i.test(k))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env: plainEnv, encoding: "utf8", stdio: "pipe" });

function script(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const MARKERS = ["fsmonitor", "clean", "hook", "gpg"];

void test("no program the folder's git config names runs for status, diff, log or show", { skip: noSh }, async () => {
  const root = scratch();
  const repo = join(root, "repo");
  const tools = join(root, "tools");
  mkdirSync(repo);
  mkdirSync(tools);
  const marker = (name: string) => join(root, `ran-${name}`);

  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "b.txt"), "same\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  const tree = git(repo, "rev-parse", "HEAD^{tree}").trim();
  const parent = git(repo, "rev-parse", "HEAD").trim();
  const signed = [
    `tree ${tree}`,
    `parent ${parent}`,
    "author Test <test@example.com> 1700000000 +0000",
    "committer Test <test@example.com> 1700000000 +0000",
    "gpgsig -----BEGIN PGP SIGNATURE-----",
    " ",
    " iQEzBAABCAAdFiEE",
    " -----END PGP SIGNATURE-----",
    "",
    "signed",
    "",
  ].join("\n");
  const signedCommit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
    cwd: repo,
    env: plainEnv,
    input: signed,
    encoding: "utf8",
  }).trim();
  git(repo, "update-ref", "refs/heads/main", signedCommit);

  const fsmonitor = script(tools, "fsmonitor", `touch '${marker("fsmonitor")}'`);
  const clean = script(tools, "clean", `touch '${marker("clean")}'\ncat`);
  const gpg = script(tools, "gpg", `touch '${marker("gpg")}'\nexit 1`);
  script(join(repo, ".git", "hooks"), "post-index-change", `touch '${marker("hook")}'`);
  const hostile = [
    "[core]",
    `\tfsmonitor = ${fsmonitor}`,
    '[filter "evil"]',
    `\tclean = ${clean}`,
    "[log]",
    "\tshowSignature = true",
    "[gpg]",
    `\tprogram = ${gpg}`,
  ];
  appendFileSync(join(repo, ".git", "config"), `${hostile.join("\n")}\n`);
  writeFileSync(join(repo, "a.txt"), "two\n");
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(repo, "a.txt"), later, later);
  utimesSync(join(repo, "b.txt"), later, later);

  for (const kind of ["status", "diff", "log", "show"]) {
    const result = await readChanges(repo, { kind }, { env: plainEnv });
    assert.equal(result.failed, false, `${kind}: ${result.text}`);
  }
  assert.match((await readChanges(repo, { kind: "diff" }, { env: plainEnv })).text, /\+two/);
  assert.deepEqual(
    MARKERS.filter((m) => existsSync(marker(m))),
    [],
  );
  const list = await changeList(repo, { env: plainEnv });
  assert.equal(list.kind, "uncommitted");
  assert.deepEqual(
    MARKERS.filter((m) => existsSync(marker(m))),
    [],
  );

  for (const args of [["status"], ["diff"], ["log", "-1"], ["show", "--stat"]]) execFileSync("git", args, { cwd: repo, env: plainEnv, stdio: "ignore" });
  assert.deepEqual(
    MARKERS.filter((m) => existsSync(marker(m))),
    MARKERS,
    "plain git runs every program this config names, so the check above means something",
  );
});

void test("the change list reads a real checkout: uncommitted files, then commits not on the upstream, then nothing", async () => {
  const root = scratch();
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, repo);
  writeFileSync(join(repo, "a.ts"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main");
  assert.deepEqual(await changeList(repo, { env: plainEnv }), { kind: "nothing_changed" });

  writeFileSync(join(repo, "a.ts"), "one\ntwo\n");
  writeFileSync(join(repo, "b.ts"), "new\n");
  assert.deepEqual(await changeList(repo, { env: plainEnv }), {
    kind: "uncommitted",
    files: [
      { path: "a.ts", added: 1, deleted: 0 },
      { path: "b.ts", added: null, deleted: null },
    ],
    more: 0,
  });

  git(repo, "add", "a.ts");
  git(repo, "commit", "-q", "-m", "second");
  git(repo, "add", "b.ts");
  git(repo, "commit", "-q", "-m", "third");
  const list = await changeList(repo, { env: plainEnv });
  assert.equal(list.kind, "unpushed");
  assert.equal(list.upstream, "origin/main");
  assert.deepEqual(
    list.commits.map((c) => c.subject),
    ["third", "second"],
  );
  assert.deepEqual(list.files, [
    { path: "a.ts", added: 1, deleted: 0 },
    { path: "b.ts", added: 1, deleted: 0 },
  ]);

  assert.deepEqual(await changeList(root, { env: plainEnv }), { kind: "not_a_checkout" });
});
