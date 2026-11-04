// Shared helpers for the PA Cafe Herdr mod. Plain Node (18+), no dependencies, so `herdr plugin install` needs no build.
import { createHmac, randomUUID, webcrypto } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const subtle = webcrypto.subtle;
const INFO = new TextEncoder().encode('pa-cafe herdr link v1');
export const DEFAULT_ORIGIN = 'https://pacafe.dnplus.dev';
// The only body the cafe accepts on a signed DELETE, so no signed event can be replayed as a disconnect (shared/herdr-link.ts).
export const DISCONNECT_BODY = '{"type":"pacafe.herdr.disconnect"}';

const b64url = bytes => Buffer.from(bytes).toString('base64url');
const unb64url = text => new Uint8Array(Buffer.from(text, 'base64url'));

/** @param {NodeJS.ProcessEnv} env */
export const connectionPath = env => env.HERDR_PLUGIN_CONFIG_DIR ? join(env.HERDR_PLUGIN_CONFIG_DIR, 'pacafe.json') : null;

/** The paired cafe, or the older PACAFE_HERDR_URL / PACAFE_HERDR_SECRET variables when the mod was never paired. */
export function readConnection(env = process.env) {
  const path = connectionPath(env);
  if (path) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof saved?.url === 'string' && typeof saved?.secret === 'string') return saved;
    } catch {}
  }
  const url = env.PACAFE_HERDR_URL?.trim(), secret = env.PACAFE_HERDR_SECRET?.trim();
  return url && secret ? { url, secret, cafe: null, house: null } : null;
}

export function saveConnection(env, connection) {
  const path = connectionPath(env);
  if (!path) throw new Error('HERDR_PLUGIN_CONFIG_DIR is not set; run this from Herdr.');
  mkdirSync(env.HERDR_PLUGIN_CONFIG_DIR, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...connection, connectedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  try { chmodSync(temporary, 0o600); } catch {}
  renameSync(temporary, path);
}

export function forgetConnection(env) {
  const path = connectionPath(env);
  if (path) rmSync(path, { force: true });
}

/** Asks the cafe to remove this connection's Herdr source. True once the cafe no longer has it. */
export async function revokeConnection(connection) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `msg_${randomUUID()}`, timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signDelivery(connection.secret, id, timestamp, DISCONNECT_BODY);
    if (!signature) return false;
    let response;
    try {
      response = await fetch(connection.url, { method: 'DELETE', headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }, body: DISCONNECT_BODY, signal: AbortSignal.timeout(15_000) });
    } catch { return false; }
    if (response.ok || response.status === 404) return true;
    if (response.status !== 503) return false;
    await new Promise(done => setTimeout(done, 5000));
  }
  return false;
}

// The cafe encrypts the handover to this key (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, see shared/herdr-link.ts).
export async function deviceKey() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: b64url(await subtle.exportKey('raw', pair.publicKey)) };
}

export async function openHandover(privateKey, sealed) {
  if (sealed?.v !== 1) throw new Error('Unknown handover format. Update the PA Cafe mod.');
  const peer = await subtle.importKey('raw', unb64url(sealed.epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: INFO }, hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64url(sealed.iv), additionalData: INFO }, key, unb64url(sealed.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Standard Webhooks v1 signature body for one delivery, or null when the secret is unusable. */
export function signDelivery(secret, id, timestamp, body) {
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret, 'utf8');
  if (!key.length) return null;
  return createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}
