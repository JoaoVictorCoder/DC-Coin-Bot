// tempTunnel.js
// Start a temporary "quick" Cloudflare tunnel (TryCloudflare) without login:
//   cloudflared tunnel --url http://<localHost>:<port>
//
// Behavior:
// - Enabled only when env TEMP_TUNNEL_ENABLED or CLOUDFLARE_QUICK_ENABLED is truthy.
// - Detects a cloudflared binary per OS/arch from ./cloudflared/* or uses PATH.
// - Captures the generated trycloudflare URL from stdout and returns it.
// - Exports startTempTunnel(opts) and stopTempTunnel().

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_DIR = path.join(__dirname);
const LOCAL_CF_DIR = path.join(PROJECT_DIR, 'cloudflared');

let _child = null;
let _lastUrl = null;

/* --- Binary detection (same scheme as cloudflared.js) --- */
/* See your cloudflared helper for reference. */ 
function mapCandidates(platform, arch) {
  const map = {
    win32: {
      x64: 'cloudflared-windows-amd64.exe',
      ia32: 'cloudflared-windows-386.exe',
      arm64: 'cloudflared-windows-arm64.exe'
    },
    linux: {
      x64: 'cloudflared-linux-amd64',
      arm64: 'cloudflared-linux-arm64',
      ia32: 'cloudflared-linux-386'
    },
    darwin: {
      x64: 'cloudflared-darwin-amd64',
      arm64: 'cloudflared-darwin-arm64'
    }
  };

  const candidates = [];
  if (map[platform] && map[platform][arch]) candidates.push(path.join(LOCAL_CF_DIR, map[platform][arch]));
  candidates.push(path.join(LOCAL_CF_DIR, `cloudflared-${platform}-${arch}`));
  candidates.push(path.join(LOCAL_CF_DIR, `cloudflared-${platform}`));
  candidates.push(path.join(LOCAL_CF_DIR, 'cloudflared'));
  candidates.push('cloudflared'); // fallback to PATH
  return candidates;
}

function ensureExecutable(p) {
  if (process.platform === 'win32') return;
  try { fs.chmodSync(p, 0o755); } catch (e) {}
}

function findBinary() {
  const platform = process.platform;
  const arch = process.arch;
  const candidates = mapCandidates(platform, arch);
  for (const c of candidates) {
    try {
      if (c === 'cloudflared') return c;
      if (fs.existsSync(c)) { ensureExecutable(c); return c; }
    } catch (e) { /* ignore */ }
  }
  return null;
}

/* --- Helpers --- */
function truthyEnv(name) {
  const v = process.env[name];
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/* --- Public API --- */
/**
 * startTempTunnel(opts)
 * opts:
 *  - port: local port to expose (default: process.env.TEMP_TUNNEL_PORT || 3000)
 *  - localHost: host to bind (default: process.env.TEMP_TUNNEL_LOCAL_HOST || '127.0.0.1')
 *  - bin: optional explicit cloudflared binary path
 *  - waitForUrlMs: how long to wait for trycloudflare URL to appear (default 12000 ms)
 *
 * Returns Promise<{ child, urlHint }>
 */
function startTempTunnel(opts = {}) {
  const envEnabled = truthyEnv('TEMP_TUNNEL_ENABLED') || truthyEnv('CLOUDFLARE_QUICK_ENABLED');
  if (!envEnabled) {
    return Promise.resolve({ child: null, urlHint: null, disabled: true });
  }

  if (_child) {
    return Promise.resolve({ child: _child, urlHint: _lastUrl });
  }

  const port = opts.port || process.env.TEMP_TUNNEL_PORT || process.env.PORT || '3000';
  const host = opts.localHost || process.env.TEMP_TUNNEL_LOCAL_HOST || '127.0.0.1';
  const waitForUrlMs = typeof opts.waitForUrlMs === 'number' ? opts.waitForUrlMs : 12000;

  const bin = opts.bin || findBinary();
  if (!bin) {
    return Promise.reject(new Error('cloudflared binary not found (place binary in ./cloudflared or install in PATH).'));
  }

  // Build args: cloudflared tunnel --url http://<host>:<port>
  const url = `http://${host}:${port}`;
  const args = ['tunnel', '--url', url];

  const spawnOpts = { cwd: LOCAL_CF_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env) };

  return new Promise((resolve, reject) => {
    try {
      const child = spawn(bin, args, spawnOpts);
      _child = child;
      _lastUrl = null;

      let stdoutAccum = '';
      let stderrAccum = '';

      const urlRegex = /(https?:\/\/[^\s]+\.trycloudflare\.com)/i;

      const tmo = setTimeout(() => {
        // timeout waiting for printed URL — still resolve with child but no urlHint
        clearListeners();
        resolve({ child, urlHint: _lastUrl });
      }, waitForUrlMs);

      function clearListeners() {
        try {
          child.stdout && child.stdout.removeAllListeners('data');
          child.stderr && child.stderr.removeAllListeners('data');
        } catch (e) {}
        clearTimeout(tmo);
      }

      child.stdout && child.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(`[cloudflared] ${text}`);
        stdoutAccum += text;

        // try to capture trycloudflare url
        const m = text.match(urlRegex);
        if (m && m[0]) {
          _lastUrl = m[0];
          clearListeners();
          resolve({ child, urlHint: _lastUrl });
        }
      });

      child.stderr && child.stderr.on('data', (d) => {
        const text = d.toString();
        process.stderr.write(`[cloudflared-err] ${text}`);
        stderrAccum += text;

        // sometimes URL can appear in stderr; check there too
        const m = text.match(urlRegex);
        if (m && m[0]) {
          _lastUrl = m[0];
          clearListeners();
          resolve({ child, urlHint: _lastUrl });
        }

        // if cloudflared exits with an immediate error about credentials or config, bubble it
        if (/Cannot determine default configuration path|No ingress rules were defined|accepts only one argument|error/i.test(text)) {
          // don't reject immediately — many messages are warnings; but if child exits later we'll handle
        }
      });

      child.on('error', (err) => {
        clearListeners();
        _child = null;
        reject(err);
      });

      child.on('exit', (code, sig) => {
        clearListeners();
        // if resolved already, just log
        console.log(`[cloudflared] temp tunnel exited (code=${code}, signal=${sig})`);
        _child = null;
        // if exited before producing url and still not resolved, reject
        if (!_lastUrl) {
          reject(new Error(`cloudflared temp tunnel exited early (code=${code}). stderr: ${stderrAccum}`));
        }
      });

    } catch (err) {
      _child = null;
      reject(err);
    }
  });
}

/** stopTempTunnel() - kills running quick tunnel if any */
function stopTempTunnel() {
  if (_child && !_child.killed) {
    try {
      _child.kill();
      _child = null;
      _lastUrl = null;
      console.log('[tempTunnel] cloudflared quick tunnel stopped');
      return true;
    } catch (e) {
      console.warn('[tempTunnel] failed to stop child', e);
      return false;
    }
  }
  return false;
}

module.exports = {
  startTempTunnel,
  stopTempTunnel,
};
