// cloudflared.js (corrigido - escreve config/credentials em ~/.cloudflared e usa apenas "cloudflared tunnel run <ID>")
// - evita passar --config (usuário pediu apenas ID)
// - garante que ~/.cloudflared/config.yml exista e que o credentials JSON esteja lá
// - executa: cloudflared tunnel run <TUNNEL_ID>
// - fornece logs claros sobre o que foi criado/copied

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PROJECT_DIR = path.join(__dirname);
const C_DIR = path.join(PROJECT_DIR, 'cloudflared'); // local project folder (optional)
let _child = null;

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

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
  if (map[platform] && map[platform][arch]) {
    candidates.push(path.join(C_DIR, map[platform][arch]));
  }
  candidates.push(path.join(C_DIR, `cloudflared-${platform}-${arch}`));
  candidates.push(path.join(C_DIR, `cloudflared-${platform}`));
  candidates.push(path.join(C_DIR, 'cloudflared'));
  candidates.push('cloudflared'); // PATH fallback
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
    } catch (e) {}
  }
  return null;
}

/** Resolve caminho da credencial (procurando primeiro env, depois ./cloudflared, depois home .cloudflared) */
function getCredentialsPath() {
  const envPath = process.env.CLOUDFLARE_CREDENTIALS;
  if (envPath) {
    const absolute = path.isAbsolute(envPath) ? envPath : path.join(PROJECT_DIR, envPath);
    if (fs.existsSync(absolute)) return absolute;
    const inside = path.join(C_DIR, envPath);
    if (fs.existsSync(inside)) return inside;
    const homeInside = path.join(os.homedir(), '.cloudflared', envPath);
    if (fs.existsSync(homeInside)) return homeInside;
  }

  // common names inside project ./cloudflared
  const candidatesLocal = ['credentials.json', 'credentials-file.json', 'tunnel.json'];
  for (const n of candidatesLocal) {
    const p = path.join(C_DIR, n);
    if (fs.existsSync(p)) return p;
  }

  // common names inside home ~/.cloudflared
  const homeDir = path.join(os.homedir(), '.cloudflared');
  for (const n of candidatesLocal) {
    const p = path.join(homeDir, n);
    if (fs.existsSync(p)) return p;
  }

  // any .json in ./cloudflared
  if (fs.existsSync(C_DIR)) {
    const files = fs.readdirSync(C_DIR).filter(f => f.endsWith('.json'));
    if (files.length) return path.join(C_DIR, files[0]);
  }

  // any .json in ~/.cloudflared
  if (fs.existsSync(homeDir)) {
    const files = fs.readdirSync(homeDir).filter(f => f.endsWith('.json'));
    if (files.length) return path.join(homeDir, files[0]);
  }

  return null;
}

/** Ensure config.yml exists in the REAL default path: ~/.cloudflared/config.yml
 *  Also ensure that the credentials JSON is present inside ~/.cloudflared (copy if needed)
 */
function ensureHomeConfig(tunnelName, hostname, port, credentialsAbsolutePath) {
  const homeDir = path.join(os.homedir(), '.cloudflared');
  ensureDir(homeDir);

  const cfgPath = path.join(homeDir, 'config.yml');

  const credsFrom = credentialsAbsolutePath || getCredentialsPath();
  if (!credsFrom) {
    // do not throw — caller may still want to run without config
    return { cfgPath: null, credsPath: null, warning: 'no credentials JSON found to write into home .cloudflared' };
  }

  // copy credentials into homeDir with same basename
  const credsBasename = path.basename(credsFrom);
  const credsDest = path.join(homeDir, credsBasename);
  try {
    if (path.resolve(credsFrom) !== path.resolve(credsDest)) {
      fs.copyFileSync(credsFrom, credsDest);
      // set permissive read for user
      try { fs.chmodSync(credsDest, 0o600); } catch (e) {}
      console.log(`[cloudflared] credentials copied to ${credsDest}`);
    } else {
      console.log(`[cloudflared] credentials already in home .cloudflared: ${credsDest}`);
    }
  } catch (e) {
    console.warn('[cloudflared] failed to copy credentials to home .cloudflared:', e && e.message ? e.message : e);
    // continue — maybe cloudflared will read it from original location
  }

  // If config already exists, return it (do NOT overwrite existing config to avoid stomping user's custom rules)
  if (fs.existsSync(cfgPath)) {
    console.log(`[cloudflared] found existing home config: ${cfgPath} (not overwriting)`); 
    return { cfgPath, credsPath: credsDest };
  }

  // generate config.yml that references the credentials file inside homeDir
  const content = [
    `tunnel: ${tunnelName}`,
    `credentials-file: ${credsDest}`,
    '',
    'ingress:',
    hostname ? `  - hostname: ${hostname}\n    service: http://localhost:${port}` : '',
    '  - service: http_status:404',
    ''
  ].filter(Boolean).join('\n');

  try {
    fs.writeFileSync(cfgPath, content, { encoding: 'utf8' });
    try { fs.chmodSync(cfgPath, 0o600); } catch (e) {}
    console.log(`[cloudflared] wrote home config: ${cfgPath}`);
    return { cfgPath, credsPath: credsDest };
  } catch (e) {
    console.warn('[cloudflared] failed to write home config:', e && e.message ? e.message : e);
    return { cfgPath: null, credsPath: credsDest, warning: 'failed to write home config' };
  }
}

/**
 * startTunnel(opts)
 * opts:
 *  - tunnelName (required or from CLOUDFLARE_TUNNEL_NAME)
 *  - hostname (optional or from CLOUDFLARE_HOSTNAME) -> used to generate ingress rule in ~/.cloudflared/config.yml
 *  - port (default process.env.PORT || 3000)
 *  - waitForReadyMs (default 15000)
 *
 * Note: runs "cloudflared tunnel run <tunnelName>" (only ID argument)
 */
function startTunnel(opts = {}) {
  const enabledEnv = process.env.CLOUDFLARE_ENABLED;
  if (typeof enabledEnv === 'string') {
    const v = enabledEnv.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no') {
      console.log('[cloudflared] CLOUDFLARE_ENABLED=false — pulando start.');
      return Promise.resolve({ child: null, urlHint: null, disabled: true });
    }
  }

  ensureDir(C_DIR);

  const tunnelName = opts.tunnelName || process.env.CLOUDFLARE_TUNNEL_NAME;
  const hostname = opts.hostname || process.env.CLOUDFLARE_HOSTNAME;
  const port = opts.port || process.env.PORT || 3000;
  const waitForReadyMs = typeof opts.waitForReadyMs === 'number' ? opts.waitForReadyMs : 15000;

  if (!tunnelName) {
    return Promise.reject(new Error('tunnelName is required (pass via opts.tunnelName or env CLOUDFLARE_TUNNEL_NAME)'));
  }

  // Ensure home config + credentials exist (so cloudflared will pick them up when run without --config)
  const credsFound = getCredentialsPath();
  const ensureResult = ensureHomeConfig(tunnelName, hostname, port, credsFound);
  if (ensureResult.warning) {
    console.warn('[cloudflared] ensureHomeConfig warning:', ensureResult.warning);
  }

  const bin = findBinary();
  if (!bin) {
    return Promise.reject(new Error('cloudflared binary não encontrado (coloque na pasta ./cloudflared ou instale globalmente).'));
  }

  const spawnOpts = {
    cwd: C_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env) // inherit env
  };

  // Only ID/name as argument
  const args = ['tunnel', 'run', tunnelName];

  let stderrAccum = '';
  return new Promise((resolve, reject) => {
    let resolved = false;

    try {
      const child = spawn(bin, args, spawnOpts);
      _child = child;

      const readyMatcher = /(Registered tunnel connection|Connected to Cloudflare|Connection established|Tunnel .* established|Started tunnel|Tunnel is running|tunnel .* run)/i;
      const urlMatcher = /(https?:\/\/[^\s]+\.trycloudflare\.com)/i;

      const readyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ child, urlHint: null, warning: 'timeout waiting for ready logs' });
        }
      }, waitForReadyMs);

      child.stdout.on('data', (d) => {
        const text = d.toString();
        process.stdout.write(`[cloudflared] ${text}`);
        if (!resolved && readyMatcher.test(text)) {
          clearTimeout(readyTimer);
          resolved = true;
          const m = text.match(urlMatcher);
          resolve({ child, urlHint: m ? m[0] : null });
        }
      });

      child.stderr.on('data', (d) => {
        const text = d.toString();
        stderrAccum += text;
        process.stderr.write(`[cloudflared-err] ${text}`);

        // If cloudflared warns about missing ingress (503), surface that clearly but keep running
        if (/No ingress rules were defined/i.test(text)) {
          console.warn('[cloudflared] aviso: nenhuma ingress rule definida — o tunnel ficará no ar mas responderá 503 para HTTP.');
          // not rejecting — user may want the tunnel up for other protocols
        }

        // If cloudflared reports cannot determine default config path, show explicit help
        if (/Cannot determine default configuration path/i.test(text)) {
          console.warn('[cloudflared] aviso: cloudflared não encontrou config.yml em ~/.cloudflared — o módulo tentou copiar/criar lá.');
        }

        if (!resolved && readyMatcher.test(text)) {
          clearTimeout(readyTimer);
          resolved = true;
          const m = text.match(urlMatcher);
          resolve({ child, urlHint: m ? m[0] : null });
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      child.on('exit', (code, sig) => {
        if (resolved) {
          console.log(`[cloudflared] exited (code=${code}, signal=${sig})`);
          return;
        }
        const msg = new Error(`cloudflared exited early (code=${code}, signal=${sig}). stderr: ${stderrAccum}`);
        resolved = true;
        reject(msg);
      });

    } catch (err) {
      return reject(err);
    }
  });
}

function stopTunnel() {
  if (_child && !_child.killed) {
    try {
      _child.kill();
      _child = null;
      console.log('[cloudflared] child killed');
      return true;
    } catch (e) {
      console.error('[cloudflared] failed to kill child', e);
      return false;
    }
  }
  return false;
}

module.exports = {
  startTunnel,
  stopTunnel,
  CLOUD_DIR: C_DIR,
  PROJECT_DIR
};
