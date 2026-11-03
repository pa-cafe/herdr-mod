// Popup pane: pairs this Herdr with a PA Cafe. Shows a code, opens the cafe in the browser, and waits for the barista
// to approve it there. The cafe sends back the source address and signing key encrypted to a key made here.
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ORIGIN, deviceKey, openHandover, readConnection, saveConnection } from './link.mjs';

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
    const timer = setTimeout(done, seconds * 1000);
    if (!process.stdin.isTTY) return;
    process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.once('data', () => { clearTimeout(timer); done(); });
  });
}

async function connect(env = process.env) {
  const origin = (env.PACAFE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
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
      saveConnection(env, { url: handover.url, secret: handover.secret, cafe: handover.cafe, house: handover.house });
      console.log('');
      console.log(bold(say(`Connected to ${handover.cafe}.`, `已連到「${handover.cafe}」。`)));
      console.log(say('When an agent in Herdr finishes or gets stuck, the cafe will know.', 'Herdr 裡的 agent 做完或卡住時，小屋都會知道。'));
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
  try { ok = await connect(); } catch (error) { console.log(''); console.log(say('Could not connect:', '連不上：'), error instanceof Error ? error.message : String(error)); }
  console.log('');
  console.log(say('Press any key to close.', '按任意鍵關閉。'));
  await waitForKey(ok ? 8 : 120);
  process.exit(ok ? 0 : 1);
}
