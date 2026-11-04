// Popup pane: pairs this Herdr with a PA Cafe. Shows a code, opens the cafe in the browser, and waits for the barista
// to approve it there. The cafe sends back the source address and signing key encrypted to a key made here.
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ORIGIN, deviceKey, openHandover, readConnection, revokeConnection, saveConnection } from './link.mjs';

const zh = /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const say = (en, tw) => zh ? tw : en;
const bold = text => process.stdout.isTTY ? `\x1b[1m${text}\x1b[0m` : text;

function openBrowser(url) {
  if (process.env.PACAFE_NO_BROWSER) return;
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  execFile(command, args, () => undefined);
}

function notify(title, body) {
  execFile(process.env.HERDR_BIN_PATH ?? 'herdr', ['notification', 'show', title, '--body', body, '--sound', 'done'], () => undefined);
}

async function post(origin, path, body) {
  const response = await fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 503 && data?.error?.code === 'VERSION_SKEW') return { retry: true };
  if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
  return data;
}

function waitForKey(seconds) {
  return new Promise(done => {
    if (!process.stdin.isTTY) return done();
    const timer = setTimeout(done, seconds * 1000);
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.once('data', () => { clearTimeout(timer); done(); });
  });
}

// Outside a Herdr pane (an agent running this from a shell) the config directory is not in the environment.
function configDir(env) {
  if (env.HERDR_PLUGIN_CONFIG_DIR) return Promise.resolve(env.HERDR_PLUGIN_CONFIG_DIR);
  return new Promise(done => execFile(env.HERDR_BIN_PATH ?? 'herdr', ['plugin', 'config-dir', 'pacafe.herdr'], (error, out) => done(error ? '' : out.trim())));
}

// Checked before a code is shown, so the barista never approves a connection this terminal cannot keep.
function checkConfigDir(env) {
  const dir = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) throw new Error(say('Herdr did not give this mod a config directory. Install it with herdr plugin install pa-cafe/herdr-mod.', 'Herdr 沒有給這個 mod 設定目錄。請用 herdr plugin install pa-cafe/herdr-mod 安裝。'));
  mkdirSync(dir, { recursive: true });
  accessSync(dir, constants.W_OK);
}

async function connect(env = process.env) {
  const origin = (env.PACAFE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
  checkConfigDir(env);
  const existing = readConnection(env);
  console.log(bold('PA Cafe × Herdr'));
  if (existing?.cafe) console.log(say(`Currently connected to ${existing.cafe}. Approving a new code replaces it.`, `目前連在「${existing.cafe}」。同意新的代碼會換成新的小屋。`));
  const key = await deviceKey();
  let started;
  while (!started || started.retry) {
    started = await post(origin, '/api/herdr/link', { label: hostname().slice(0, 60), publicKey: key.publicKey });
    if (started.retry) await new Promise(done => setTimeout(done, 5000));
  }
  console.log('');
  console.log(say('Approve this code in your cafe:', '到小屋同意這組代碼：'));
  console.log('');
  console.log(`    ${bold(started.userCode)}`);
  console.log('');
  console.log(say('Opening', '正在打開'), started.verificationUrl);
  console.log(say('(If the browser does not open, visit the address above.)', '（瀏覽器沒打開的話，自己前往上面的網址。）'));
  openBrowser(started.verificationUrl);
  const deadline = started.expiresAt;
  while (Date.now() < deadline) {
    await new Promise(done => setTimeout(done, (started.interval ?? 3) * 1000));
    let polled;
    try { polled = await post(origin, '/api/herdr/link/poll', { deviceCode: started.deviceCode }); } catch { continue; }
    if (polled.retry || polled.status === 'pending') continue;
    if (polled.status === 'approved') {
      const handover = await openHandover(key.privateKey, polled.sealed);
      const connection = { url: handover.url, secret: handover.secret, cafe: handover.cafe, house: handover.house };
      saveConnection(env, connection);
      if (existing?.house && existing.url !== connection.url && !await revokeConnection(existing)) console.log(say(`Could not remove the previous Herdr source from ${existing.cafe ?? 'the old cafe'}. Remove it in that cafe's settings.`, `沒能移除「${existing.cafe ?? '舊小屋'}」裡原本的 Herdr 來源，請到那間小屋的設定移除。`));
      console.log('');
      console.log(bold(say(`Connected to ${handover.cafe}.`, `已連到「${handover.cafe}」。`)));
      console.log(say('When a coding agent your residents use in Herdr finishes or gets stuck, the cafe will know.', '住民在 Herdr 裡用的 coding agent 做完或卡住時，小屋都會知道。'));
      notify('PA Cafe', say(`Connected to ${handover.cafe}`, `已連到「${handover.cafe}」`));
      return true;
    }
    console.log('');
    console.log(polled.status === 'denied' ? say('The barista declined this code.', '咖啡師拒絕了這組代碼。') : say('The code expired. Run Connect again.', '代碼過期了，請重新執行「連接 PA Cafe」。'));
    return false;
  }
  console.log(say('The code expired. Run Connect again.', '代碼過期了，請重新執行「連接 PA Cafe」。'));
  return false;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let ok = false;
  try { process.env.HERDR_PLUGIN_CONFIG_DIR ||= await configDir(process.env); ok = await connect(); } catch (error) { console.log(''); console.log(say('Could not connect:', '連不上：'), error instanceof Error ? error.message : String(error)); }
  console.log('');
  console.log(say('Press any key to close.', '按任意鍵關閉。'));
  await waitForKey(ok ? 8 : 120);
  process.exit(ok ? 0 : 1);
}
