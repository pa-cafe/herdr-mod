// Runs once when Herdr starts: the first time, if no cafe is paired, says how to connect. Never repeats.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readConnection } from './link.mjs';

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR;
const marker = stateDir && join(stateDir, 'welcomed');
if (marker && !existsSync(marker) && !readConnection(process.env)) {
  const zh = /^zh/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');
  const body = zh ? '執行 herdr plugin action invoke connect --plugin pacafe.herdr，把 Herdr 連到你的小屋。' : 'Run herdr plugin action invoke connect --plugin pacafe.herdr to connect Herdr to your cafe.';
  execFile(process.env.HERDR_BIN_PATH ?? 'herdr', ['notification', 'show', 'PA Cafe', '--body', body], () => undefined);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());
}
