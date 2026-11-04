// Herdr actions: `connect` opens the pairing popup, `disconnect` removes this machine's source from the cafe, `status` says where events go.
import { execFile } from 'node:child_process';
import { forgetConnection, readConnection, revokeConnection } from './link.mjs';

const zh = /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const say = (en, tw) => zh ? tw : en;
const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const run = args => new Promise(done => execFile(herdr, args, (error, stdout, stderr) => done(error ? `${stderr || stdout || error.message}`.trim() : null)));
// Printed as well, so an agent or a headless Herdr sees the result that the notification shows.
const notify = body => { console.log(body); return run(['notification', 'show', 'PA Cafe', '--body', body]); };

const action = process.argv[2];
if (action === 'connect') {
  const failure = await run(['plugin', 'pane', 'open', '--plugin', process.env.HERDR_PLUGIN_ID ?? 'pacafe.herdr', '--entrypoint', 'connect', '--placement', 'popup', '--width', '72', '--height', '18', '--focus']);
  if (failure) {
    console.error(say(`Could not open the PA Cafe popup: ${failure}`, `打不開 PA Cafe 視窗：${failure}`));
    console.error(say('Open a Herdr workspace first, or pair from a shell with node connect.mjs.', '請先開一個 Herdr workspace，或在 shell 用 node connect.mjs 配對。'));
    process.exitCode = 1;
  }
} else if (action === 'disconnect') {
  const current = readConnection(process.env);
  if (!current?.house) await notify(say('Not connected to a cafe.', '目前沒有連到小屋。'));
  else {
    const removed = await revokeConnection(current);
    forgetConnection(process.env);
    await notify(removed ? say(`Disconnected from ${current.cafe}. Its Herdr source was removed.`, `已和「${current.cafe}」斷開，小屋裡的 Herdr 來源也移除了。`) : say(`Disconnected from ${current.cafe} on this machine, but the cafe could not be reached. Remove the Herdr source in the cafe settings.`, `本機已和「${current.cafe}」斷開，但連不到小屋。請到小屋設定移除這個 Herdr 來源。`));
    if (!removed) process.exitCode = 1;
  }
} else if (action === 'status') {
  const current = readConnection(process.env);
  await notify(current ? say(`Connected to ${current.cafe ?? 'a cafe'}.`, `已連到「${current.cafe ?? '小屋'}」。`) : say('Not connected. Run Connect to PA Cafe.', '還沒連接，請執行「連接 PA Cafe」。'));
}
