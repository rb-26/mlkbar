// Starts a throwaway mlkbar server (fresh temp data folder) and loads pages in jsdom.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const servers = [];

/** Copy server.py + public/ into a temp folder and start it. `authed` skips the login check. */
async function startServer({ port, authed = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mlkbar-test-"));
  fs.copyFileSync(path.join(ROOT, "server.py"), path.join(dir, "server.py"));
  fs.cpSync(path.join(ROOT, "public"), path.join(dir, "public"), {
    recursive: true,
    filter: src => !/(^|\/)(\._|\.smbdelete)/.test(src)
  });
  const code = [
    "import server",
    authed ? "server.is_authenticated = lambda: True" : "",
    `server.app.run(host="127.0.0.1", port=${port}, threaded=True)`
  ].join("\n");
  const proc = spawn(process.env.PYTHON || "python3", ["-c", code], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", d => { log += d; });
  proc.stderr.on("data", d => { log += d; });
  const server = { base: `http://127.0.0.1:${port}`, dir, proc, log: () => log };
  servers.push(server);
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(server.base + "/healthz");
      if (response.ok) return server;
    } catch {}
    if (proc.exitCode !== null) break;
    await sleep(250);
  }
  throw new Error("Server did not start:\n" + log);
}

function stopServers() {
  for (const server of servers) {
    try { server.proc.kill(); } catch {}
    try { fs.rmSync(server.dir, { recursive: true, force: true }); } catch {}
  }
}

/** Load public/<file> with app.js, wired to the test server. Returns the window. */
async function loadPage(server, file, { wait = 1000, before = null } = {}) {
  const publicDir = path.join(server.dir, "public");
  const html = fs.readFileSync(path.join(publicDir, file), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
  const dom = new JSDOM(html, { url: server.base + "/" + file, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = (url, options = {}) => fetch(new URL(url, server.base).toString(), options);
  w.confirm = () => true;
  w.alert = () => {};
  w.scrollTo = () => {};
  w._errors = [];
  w.addEventListener("error", event => w._errors.push(event.message));
  // Navigations (location.replace / href) are recorded instead of followed.
  w._navigations = [];
  if (before) before(w);
  // Run the page's own scripts in order (e.g. who-growth.js before app.js).
  const original = fs.readFileSync(path.join(publicDir, file), "utf8");
  const scripts = [...original.matchAll(/<script[^>]*src="\/([^"?]+)[^"]*"[^>]*><\/script>/g)].map(m => m[1]);
  for (const script of scripts) {
    try {
      w.eval(fs.readFileSync(path.join(publicDir, script), "utf8"));
    } catch (error) {
      w._errors.push(`${script}: ${error}`);
    }
  }
  await sleep(wait);
  return w;
}

async function api(server, url, options = {}) {
  const response = await fetch(server.base + url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

module.exports = { startServer, stopServers, loadPage, api, sleep };
