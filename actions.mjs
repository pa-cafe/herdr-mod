// Herdr actions: `connect` opens the pairing popup, `disconnect` forgets the cafe, `status` says where events go.
import { execFile } from 'node:child_process';
import { forgetConnection, readConnection } from './link.mjs';

const zh = /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
const say = (en, tw) => zh ? tw : en;
const herdr = process.env.HERDR_BIN_PATH ?? 'herdr';
const run = args => new Promise(done => execFile(herdr, args, error => done(!error)));
const notify = body => run(['notification', 'show', 'PA Cafe', '--body', body]);

const action = process.argv[2];
if (action === 'connect') {
  await run(['plugin', 'pane', 'open', '--plugin', process.env.HERDR_PLUGIN_ID ?? 'pacafe.herdr', '--entrypoint', 'connect', '--placement', 'popup', '--width', '72', '--height', '18', '--focus']);
} else if (action === 'disconnect') {
  const current = readConnection(process.env);
  forgetConnection(process.env);
  await notify(current?.cafe ? say(`Disconnected from ${current.cafe}. Remove the Herdr source in the cafe settings to stop it for good.`, `已和「${current.cafe}」斷開。要徹底停用，請到小屋設定移除這個 Herdr 來源。`) : say('Not connected to a cafe.', '目前沒有連到小屋。'));
} else if (action === 'status') {
  const current = readConnection(process.env);
  await notify(current ? say(`Connected to ${current.cafe ?? 'a cafe'}.`, `已連到「${current.cafe ?? '小屋'}」。`) : say('Not connected. Run Connect to PA Cafe.', '還沒連接，請執行「連接 PA Cafe」。'));
}
