import { expect, test } from "vitest";
import { forLibc } from "../scripts/native-binaries.ts";

const names = [
  "@napi-rs/keyring-darwin-arm64",
  "@napi-rs/keyring-linux-x64-gnu",
  "@napi-rs/keyring-linux-x64-musl",
  "@napi-rs/keyring-linux-arm-gnueabihf",
  "@napi-rs/keyring-win32-x64-msvc",
];

test("a glibc Linux bundle leaves the musl builds out, which linuxdeploy's ldd cannot read", () => {
  expect(forLibc(names, "glibc")).toEqual([
    "@napi-rs/keyring-darwin-arm64",
    "@napi-rs/keyring-linux-x64-gnu",
    "@napi-rs/keyring-linux-arm-gnueabihf",
    "@napi-rs/keyring-win32-x64-msvc",
  ]);
});

test("a musl Linux bundle leaves the glibc builds out", () => {
  expect(forLibc(names, "musl")).toEqual(["@napi-rs/keyring-darwin-arm64", "@napi-rs/keyring-linux-x64-musl", "@napi-rs/keyring-win32-x64-msvc"]);
});

test("off Linux every installed build stays: there is only the one", () => {
  expect(forLibc(names, null)).toEqual(names);
});
