/**
 * Remote bootstrap -- all idempotent.
 */
import type { SshSession } from "./ssh.ts";

export const SERVICE_USER = "vela";
export const INSTALL_ROOT = "/opt/vela-bundler";
export const DATA_DIR = `${INSTALL_ROOT}/data`;
export const ENV_FILE = `${DATA_DIR}/vela.env`;
export const RELEASES_DIR = `${INSTALL_ROOT}/releases`;
export const CURRENT_LINK = `${INSTALL_ROOT}/current`;

function sh(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export async function probeRemote(ssh: SshSession) {
  const deno = await ssh.runCapture([
    "bash", "-lc",
    'for p in /usr/local/bin/deno /usr/bin/deno; do if [ -x "$p" ]; then "$p" --version; exit 0; fi; done; exit 1',
  ]);
  const systemd = await ssh.runCapture(["bash", "-lc", "command -v systemctl"]);
  const current = await ssh.runCapture(["bash", "-lc", `test -L ${sh(CURRENT_LINK)}`]);
  return {
    denoInstalled: deno.code === 0 && /^deno [\d.]+/m.test(deno.stdout),
    denoVersion: deno.stdout.match(/^deno ([\d.]+)/m)?.[1],
    systemdAvailable: systemd.code === 0,
    firstTime: current.code !== 0,
  };
}

export async function installDeno(ssh: SshSession): Promise<void> {
  const code = await ssh.runShell(`
    set -e
    TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
    curl -fsSL https://deno.land/install.sh -o "$TMP"
    sudo -n env DENO_INSTALL=/usr/local sh "$TMP" --yes || sudo env DENO_INSTALL=/usr/local sh "$TMP" --yes
    sudo chmod 0755 /usr/local/bin/deno
    /usr/local/bin/deno --version
  `);
  if (code !== 0) throw new Error("Deno install failed");
}

export async function ensureServiceUser(ssh: SshSession): Promise<void> {
  const code = await ssh.runShell(`
    set -e
    if ! id -u ${SERVICE_USER} >/dev/null 2>&1; then
      sudo useradd --system --create-home --shell /usr/sbin/nologin --home-dir /var/lib/${SERVICE_USER} ${SERVICE_USER}
    fi
  `);
  if (code !== 0) throw new Error(`failed to ensure user ${SERVICE_USER}`);
}

export async function ensureDirectories(ssh: SshSession): Promise<void> {
  const code = await ssh.runShell(`
    set -e
    sudo mkdir -p ${sh(INSTALL_ROOT)} ${sh(RELEASES_DIR)} \
      ${sh(DATA_DIR)} ${sh(DATA_DIR + "/cache")} ${sh(DATA_DIR + "/cache/deno")}
    sudo chown -R ${SERVICE_USER}:${SERVICE_USER} ${sh(DATA_DIR)}
    sudo chmod 0750 ${sh(DATA_DIR)}
    sudo chown root:root ${sh(INSTALL_ROOT)}
    sudo chmod 0755 ${sh(INSTALL_ROOT)}
  `);
  if (code !== 0) throw new Error("failed to create directories");
}

export async function ensureEnvFile(ssh: SshSession): Promise<void> {
  const code = await ssh.runShell(`
    set -e
    if [ ! -f ${sh(ENV_FILE)} ]; then
      sudo install -o ${SERVICE_USER} -g ${SERVICE_USER} -m 0600 /dev/null ${sh(ENV_FILE)}
    fi
    sudo chown ${SERVICE_USER}:${SERVICE_USER} ${sh(ENV_FILE)}
    sudo chmod 0600 ${sh(ENV_FILE)}
  `);
  if (code !== 0) throw new Error("failed to ensure env file");
}

/**
 * Check if the env file has been configured (not placeholder values).
 */
export async function isEnvConfigured(ssh: SshSession): Promise<boolean> {
  const result = await ssh.runCapture([
    "bash", "-lc",
    `sudo cat ${sh(ENV_FILE)} 2>/dev/null || echo ''`,
  ]);
  const content = result.stdout;
  if (!content || content.includes("CHANGE_ME")) return false;
  if (!content.includes("OPERATOR_SECRET=")) return false;
  if (!content.includes("TREASURY_ADDRESS=")) return false;
  return true;
}

/**
 * Read the current env file contents.
 */
export async function readEnvFile(ssh: SshSession): Promise<string> {
  const result = await ssh.runCapture([
    "bash", "-lc",
    `sudo cat ${sh(ENV_FILE)} 2>/dev/null || echo ''`,
  ]);
  return result.stdout;
}

/**
 * Write env configuration to the remote env file.
 */
export async function writeEnvFile(
  ssh: SshSession,
  envVars: Record<string, string>,
): Promise<void> {
  const lines = Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const b64 = btoa(lines + "\n");
  const code = await ssh.runShell(`
    set -e
    printf '%s' '${b64}' | base64 -d | sudo tee ${sh(ENV_FILE)} >/dev/null
    sudo chown ${SERVICE_USER}:${SERVICE_USER} ${sh(ENV_FILE)}
    sudo chmod 0600 ${sh(ENV_FILE)}
  `);
  if (code !== 0) throw new Error("failed to write env file");
}

export async function installSudoers(ssh: SshSession, deployUser: string): Promise<void> {
  const unit = "vela-bundler";
  const content = [
    `# Allow ${deployUser} to manage vela-bundler without password.`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/systemctl start ${unit}*`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/systemctl stop ${unit}*`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/systemctl restart ${unit}*`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/systemctl enable ${unit}*`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/systemctl status ${unit}*`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/systemctl daemon-reload`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/ln -sfn ${RELEASES_DIR}/* ${CURRENT_LINK}`,
    `${deployUser} ALL=(root) NOPASSWD: /bin/rm -rf ${RELEASES_DIR}/*`,
    "",
  ].join("\n");
  const b64 = btoa(content);
  const code = await ssh.runShell(`
    set -e
    printf '%s' '${b64}' | base64 -d > /tmp/vela-sudoers.tmp
    chmod 0440 /tmp/vela-sudoers.tmp
    sudo visudo -cf /tmp/vela-sudoers.tmp
    sudo mv /tmp/vela-sudoers.tmp /etc/sudoers.d/vela-bundler
    sudo chown root:root /etc/sudoers.d/vela-bundler
  `);
  if (code !== 0) throw new Error("sudoers install failed");
}

export async function uploadRelease(
  ssh: SshSession,
  repoRoot: string,
  releaseDir: string,
): Promise<void> {
  const isMac = Deno.build.os === "darwin";
  const tarArgs = ["-czf", "-", "-C", repoRoot];
  if (isMac) tarArgs.push("--no-mac-metadata");
  tarArgs.push("shared", "deno", "deno.json");

  const tarProc = new Deno.Command("tar", {
    args: tarArgs,
    stdin: "null", stdout: "piped", stderr: "piped",
  }).spawn();

  await ssh.runShell(`mkdir -p ${sh(releaseDir)}`, { stdio: "null" });
  const extractCode = await ssh.runWithStdin(
    ["tar", "-xzf", "-", "-C", releaseDir],
    tarProc.stdout,
  );
  const tarStatus = await tarProc.status;
  if (tarStatus.code !== 0) {
    const stderr = await new Response(tarProc.stderr).text();
    throw new Error(`local tar failed (exit ${tarStatus.code}): ${stderr.trim()}`);
  }
  if (extractCode !== 0) {
    throw new Error(`remote tar extract failed (exit ${extractCode})`);
  }

  await ssh.runShell(`chown -R ${SERVICE_USER}:${SERVICE_USER} ${sh(releaseDir)}`);
}

export async function swapSymlink(ssh: SshSession, releaseDir: string): Promise<void> {
  const code = await ssh.runShell(
    `sudo ln -sfn ${sh(releaseDir)} ${sh(CURRENT_LINK)} && sudo chown -h ${SERVICE_USER}:${SERVICE_USER} ${sh(CURRENT_LINK)}`,
  );
  if (code !== 0) throw new Error("symlink swap failed");
}

export function releaseTag(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}
