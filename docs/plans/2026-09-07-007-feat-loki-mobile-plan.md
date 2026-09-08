# loki · on your phone: the app serves Expo Go (2026-09-07)

Decided 2026-09-07 with Deepak: "I want to figure out if we can expose the loki app on a mobile
device. I was thinking an Expo app. The user opens settings on the loki desktop app, scans a QR and
an expo app opens up. The mobile app doesn't need to have desks." → "I want to go ahead with expo"
→ "Readme shouldn't ask other people to do anything besides installing expo go. End user only
download loki app from my github releases page. Everything else should be managed by the loki app
for them."

That last sentence sets the shape. There is no App Store listing, no TestFlight, no Expo account for
the user, no repo checkout. The loki `.dmg` carries the phone app's JavaScript and the mod serves it
to Expo Go over Wi‑Fi, the same way it already serves the desk to a browser tab. The phone is a third
client of the mod, after the shell and the tab; `docs/architecture.md` already reserved the seat ("a
browser tab, and a future phone client, use the tunnel").

## What Expo allows (checked 2026-09-07)

- **Expo Go loads self-hosted updates.** Expo's May 2026 change restricts *EAS Update* projects to
  their owners, and says of the other path: "Self-hosted updates must serve plain JavaScript
  bundles" (no Hermes bytecode). The custom-updates-server doc lists an Expo Go limitation ("only
  updates using Expo Go-compatible libraries are supported"), so loading one in Expo Go is a
  supported case. Sources: expo.dev/changelog/expo-go-loading-changes-may-2026,
  docs.expo.dev/eas-update/custom-updates-server.
- **The login rule is about dev servers.** Since Expo Go for SDK 57 (2026-09-03) a project run
  with `npx expo start` needs the same Expo account in the terminal and the app, because "Expo CLI
  makes network requests to sign manifests with your user credentials". That is `expo start`; an
  exported bundle behind a plain protocol server is not a dev server. Whether Expo Go asks for a
  login before opening an *unsigned* self-hosted manifest is not written anywhere; U1 finds out.
- **The protocol is small.** Expo Updates v1: the client GETs a URL with `expo-platform`,
  `expo-runtime-version`, `expo-protocol-version: 1`; the server answers a JSON manifest
  (`id`, `createdAt`, `runtimeVersion`, `launchAsset`, `assets[]`, `metadata`, `extra`) with
  `expo-protocol-version: 1`, `expo-sfv-version: 0`, a short `cache-control`. Code signing is
  optional ("clients MAY request the manifest be signed"). Source: docs.expo.dev/technical-specs/expo-updates-1.
- **`npx expo export --platform all --no-bytecode --output-dir <dir>`** writes the bundles,
  assets and `metadata.json` the manifest is built from. The flag's doc says "only use this for
  analyzing bundle sizes", but plain JS is exactly what Expo Go now requires of self-hosted updates.
- **Expo Go runs one SDK.** The App Store build tracks the current SDK (57 today). The bundle loki
  ships must be built for that SDK; when Expo Go moves, loki has to ship a new build. The phone
  reports its version in `expo-runtime-version` (`exposdk:57.0.0`), so the mod can say so plainly
  instead of failing silently.
- **Expo Go cannot register `loki://`.** Every project shares `exp://`. The QR therefore carries an
  `exp://` URL, which the iOS Camera hands to Expo Go, and Expo Go fetches the manifest at the same
  host, port, path and query over http. The pairing code rides in that query.
- **What Expo Go can use.** WebSocket (built in, with upgrade headers), `expo-secure-store`,
  `expo-linking`, `expo-constants`, React Native `Image` with request headers. No custom native
  code, no camera needed.

## Decisions

- D1 **The desktop serves the phone app.** `scripts/build-mobile.mjs` exports the Expo project into
  `src-tauri/resources/mobile/`; Tauri already ships `resources/**`. At activate the mod finds the
  installed copy next to `loki-mod.mjs` (or the checkout's `mobile/dist` in development) and serves
  it per Expo Updates v1 from the LAN listener, unsigned, single-part JSON. The mobile source is
  public in the repo, so the manifest and assets are served without a token; they are only
  reachable while the listener is on.
- D2 **A second listener, never the first.** The loopback server on 41414 is untouched. When the
  user turns the phone on, the mod opens a second `http.Server` on `0.0.0.0:41415`
  (`LOKI_LAN_PORT`) that speaks only: `/expo/*` (manifest, assets), `POST /pair`, `/ws`,
  `/appserver`, `/agents/<id>/profile.png`. The desktop capability token is refused there. The
  setting lives in `~/.letta/loki/state/lan.json` and survives `/reload`; the listener comes up
  again with the mod.
- D3 **One token per phone, hashed at rest, sent as a header.** `POST /pair {code, name}` trades
  a one-shot code (6 characters, two minutes, minted by Settings) for a 32-byte device token. The
  mod keeps `state/devices.json`: id, name, sha256 of the token, created, last seen. Every LAN
  upgrade must carry `Authorization: Bearer <device-token>`; `?t=` is ignored on the LAN listener.
  "Forget" in Settings deletes the record and closes that device's sockets. The phone keeps the
  token in SecureStore.
- D4 **The QR is the manifest URL plus the code.** `exp://<lan-ip>:41415/expo?code=ABC123`. Expo
  Go opens it; the app reads the initial URL, sees the code, pairs, and never shows it again. Next
  to the QR Settings prints the code and the URL so a phone that lost the query can type them. The
  LAN address comes from `os.networkInterfaces()` (first non-internal IPv4, `en0` preferred);
  Settings lists the others when there are several.
- D5 **Version honesty.** The manifest route compares `expo-runtime-version` with the SDK the
  bundle was exported for (`mobile/dist/metadata.json` plus `expo.sdkVersion` recorded at build).
  On mismatch it answers 409 with a JSON message, logs it, and broadcasts `lan_status` so Settings
  says "Expo Go on your phone is SDK 58; this loki was built for 57. Update loki." Nothing tries to
  fetch a newer bundle in this pass.
- D6 **One core, three clients.** `packages/core` (`@loki/core`) takes `shared/*` and the attention
  core out of `app/src/attention`: model, protocol, queue, snooze, content, format, harness, and
  `useAttention`. Rules for the package: no `window.`, `document`, `localStorage`, `navigator`, no
  `@tauri-apps/*`; timers are bare `setTimeout`; the transport is injected, not chosen inside. A
  test greps for the leaks. The canvas keeps `TauriTransport` and `BrowserTransport` in
  `app/src/attention/transport.ts` and passes one in; the phone passes a `WebSocket` transport that
  sets the bearer header. `mod/` imports `../packages/core/src/desk-core.ts` the way it imports
  `../shared/desk-core.ts` today (explicit `.ts`, Node strips types).
- D7 **Bun workspaces, root stays the app.** Root `package.json` gains `workspaces: ["packages/*",
  "mobile"]`; the root keeps being the canvas and the mod. Metro is told the workspace root
  (`watchFolders`) and both `node_modules` paths; Expo's Metro config detects workspaces on SDK 52+,
  so this is expected to be the default config plus the `.ts`-extension import check in U1.
- D8 **Inbox only, on the phone.** Screens: Pair, Inbox, Conversation. The inbox is Catch Up's
  list (`buildItems`, digests, seen and snooze from `/ws`), grouped approvals → questions →
  failures → finished, each card with agent name and colour, the last lines, and the actions:
  approve, deny, answer, seen, later, unsnooze, open. Conversation shows the transcript
  (`history_get` plus live tail), approval and question cards inline, and a reply box with the
  same context note the canvas attaches. No desks, board, agents, model or permission chips,
  images, or dictation.
- D9 **The tokens travel too.** `packages/core/src/theme.ts` holds the drafting-table values as
  numbers and hex; a test compares it with `app/src/kit/tokens.css` so the two cannot drift.
  Phone type scale is the desk's (13.5 body, 15 row title, 17 card title); brass only on things
  that wait for the human.
- D10 **The phone learns nothing in the background.** iOS suspends sockets. Both sockets reconnect
  with backoff on foreground (`AppState`), the inbox refreshes on resume, and the app says "last
  seen …" when the Mac is unreachable. No push, no relay: the trust model stays "your Wi‑Fi, your
  Mac".
- D11 **Security is written down.** SECURITY.md gains the LAN model: off by default; anyone on the
  same network can fetch the phone app's JavaScript (public code) while it is on; every action
  needs a device token; pairing codes are one-shot and two minutes; forget a phone in Settings;
  for hostile networks use Tailscale. The dock and Settings show a brass dot while the listener is on.

## Shape

    packages/core/src   desk-core · harness · compat · theme · attention/{model,protocol,queue,snooze,content,format,transport(iface),useAttention}
    mod/lan.ts          LanListener: second http.Server, routes /expo /pair /ws /appserver /profile.png; lan.json
    mod/devices.ts      DeviceStore: devices.json, mint/verify (sha256), forget → close sockets
    mod/pairing.ts      PairingCodes: mint (6 chars, 2 min, one-shot), redeem
    mod/expo-serve.ts   manifest from metadata.json + sdk; runtime check (409); assets with content-type + sha256
    mod/server.ts       attachWs gains an auth callback so the same bridge serves both listeners
    bridge frames       lan_get · lan_set · pair_begin · devices_list · device_forget · (broadcast) lan_status
    app/src/shell/Settings.tsx   "phone" section: toggle · QR (svg) · code + url · devices · SDK line · warning
    mobile/             Expo app: App.tsx (Pair/Inbox/Conversation) · src/transport.ts · src/store.ts (SecureStore) · app.json (scheme, name loki)
    scripts/build-mobile.mjs     bun x expo export --platform all --no-bytecode → src-tauri/resources/mobile
    README · SECURITY · RELEASING · ci.yml · tauri.conf beforeBuildCommand

## Units

### U1. Spike: Expo Go opens a bundle loki serves

**Goal.** Prove D1 on a real iPhone before anything else is built: an exported, plain-JS bundle,
served unsigned from a Node script on the Mac, opens in Expo Go from an `exp://` QR, logged out.
**Files.** `mobile/` (bare `create-expo-app`, one screen that prints the initial URL and connects
a WebSocket to a header-checking echo server), `scripts/spike-serve.mjs` (throwaway; deleted
after), findings appended to this plan as an addendum.
**Approach.** Export with `--platform ios --no-bytecode`; serve `metadata.json`'s bundle as
`launchAsset` with the protocol headers and `runtimeVersion` `exposdk:57.0.0`; QR the URL. Then
try: signed out of Expo Go; signed in with an unrelated account; with `?code=x` in the URL to
confirm the query reaches `Linking.getInitialURL`; a WebSocket upgrade with an `Authorization`
header; an `Image` with headers; Android Expo Go if a device is at hand. Record what the SDK 57
Expo Go actually demands.
**Gates.** (a) Loads signed out → proceed as written. (b) Loads only when signed in to *any*
account → keep the plan, add one README line ("sign in to Expo Go"), note it in Settings. (c)
Refuses self-hosted manifests → stop; the remaining choice is a development build or TestFlight,
which is a different plan (see "Not in this pass").
**Test expectation: none.** This is a runtime proof; its output is the addendum.

### U2. `packages/core`: one core for three clients (D6, D7, D9)

**Goal.** Move `shared/*` and the attention core into a workspace package with no browser or Tauri
imports, and make the canvas and the mod use it. Behaviour unchanged.
**Files.** `packages/core/package.json`, `packages/core/src/**` (moved from `shared/` and
`app/src/attention/{model,protocol,queue,snooze,content,format,useAttention}.ts`),
`packages/core/src/attention/transport.ts` (interface only), `packages/core/src/theme.ts`;
`app/src/attention/transport.ts` (keeps the two implementations, imports the interface);
every `../shared/…` import in `mod/`, `app/src/`, `test/`; `tsconfig.json` (`include`,
`paths`); `scripts/build-mod.mjs` (entry unchanged, bundle follows imports); root
`package.json` (`workspaces`). Tests: `test/core-portability.test.ts`, `test/theme.test.ts`,
existing tests moved with their modules.
**Approach.** `useAttention` takes `makeTransport` in its options instead of importing
`inTauri`; the timers lose `window.`; `protocol.ts` likewise. The Tauri-only notify path in
`useAttention` (the `invoke`/`listen` imports) moves behind an optional `platform` option the
canvas supplies. Keep `.ts`-extension relative imports throughout the package: Node needs them
for the mod, and the U1 spike confirms Metro resolves them.
**Tests.** portability: no file under `packages/core/src` matches `window\.|document\.|
localStorage|navigator\.|@tauri-apps`. theme: every `--loki-*` colour and the type, radius and
shadow scales in `tokens.css` equal the values in `theme.ts`, and nothing in `theme.ts` is absent
from the CSS. Existing `attention-model`, `queue`, `snooze`, `content`, `harness`, `desk-core`,
`compat` tests pass from their new paths. `bun run typecheck`, `bun run build:app`,
`bun run build:mod` succeed; the canvas behaves as before in the shell and in a tab.

### U3. Devices, pairing codes, and the LAN listener (D2, D3, D4)

**Goal.** The mod can open a second listener for phones, mint pairing codes, issue and revoke
device tokens, and serve the existing `/ws` and `/appserver` bridge to bearer-authenticated
devices. Off by default.
**Files.** `mod/lan.ts`, `mod/devices.ts`, `mod/pairing.ts`, `mod/server.ts` (an `authorize(req)`
hook on `attachWs` and on the profile route, so one bridge serves both listeners), `mod/mod.ts`
(start from `lan.json`, wire frames, close on deactivate), `mod/bridge.ts` (`lan_get`, `lan_set`,
`pair_begin`, `devices_list`, `device_forget`, broadcast `lan_status`), `mod/paths.ts`
(`lan`, `devices` files). Tests: `test/devices.test.ts`, `test/pairing.test.ts`, `test/lan.test.ts`.
**Approach.** Loopback keeps `?t=`; LAN accepts only `Authorization: Bearer` and looks the hash up
in `DeviceStore`. A redeemed code is deleted before the token is written. `lan_set {enabled}`
persists first, then binds or closes; the bound address and port ride in `lan_status`. Forgetting
a device closes its live sockets (track socket → device id on upgrade). Bind failures
(`EADDRINUSE`, no interface) are reported in `lan_status.error`, never thrown.
**Tests.** devices: mint returns a 64-hex token and stores only its sha256; verify accepts the
token and rejects a one-character change; forget removes the record and `verify` fails
afterwards; the file round-trips through a new store. pairing: a code redeems once and then 404s;
a code older than two minutes is refused; codes are uppercase alphanumeric without 0/O/1/I. lan:
with `enabled:false` no socket listens on the LAN port; enabling binds `0.0.0.0` on a test port and
`/health` answers; an upgrade with the *desktop* token in `?t=` is destroyed; an upgrade with a
valid bearer reaches the bridge and `list_desks` answers; after `device_forget` the same socket is
closed within a second; `POST /pair` with a bad code is 404 and with a good code returns a token
that then authenticates; `lan_status` broadcasts on enable, disable and bind error.

### U4. Serving the phone app: Expo Updates v1 (D1, D5)

**Goal.** `GET /expo` on the LAN listener answers a valid manifest for the bundle loki ships, and
`GET /expo/assets/<key>` serves the files, with the runtime-version check.
**Files.** `mod/expo-serve.ts`, `mod/lan.ts` (routes), `scripts/build-mobile.mjs`,
`src-tauri/tauri.conf.json` (`beforeBuildCommand` adds `bun run build:mobile`),
`src-tauri/src/install.rs` (`find_resources` unchanged; the mod locates `mobile/` beside its own
bundle at runtime, so document the layout there), `package.json` (`build:mobile`). Tests:
`test/expo-serve.test.ts` with a fixture export under `test/fixtures/expo-export/`.
**Approach.** At activate the mod resolves the mobile dist: `LOKI_MOBILE_DIR`, then
`<dir of loki-mod.mjs>/../mobile`, then `<repo>/mobile/dist`. The manifest is built once per
`metadata.json` mtime: `id` a UUID derived from the bundle hash, `createdAt` the export time,
`runtimeVersion` from a `sdk.json` the build script writes next to `metadata.json`,
`launchAsset` the platform's bundle (`application/javascript`, sha256 base64url), `assets`
from `metadata.json` with content types by extension, `extra.expoClient` the app config
(`name`, `slug`, `scheme`). Query params on `/expo` are passed through untouched so the pairing
code survives. Headers: `expo-protocol-version: 1`, `expo-sfv-version: 0`,
`cache-control: private, max-age=0`, `content-type: application/expo+json`. Wrong platform 400,
wrong runtime 409 with `{message, built, requested}`, no dist 503 with a message Settings shows.
**Tests.** the fixture yields a manifest whose `launchAsset.hash` equals the file's sha256; every
`assets[]` entry resolves to a 200 with the declared content type; `expo-platform: web` is 400;
`expo-runtime-version: exposdk:58.0.0` against a 57 build is 409 and `lan_status` carries the
pair of versions; `?code=ABC123` on `/expo` does not change the manifest; missing dist is 503.
Execution note: prefer a real export in the fixture over a hand-written one; regenerate it in U6.

### U5. Settings › phone (D4, D5, D11)

**Goal.** One place to turn the listener on, pair, see and forget phones, and read the honest
version line.
**Files.** `app/src/shell/Settings.tsx` (new `Section title="phone"`), `app/src/settings/Phone.tsx`,
`app/src/desk/useDesk.ts` (the five frames and `lan_status`), a QR renderer (`qrcode` to SVG
string, or a small local encoder in `app/src/settings/qr.ts` if the dependency is heavier than
the kit allows), README "Phone" section, SECURITY.md LAN model, `docs/architecture.md` (the third
client and the second port). Tests: `test/phone-settings.test.ts` for the pure pieces (QR payload
string, device row formatting), `test/tokens.test.ts` keeps passing.
**Approach.** Toggle "reachable on this Wi‑Fi" with the address beside it; when on, a
`pair_begin` button shows the QR, the code, and the URL, with a two-minute countdown and a redo.
Paired phones as rows: name, last seen, forget. The SDK line: "serves Expo SDK 57" and the 409
message when one arrived. A brass notice explains what being on means, in the SECURITY.md words.
Brass dot on the rail's settings icon while on.
**Tests.** the QR payload for host, port and code is exactly `exp://host:port/expo?code=CODE`; a
device seen within a minute renders "just now"; enabling with no interface shows the
`lan_status.error`; the section renders without the listener (state off) and with two devices.
Runtime check in the shell: toggle on, scan with the iPhone Camera, Expo Go opens.

### U6. The phone app (D8, D10)

**Goal.** Pair, then the inbox and a conversation, on iOS in Expo Go; Android exported and
smoke-checked if a device is available.
**Files.** `mobile/app.json`, `mobile/package.json`, `mobile/metro.config.js`, `mobile/App.tsx`,
`mobile/src/{Pair,Inbox,Conversation}.tsx`, `mobile/src/cards/{Approval,Question,Row}.tsx`,
`mobile/src/transport.ts` (WebSocket with bearer header, backoff, AppState), `mobile/src/store.ts`
(SecureStore: host, port, token, device name), `mobile/src/theme.ts` (from `@loki/core`),
`scripts/build-mobile.mjs` (final form). Tests: `test/mobile-logic.test.ts` for the pure bits
(pair URL parse, backoff schedule, "last seen" formatting); UI proven on the device.
**Approach.** On launch: if SecureStore has a pairing, open both sockets; else read the initial
URL, take `code`, and `POST /pair` with the device name; failing that show the type-in screen. The
inbox is `useAttention` from `@loki/core` with the mod-side `seen`, `snooze`, `history_get`
supplied over `/ws` exactly as `useDesk` does on the canvas; a small `useLan` hook owns that
socket. Cards reuse `buildItems` ordering and `format.ts`. Approve/deny/answer/reply send the same
frames the canvas sends (`content.ts` builds them). Conversation: transcript from `history_get`
plus live tail, newest at the bottom, tool calls as muted markers, reply box with send.
Disconnected banner with "last seen". Reduced motion respected.
**Tests.** pure: `exp://10.0.0.5:41415/expo?code=Q7K2M9` parses to host, port and code and the
same URL without `code` parses to no code; backoff is 1, 2, 4, 8, 15, 15… seconds; a 90-second-old
`lastSeen` formats "1 minute ago". Device smoke (recorded in the addendum): pair from the QR; a
pending approval appears at the top within two seconds of the agent asking; approve from the
phone and the desktop card clears; answer a question; reply in a conversation and see it stream;
mark seen and the desktop count drops; background the app for a minute and it reconnects; forget
the phone on the desktop and the app returns to Pair.

### U7. Build, CI, release, docs

**Goal.** The `.dmg` carries the phone bundle; CI builds it; the release notes say which Expo SDK.
**Files.** `.github/workflows/ci.yml` (`bun run build:mobile` after `build:mod`),
`.github/workflows/release.yml` (same before `tauri-action`), `RELEASING.md` (the SDK line:
which Expo Go the release serves, and "bump when Expo Go moves"), `README.md` ("Phone": install
Expo Go, Settings › phone, on, scan; nothing else), `shared`→`packages/core/src/compat.ts` gains
`TESTED_EXPO_SDK` with a test that it equals `mobile/app.json`'s SDK. Tests: `test/compat.test.ts`.
**Tests.** compat: the recorded SDK equals the one in `mobile/package.json`'s `expo` major.
Verification: a local `bun run desktop:build` produces an app whose `Contents/Resources` has
`mobile/metadata.json`, and a fresh install on a second Mac account pairs a phone with no
developer tools present.
Execution note: packaging; prefer the install smoke over unit coverage.

## Order

U1 first and alone; its addendum decides whether U4 and U6 proceed as written. U2 and U3 are
independent of U1 and of each other. U4 needs U3. U5 needs U3 and U4. U6 needs U2, U3, U4. U7 last.

## Not in this pass

TestFlight or App Store builds, a development build, `loki://`; push notifications or any relay;
fetching a newer mobile bundle when Expo Go moves ahead (v2: match `expo-runtime-version` against
GitHub release assets); board, agents, desks, model and permission chips, images and dictation on
the phone; TLS on the LAN (say Tailscale); mDNS so the QR could carry a name instead of an address;
Windows and Linux.

## Open until U1 answers

Whether SDK 57 Expo Go loads an unsigned self-hosted manifest signed out (gate a) or only signed
in (gate b); whether Metro resolves `.ts`-extension relative imports from the workspace package
without a resolver shim; whether the `?code=` query survives Camera → Expo Go → `getInitialURL`
on iOS and Android; the exact `runtimeVersion` string Expo Go 57 sends. Everything in U2–U7 is
written for gate (a); gate (b) adds one line; gate (c) ends this plan.

## Addendum (same evening): U1 ran, and we switched to a PWA

**What U1 found** (iPhone 15 Pro Max, iOS 26.6.1, Expo Go 57.0.9 from the App Store, signed out):

- Expo Go opened the `exp://192.168.1.3:41415/expo?code=…` QR from the Camera and fetched the manifest
  with `expo-runtime-version: exposdk:57.0.0`, `expo-protocol-version: 1`, `expo-expect-signature:
  sig, keyid="expo-root", alg="rsa-v1_5-sha256"`, `expo-client-release-type: APPLE_APP_STORE`. It then
  fetched the plain-JS bundle. No login was asked for. So an unsigned, self-hosted manifest is at least
  *fetched and followed* signed out.
- It refused the first manifest: "Failed to parse manifest JSON: Value for (key = scopeKey) is null".
  Expo's dev server (`@expo/cli` `ExpoGoManifestHandlerMiddleware`) sends `extra.scopeKey =
  @anonymous/<slug>-<uuid>` when nobody is signed in, `extra.expoClient.hostUri`, `platforms`, an
  `extra.expoGo` block marked "Required for Expo Go to function", and answers with
  **`expo-protocol-version: 0`**, not the spec's 1.
- With those added, Expo Go crashed natively (SIGABRT, `-[NSException raise]` on a background queue,
  `Expo Go-2026-09-07-221246.ips`) on each retry, the last time without making a network request at all,
  which points at state it had stored from the earlier manifests. Apple's report carries no exception
  text and Expo Go ships no symbols, so the cause is not recoverable without Console.app on a cable.
- Metro export works: `expo export --platform ios --no-bytecode` → one 926 KB JS bundle,
  `metadata.json`, no assets for the blank template.

**Why we switched.** Deepak: "Is expo really worth it. Does it have performance any better than a
PWA?" → "sure, let's switch to the PWA". For an inbox, a transcript and a reply box, a standalone
home-screen web app on iOS is WebKit without browser chrome and performs the same. Expo Go added: a
login regime aimed at dev servers, one supported SDK at a time, opaque native crashes, a separate React
Native UI to write and test, and a runtime Expo itself calls a playground. The PWA reuses the canvas's
existing React DOM views and the mod already serves a browser tab.

**What stays.** U2 (done: `packages/core`), U3 as written except the token transport, U5 and U7.
D1, D4, D5 and U4/U6 are replaced below. Distribution is unchanged in spirit: the `.dmg` is the only
download; the phone needs nothing installed.

### Decisions (revised)

- D1' **The mod serves the canvas over the LAN.** `scripts/build-mod.mjs` also copies `app/dist` into
  `src-tauri/resources/app/`; `src-tauri/src/install.rs` copies it to `<data>/app/` beside
  `<data>/mod/loki-mod.mjs` on launch. The LAN listener serves it as a single-page app: `/assets/*`
  static, everything else `index.html` with `<script>window.__LOKI__={lan:true}</script>` injected
  before `</head>`. Resolution order: `LOKI_APP_DIST`, `<dir of the mod file>/../app`,
  `<repo>/app/dist`; when none exists `/` answers a plain page saying to run `bun run build:app`.
- D3' **Device tokens ride in a cookie, not a header.** Browsers cannot set WebSocket headers.
  `POST /pair {code, name}` answers `Set-Cookie: loki_device=<token>; Path=/; HttpOnly; SameSite=Lax;
  Max-Age=31536000` and `{deviceId, name}`. Upgrades and the profile route on the LAN accept the cookie
  or `Authorization: Bearer`; `?t=` is ignored there. `GET /me` → `{deviceId, name}` or 401 tells the
  page whether it is paired. `POST /unpair` clears the cookie and forgets the device.
- D4' **The QR is `http://<lan-ip>:41415/?code=ABC123`.** The page redeems `code` on load. Codes live
  ten minutes and may be redeemed more than once inside that window, each time as a new device,
  because an iOS home-screen web app has its own cookie jar: the user pairs in Safari, adds to the
  Home Screen, opens the new icon unpaired, and either the bookmark's `?code=` (if the manifest's
  `start_url` keeps it) or typing the six characters still shown in Settings pairs it again. The
  unpaired page always offers the code field. No service worker (a LAN `http://` origin is not a
  secure context), so no offline shell and no web push; neither is needed while the Mac must be up.
- D5' **No version coupling.** The phone loads whatever canvas the running loki serves.
- D8' **Phone mode is a second shell.** When `window.__LOKI__.lan` is set, `main.tsx` renders
  `<Phone/>` instead of `<Shell/>`: Pair (auto from `?code`, else the code field), Inbox (Catch Up's
  items and actions in a single-column layout), Conversation (transcript, approval and question cards,
  reply box). Reuses `useDesk`, `useAttention`, `CatchUp`'s card pieces and `Transcript`. Same
  tokens, same no-desk scope as D8. `modBase()` is `location.origin` in LAN mode.

### Bridge frames (contract for U3, U5, U6')

    lan_get                      → lan_status { enabled, address, addresses[], port, appServed, error }
    lan_set { enabled }          → lan_status (persisted to state/lan.json first, then bind/close)
    pair_begin                   → pair_code { code, url, expiresAt }
    devices_list                 → devices { devices: [{ id, name, createdAt, lastSeenAt }] }
    device_forget { id }         → devices (and that device's sockets close)
    broadcast lan_status on enable/disable/bind error; devices on pair/forget/seen

Devices file `state/devices.json`: `{ id, name, tokenHash (sha256 hex), createdAt, lastSeenAt }[]`.
Pairing codes: alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, six characters, in memory only.

### Units (revised)

- **U3'** as U3, with the cookie and `Authorization` acceptance from D3', `/pair`, `/me`, `/unpair`,
  the SPA static route from D1' (`mod/static.ts`), `scripts/build-mod.mjs` copying `app/dist`, and
  `src-tauri/src/install.rs` installing `app/`. Tests as U3 plus: `/pair` sets the cookie and `/me`
  then answers 200; `/me` without the cookie is 401; a redeem after ten minutes is 404; two redeems of
  one code make two devices; `GET /` serves `index.html` with the injected script and `GET /assets/x.js`
  the file; a missing dist makes `/` a 503 page; `Set-Cookie` carries `HttpOnly` and `SameSite=Lax`.
- **U5'** Settings › phone as U5; the QR encodes D4's URL; the copy says "scan, then Add to Home
  Screen; the new icon asks for this code once".
- **U6'** `app/src/phone/{Phone,Pair,Inbox,Conversation}.tsx`, `app/src/desk/env.ts` (`inLan`,
  `modBase`), `app/src/main.tsx` (branch), `app/index.html`/`manifest.webmanifest` (`start_url`
  keeps the query, `apple-mobile-web-app-*` metas, viewport-fit). Tests: `test/phone.test.ts` for the
  pure bits (pair URL parse, "last seen" formatting); `test/tokens.test.ts` keeps passing. Device
  smoke as U6 but in Safari and from the Home Screen icon.
- **U4 and U6 (Expo) are dropped.** `mobile/`, `scripts/spike-serve.mjs` and the `mobile` workspace
  entry were removed after the spike.

## Addendum 2 (2026-09-08): the phone grows a bottom bar

Deepak: "Let's continue building the mobile surface. Just like slack, give me a Home, Inbox,
Agents, Settings bottom nav bar. Design those surfaces." Earlier the same evening the inbox became a
Slack Catch Up deck (swipe right seen, left later, tap open; approvals refuse to swipe; undo pill;
"You're caught up").

- **Bar.** Four tabs (Home, Inbox, Agents, Settings), 56px plus the safe inset, icons with condensed
  caps as on the rail; active tab in paper, brass only on the Inbox count. Hidden inside a conversation
  or an agent page. Hash routes (`#/home`, `#/inbox`, `#/agents/<id>`, `#/c/<agent>/<conversation>`)
  so the home-screen app has history and swipe-back.
- **Home** is the desks tree: pinned first then recency, one row per conversation with face, title,
  time and the tree's attention dot; agent chips filter; a filter field; archive folded; **+** starts a
  chat with an agent in its most recent folder (`folders_get` + the app-server's conversation create).
- **Agents** is read-only: rows (face, name, description, model, live desks), a page with identity,
  memory tree and file viewer, skills, recent commits; "ask <agent> to update this" opens its chat.
- **Settings**: this phone (name, paired since, unpair), the Mac (host, port, Letta Code version,
  link state), and where the rest lives.
- **Mod.** `PHONE_FRAMES` gains the reads a phone needs: `pin_set`, `folders_get`, `agent_get`,
  `memory_read`, `memory_log`, `memory_diff`. Writes to agents, skills, the board and pairing stay
  desktop-only.
