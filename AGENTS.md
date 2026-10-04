# AGENTS.md — XMRig on Base44

## What this project is
XMRig is a C++ cryptocurrency miner (RandomX, CryptoNight, Argon2, GhostRider, Flex, Panthera). It is a **command-line tool**, not a web application — there is no built-in web frontend.

## How it runs on Base44
Since the preview requires a web server on port 3000, `server.js` provides a lightweight Node.js dashboard that:
- Compiles the `hash-tests` binary from `tests/hash/` via CMake on startup (background, non-blocking)
- Serves an HTML dashboard at `/`
- Exposes `/api/status` (build state + test list), `/api/build-log`, and `POST /api/run-tests` (runs the binary, returns parsed results)

No external credentials or services are needed — the hash tests are fully offline.

## Build
- `Dockerfile.base44`: `node:22-bookworm` + `cmake` + `build-essential` (build tools only, no app code baked in)
- `docker-compose.base44.yml`: bind-mounts source at `/app`, runs `node server.js`
- The hash-tests CMake target (`tests/hash/CMakeLists.txt`) is self-contained — uses bundled 3rdparty libs (argon2, fmt, etc.), needs only cmake + gcc, no hwloc/openssl/libuv

## Verify
- `curl localhost:3000/api/status` → `{"buildStatus":"ready",...}`
- `curl -X POST localhost:3000/api/run-tests` → all tests pass (exit code 0)
- Full xmrig binary build (not used by the dashboard) needs: `libhwloc-dev libssl-dev libuv1-dev`

## Test commands (outside Docker)
```bash
cmake -S tests/hash -B build/hash-tests -DCMAKE_BUILD_TYPE=Release
cmake --build build/hash-tests --parallel 4
./build/hash-tests/hash-tests --suite small --verbose
# Or via the project's test runner:
node run_tests.js --safe --build-dir build
```
