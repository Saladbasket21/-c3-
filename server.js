#!/usr/bin/env node
"use strict";

const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PORT = 3000;
const ROOT = __dirname;
const HASH_BINARY = path.join(ROOT, "build", "hash-tests", "hash-tests");
const BUILD_DIR = path.join(ROOT, "build", "hash-tests");

// --- Build state ---
let buildStatus = "pending"; // pending | building | ready | failed
let buildLog = "";

function buildHashTests() {
    buildStatus = "building";
    buildLog = "";

    const cmakeArgs = [
        "-S", path.join(ROOT, "tests", "hash"),
        "-B", BUILD_DIR,
        "-DCMAKE_BUILD_TYPE=Release",
    ];

    const configure = spawnSync("cmake", cmakeArgs, {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120000,
    });
    buildLog += configure.stdout || "";
    buildLog += configure.stderr || "";
    if (configure.status !== 0) {
        buildStatus = "failed";
        buildLog += `\ncmake configure exited with status ${configure.status}\n`;
        return;
    }

    const build = spawnSync("cmake", ["--build", BUILD_DIR, "--parallel", "4"], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 300000,
    });
    buildLog += build.stdout || "";
    buildLog += build.stderr || "";
    if (build.status !== 0) {
        buildStatus = "failed";
        buildLog += `\ncmake build exited with status ${build.status}\n`;
        return;
    }

    if (fs.existsSync(HASH_BINARY)) {
        buildStatus = "ready";
        buildLog += "\nBuild complete.\n";
    } else {
        buildStatus = "failed";
        buildLog += `\nBinary not found at ${HASH_BINARY}\n`;
    }
}

// Start build in background
setTimeout(buildHashTests, 100);

// --- API helpers ---
function getTestCases() {
    if (buildStatus !== "ready" || !fs.existsSync(HASH_BINARY)) {
        return [];
    }
    const result = spawnSync(HASH_BINARY, ["--list", "--suite", "small"], {
        encoding: "utf8",
        timeout: 10000,
    });
    if (result.status !== 0) return [];
    return result.stdout.trim().split("\n").filter(Boolean);
}

function runHashTests(suite) {
    return new Promise((resolve) => {
        const args = ["--suite", suite || "small", "--verbose"];
        const child = spawn(HASH_BINARY, args, {
            cwd: ROOT,
            encoding: "utf8",
            timeout: 120000,
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (d) => { stdout += d; });
        child.stderr.on("data", (d) => { stderr += d; });

        child.on("close", (code) => {
            resolve({ exitCode: code, stdout, stderr });
        });

        child.on("error", (err) => {
            resolve({ exitCode: -1, stdout, stderr: String(err) });
        });
    });
}

function parseTestResults(stdout, stderr) {
    const results = [];
    const lines = (stdout + "\n" + stderr).split("\n");

    let currentTest = null;
    for (const line of lines) {
        const okMatch = line.match(/^ok\s+(.+)/);
        const failMatch = line.match(/^FAIL\s+(.+)/);

        if (okMatch) {
            results.push({ name: okMatch[1].trim(), status: "pass" });
            currentTest = null;
        } else if (failMatch) {
            const name = failMatch[1].trim();
            // The name might include sub-check info after a colon
            const testName = name.split(":")[0].trim();
            results.push({ name: testName, status: "fail", detail: name });
            currentTest = testName;
        }
    }

    // Deduplicate: keep first occurrence of each name
    const seen = new Set();
    return results.filter((r) => {
        if (seen.has(r.name)) return false;
        seen.add(r.name);
        return true;
    });
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboard());
        return;
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            buildStatus,
            binaryExists: fs.existsSync(HASH_BINARY),
            testCases: buildStatus === "ready" ? getTestCases() : [],
        }));
        return;
    }

    if (url.pathname === "/api/build-log" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(buildLog);
        return;
    }

    if (url.pathname === "/api/run-tests" && req.method === "POST") {
        if (buildStatus !== "ready") {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Binary not built yet" }));
            return;
        }

        const suite = url.searchParams.get("suite") || "small";
        const result = await runHashTests(suite);
        const tests = parseTestResults(result.stdout, result.stderr);
        const passed = tests.filter((t) => t.status === "pass").length;
        const failed = tests.filter((t) => t.status === "fail").length;

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            exitCode: result.exitCode,
            passed,
            failed,
            total: tests.length,
            tests,
            rawOutput: result.stdout + (result.stderr ? "\n--- stderr ---\n" + result.stderr : ""),
        }));
        return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
});

function renderDashboard() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XMRig — Hash Test Dashboard</title>
<style>
  :root {
    --bg: #0d1117;
    --card: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --orange: #d29922;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 24px;
  }
  .container { max-width: 900px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 32px; }
  header h1 { font-size: 28px; font-weight: 600; margin-bottom: 4px; }
  header h1 .accent { color: var(--accent); }
  header p { color: var(--muted); font-size: 14px; }
  .version-badge {
    display: inline-block;
    background: var(--border);
    color: var(--accent);
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 600;
    margin-top: 8px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 20px;
  }
  .card h2 { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-dot.pending { background: var(--muted); }
  .status-dot.building { background: var(--orange); animation: pulse 1s infinite; }
  .status-dot.ready { background: var(--green); }
  .status-dot.failed { background: var(--red); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .status-text { font-size: 14px; }
  .btn {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 10px 24px;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.secondary { background: var(--border); color: var(--text); }
  .btn-row { display: flex; gap: 10px; margin-top: 12px; }
  .test-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 6px;
  }
  .test-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    font-size: 13px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    background: rgba(255,255,255,0.03);
  }
  .test-item .icon { font-size: 14px; }
  .test-item.pass .icon { color: var(--green); }
  .test-item.fail .icon { color: var(--red); }
  .test-item.pending .icon { color: var(--muted); }
  .test-item.fail { background: rgba(248,81,73,0.1); }
  .summary {
    display: flex;
    gap: 20px;
    margin-bottom: 16px;
    font-size: 14px;
  }
  .summary .stat { display: flex; align-items: center; gap: 6px; }
  .summary .stat .num { font-size: 20px; font-weight: 700; }
  .summary .pass .num { color: var(--green); }
  .summary .fail .num { color: var(--red); }
  .summary .total .num { color: var(--text); }
  pre {
    background: #0d1117;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    font-size: 12px;
    font-family: 'SF Mono', Monaco, Consolas, monospace;
    overflow-x: auto;
    max-height: 300px;
    overflow-y: auto;
    white-space: pre-wrap;
    color: var(--muted);
  }
  .hidden { display: none; }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--muted);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .info-list { font-size: 13px; color: var(--muted); line-height: 1.8; }
  .info-list strong { color: var(--text); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span class="accent">XM</span>Rig</h1>
    <p>High-performance RandomX, CryptoNight &amp; Argon2 miner — Hash Test Dashboard</p>
    <span class="version-badge">v6.26.0-C7</span>
  </header>

  <div class="card">
    <h2>Build Status</h2>
    <div class="status-row">
      <span class="status-dot pending" id="build-dot"></span>
      <span class="status-text" id="build-text">Waiting to build...</span>
    </div>
    <div class="btn-row">
      <button class="btn secondary" id="show-log">Show Build Log</button>
    </div>
    <pre class="hidden" id="build-log"></pre>
  </div>

  <div class="card">
    <h2>Hash Tests</h2>
    <p style="color:var(--muted);font-size:13px;margin-bottom:12px;">
      Runs the offline CPU hash suite — verifies known-answer vectors for all
      supported algorithms (CryptoNight, RandomX, Argon2, GhostRider, Flex, Panthera).
    </p>
    <div class="btn-row">
      <button class="btn" id="run-tests" disabled>Run Hash Tests</button>
    </div>
    <div class="hidden" id="results-section" style="margin-top:16px;">
      <div class="summary">
        <div class="stat pass"><span class="num" id="pass-count">0</span> passed</div>
        <div class="stat fail"><span class="num" id="fail-count">0</span> failed</div>
        <div class="stat total"><span class="num" id="total-count">0</span> total</div>
      </div>
      <div class="test-grid" id="test-grid"></div>
      <div class="btn-row">
        <button class="btn secondary" id="show-output">Show Raw Output</button>
      </div>
      <pre class="hidden" id="raw-output"></pre>
    </div>
  </div>

  <div class="card">
    <h2>Project Info</h2>
    <div class="info-list">
      <div><strong>Name:</strong> XMRig</div>
      <div><strong>Version:</strong> 6.26.0-C7</div>
      <div><strong>Description:</strong> RandomX, CryptoNight, Argon2, GhostRider &amp; Flex CPU/GPU miner</div>
      <div><strong>Build system:</strong> CMake (C++11)</div>
      <div><strong>Test binary:</strong> tests/hash/main.cpp → build/hash-tests/hash-tests</div>
      <div><strong>Source:</strong> <a href="https://github.com/xmrig/xmrig" style="color:var(--accent);">github.com/xmrig/xmrig</a></div>
    </div>
  </div>
</div>

<script>
const buildDot = document.getElementById('build-dot');
const buildText = document.getElementById('build-text');
const runBtn = document.getElementById('run-tests');
const showLogBtn = document.getElementById('show-log');
const buildLogEl = document.getElementById('build-log');

async function pollStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    buildDot.className = 'status-dot ' + data.buildStatus;
    const labels = {
      pending: 'Waiting to build...',
      building: 'Building hash-tests binary...',
      ready: 'Build complete — ready to run tests',
      failed: 'Build failed — check log',
    };
    buildText.textContent = labels[data.buildStatus] || data.buildStatus;

    if (data.buildStatus === 'ready') {
      runBtn.disabled = false;
    } else {
      runBtn.disabled = true;
    }
    if (data.buildStatus === 'building' || data.buildStatus === 'pending') {
      setTimeout(pollStatus, 2000);
    }
  } catch {
    setTimeout(pollStatus, 3000);
  }
}
pollStatus();

showLogBtn.addEventListener('click', async () => {
  if (buildLogEl.classList.contains('hidden')) {
    const res = await fetch('/api/build-log');
    buildLogEl.textContent = await res.text();
    buildLogEl.classList.remove('hidden');
    showLogBtn.textContent = 'Hide Build Log';
  } else {
    buildLogEl.classList.add('hidden');
    showLogBtn.textContent = 'Show Build Log';
  }
});

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  runBtn.innerHTML = '<span class="spinner"></span> Running...';
  document.getElementById('results-section').classList.add('hidden');

  try {
    const res = await fetch('/api/run-tests', { method: 'POST' });
    const data = await res.json();

    if (data.error) {
      alert(data.error);
      return;
    }

    document.getElementById('pass-count').textContent = data.passed;
    document.getElementById('fail-count').textContent = data.failed;
    document.getElementById('total-count').textContent = data.total;

    const grid = document.getElementById('test-grid');
    grid.innerHTML = '';
    for (const t of data.tests) {
      const div = document.createElement('div');
      div.className = 'test-item ' + t.status;
      const icon = t.status === 'pass' ? '✓' : '✗';
      div.innerHTML = '<span class="icon">' + icon + '</span><span>' + t.name + '</span>';
      grid.appendChild(div);
    }

    document.getElementById('raw-output').textContent = data.rawOutput || '';
    document.getElementById('results-section').classList.remove('hidden');
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    runBtn.disabled = false;
    runBtn.textContent = 'Run Hash Tests';
  }
});

document.getElementById('show-output').addEventListener('click', function() {
  const el = document.getElementById('raw-output');
  if (el.classList.contains('hidden')) {
    el.classList.remove('hidden');
    this.textContent = 'Hide Raw Output';
  } else {
    el.classList.add('hidden');
    this.textContent = 'Show Raw Output';
  }
});
</script>
</body>
</html>`;
}

server.listen(PORT, "0.0.0.0", () => {
    console.log(`XMRig hash test dashboard running on http://0.0.0.0:${PORT}`);
});
