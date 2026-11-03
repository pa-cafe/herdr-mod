// Herdr `pane.agent_status_changed` hook: tells the paired cafe when a coding agent's pane is done or blocked.
// A done is sent only if the pane is still done 15 s later with the same completion; each completion is sent once.
import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, closeSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readConnection, signDelivery } from './link.mjs';

const execFile = promisify(execFileCallback);
const STATUSES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);
const FETCH_TIMEOUT_MS = 10_000;
const CLAIM_LEASE_MS = 60_000;
const CLAIM_KEEP_MS = 7 * 24 * 60 * 60_000;

const text = (value, max, min = 1) => typeof value === 'string' && value.length >= min && value.length <= max;
const optionalText = (value, max) => value === undefined || value === null || text(value, max, 0);
const count = (value, min) => Number.isInteger(value) && value >= min;

function parseEvent(input) {
  const data = input?.data;
  if (input?.event !== 'pane.agent_status_changed' || !data || typeof data !== 'object') return null;
  if (!text(data.pane_id, 200) || !text(data.workspace_id, 200) || !STATUSES.has(data.agent_status) || !optionalText(data.agent, 100)) return null;
  return { pane_id: data.pane_id, workspace_id: data.workspace_id, agent_status: data.agent_status, agent: data.agent ?? null };
}

function parseAgent(info) {
  if (!info || typeof info !== 'object') return null;
  const completion = info.completion_seq;
  if (!(info.agent === null || typeof info.agent === 'string') || !STATUSES.has(info.agent_status)) return null;
  if (!(completion === undefined || completion === null || count(completion, 1)) || !count(info.state_change_seq, 0)) return null;
  if (!text(info.terminal_id, 200) || !text(info.workspace_id, 200) || !text(info.pane_id, 200) || !optionalText(info.terminal_title, 500)) return null;
  return info;
}

async function readAgent(paneId, reader) {
  try { return await reader(paneId); } catch { return new Error('agent_read_failed'); }
}

const matches = (event, agent) => agent.pane_id === event.pane_id && agent.workspace_id === event.workspace_id && (!event.agent || agent.agent === event.agent);

async function snapshot(event, reader) {
  const raw = await readAgent(event.pane_id, reader);
  if (raw instanceof Error) return { reason: 'read_failed' };
  if (!raw) return { reason: 'pane_missing' };
  const agent = parseAgent(raw);
  if (!agent) return { reason: 'invalid_snapshot' };
  if (!matches(event, agent)) return { reason: 'scope_mismatch' };
  return { agent };
}

export async function notifyHerdrEvent(input, dependencies) {
  const event = parseEvent(input);
  if (!event) return { sent: false, reason: 'invalid_event' };
  if (!dependencies.socketPath || !dependencies.stateDir || !dependencies.endpoint || !dependencies.secret) return { sent: false, reason: 'missing_config' };
  const first = await snapshot(event, dependencies.readAgent);
  if (!first.agent) return { sent: false, reason: first.reason };
  const candidate = first.agent, status = event.agent_status;
  if (status !== 'done' && status !== 'blocked') return { sent: false, reason: 'invalid_event' };

  if (status === 'done') {
    if (candidate.agent_status !== 'done' && candidate.agent_status !== 'idle') return { sent: false, reason: 'pane_not_done' };
    if (!candidate.completion_seq) return { sent: false, reason: 'missing_completion_seq' };
    await (dependencies.sleep ?? sleep)(dependencies.settleMs ?? 15_000);
    const settled = await snapshot(event, dependencies.readAgent);
    if (!settled.agent) return { sent: false, reason: settled.reason };
    const current = settled.agent;
    if ((current.agent_status !== 'done' && current.agent_status !== 'idle') || current.terminal_id !== candidate.terminal_id || current.completion_seq !== candidate.completion_seq) return { sent: false, reason: 'pane_changed' };
  } else {
    if (candidate.agent_status !== 'blocked') return { sent: false, reason: 'pane_changed' };
    if (candidate.state_change_seq < 1) return { sent: false, reason: 'invalid_snapshot' };
  }

  const sequence = status === 'done' ? candidate.completion_seq : candidate.state_change_seq;
  const claimKey = createHash('sha256').update(JSON.stringify([dependencies.serverIdentity ?? dependencies.socketPath, candidate.workspace_id, candidate.pane_id, candidate.terminal_id, sequence, status])).digest('hex');
  const deliveryId = `herdr-${claimKey}`;
  const claims = join(dependencies.stateDir, 'claims');
  const owner = claimDelivery(claims, claimKey);
  if (owner === 'duplicate') return { sent: false, reason: 'duplicate' };
  if (owner === 'error') return { sent: false, reason: 'delivery_failed' };

  // Only ids and the status leave this machine: no titles, prompts or screen text.
  const body = JSON.stringify({ event: 'pane.agent_status_changed', data: { pane_id: candidate.pane_id, workspace_id: candidate.workspace_id, agent_status: status } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signDelivery(dependencies.secret, deliveryId, timestamp, body);
  if (!signature) { releaseDelivery(claims, claimKey, owner); return { sent: false, reason: 'missing_config' }; }
  try {
    const response = await (dependencies.fetcher ?? fetch)(dependencies.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'webhook-id': deliveryId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` },
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) { releaseDelivery(claims, claimKey, owner); return { sent: false, reason: 'delivery_failed' }; }
  } catch {
    releaseDelivery(claims, claimKey, owner);
    return { sent: false, reason: 'delivery_failed' };
  }
  if (!markDelivered(claims, claimKey, owner)) return { sent: false, reason: 'delivery_failed' };
  return { sent: true, status };
}

// One file per candidate. `wx` creation is the lock, so two hook processes for the same completion send once.
function claimDelivery(claims, key) {
  const path = join(claims, key), owner = randomUUID();
  try {
    mkdirSync(claims, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try { writeSync(fd, JSON.stringify({ owner, expires: Date.now() + CLAIM_LEASE_MS, sent: null })); } finally { closeSync(fd); }
        return owner;
      } catch (error) {
        if (error?.code !== 'EEXIST') return 'error';
        const current = readClaim(path);
        if (current && (current.sent || current.expires > Date.now())) return 'duplicate';
        rmSync(path, { force: true });
      }
    }
    return 'duplicate';
  } catch { return 'error'; }
}

function readClaim(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function markDelivered(claims, key, owner) {
  const path = join(claims, key);
  if (readClaim(path)?.owner !== owner) return false;
  try {
    const temporary = `${path}.${owner}.tmp`;
    writeFileSync(temporary, JSON.stringify({ owner, expires: 0, sent: Date.now() }), { mode: 0o600 });
    renameSync(temporary, path);
    pruneClaims(claims);
    return true;
  } catch { return false; }
}

function releaseDelivery(claims, key, owner) {
  const path = join(claims, key), current = readClaim(path);
  if (current?.owner === owner && !current.sent) rmSync(path, { force: true });
}

function pruneClaims(claims) {
  try {
    for (const name of readdirSync(claims)) {
      const path = join(claims, name);
      if (Date.now() - statSync(path).mtimeMs > CLAIM_KEEP_MS) rmSync(path, { force: true });
    }
  } catch {}
}

async function readHerdrAgent(paneId, binary, socketPath) {
  const { stdout } = await execFile(binary, ['agent', 'get', paneId], { encoding: 'utf8', timeout: 5_000, maxBuffer: 32_768, env: { ...process.env, HERDR_SOCKET_PATH: socketPath } });
  return JSON.parse(stdout)?.result?.agent ?? null;
}

export async function runHerdrNotifier(input, env = process.env) {
  const connection = readConnection(env);
  const socketPath = env.HERDR_SOCKET_PATH, stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!connection || !socketPath || !stateDir) return { sent: false, reason: 'missing_config' };
  let serverIdentity;
  try {
    const socket = statSync(socketPath);
    if (!socket.isSocket()) return { sent: false, reason: 'missing_config' };
    serverIdentity = `${socket.dev}:${socket.ino}:${socket.birthtimeMs}`;
  } catch { return { sent: false, reason: 'missing_config' }; }
  return notifyHerdrEvent(input, { socketPath, serverIdentity, stateDir, endpoint: connection.url, secret: connection.secret, readAgent: paneId => readHerdrAgent(paneId, env.HERDR_BIN_PATH ?? 'herdr', socketPath) });
}

export async function runHerdrNotifierCli(env = process.env) {
  let input = null;
  try { input = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON ?? ''); } catch {}
  const result = input ? await runHerdrNotifier(input, env) : { sent: false, reason: 'invalid_event' };
  process.stdout.write(`${JSON.stringify({ component: 'pacafe-herdr-notify', ...result })}\n`);
}

function sleep(duration) { return new Promise(done => setTimeout(done, duration)); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runHerdrNotifierCli();
