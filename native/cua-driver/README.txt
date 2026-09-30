Cua Driver 0.30.4 distribution and permission contract

Official source: cua-driver-rs-v0.30.4
Commit: bf6c76786d938070f4ecf1e44004752f69f518b8
SDK: @trycua/cua-driver, pinned exactly in package.json and pnpm-lock.yaml.
Core is MIT; the packaged Node runtime also carries MPL-2.0 (see node-runtime-NOTICE.md).
No AGPL perception extensions or model weights are included.

Integration uses CuaDriver.create(undefined) in the separate, statically imported
out/main/cuaWorker.js ESM worker. There is no extra Agent loop, CLI, external daemon,
runtime download, global Cua configuration change or experimental Cua PiP.
Stop aborts SDK calls and awaits owned direct-runtime shutdown. The idle worker stays
owned by Biny until app disposal: 0.30.4 native callbacks require the same Node environment
for stop/re-enable. Final app disposal terminates the worker.
Interrupted OS delivery may be unknown and must never be automatically replayed.

Electron build must externalize @trycua/cua-driver; bundling it changes its native
library resolver base. Packaging unpacks the worker, its chunks, zod, @trycua and @ubjs under app.asar.unpacked.
The bridge resolves the physical worker path before loading the SDK, so native FFI never
uses a dylib path inside app.asar.
Run node scripts/verify-cua-sdk-load.mjs after pnpm build to validate actual loading.
The default probe loads the installed SDK without runtime creation, TCC queries or input.
Add --runtime to create and shut down the real driver; it does not request permissions,
capture screens or send input. Actual packaged desktop:computer:enable must also pass.

darwin-arm64 official native package:
https://registry.npmjs.org/@trycua/cua-driver-darwin-arm64/-/cua-driver-darwin-arm64-0.30.4.tgz
Lockfile integrity:
sha512-ceIRKOYtsL5mRTivFjctvDEjCuZSddzv6wsaN8fO3/U6bLLOEEXVEBxwmbF5hJLu0Eb33lybVeqZpc0hr9tdtg==
Installed libcua_driver_sdk.dylib SHA256:
4a4553a1644ef452c1a3d925cf78d89fb161ee354a55a4e9e9e7b829d50b3509
Installed cua_driver_node_runtime.node SHA256:
c71c8f69161335d64a26ac6d4f4c07736e1fb923f000e06d5e39037245081e2d
Read-only codesign metadata reports TeamIdentifier YCK386LBJ7 for both native files.
Metadata alone does not confirm Gatekeeper/notarization or native input QA acceptance.
Missing SDK/platform package, load error, missing TCC or version mismatch keeps control disabled.

Native QA requires a separately approved app signature and manual TCC grants only to
the QA Biny host. It must not reuse the user's existing Biny profile or permissions.
node scripts/prepare-cua-qa.mjs prepares an isolated profile with Activity, input monitoring, automatic memory
and browser polling disabled, with the model destination restricted to localhost port 9, plus unsigned electron-builder configuration.
BINY_CUA_QA_PROFILE must point to that profile before launching the approved QA app;
the main entry rejects unsafe/missing QA configuration and redirects userData/Agent data.
Only tests/fixtures/cua-native-fixture.html synthetic content may be observed/controlled.
The prepared app is not signed, launched or granted TCC automatically.
