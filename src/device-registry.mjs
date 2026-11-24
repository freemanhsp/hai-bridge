import path from 'node:path';
import { createHash, randomBytes, verify, sign } from 'node:crypto';
import { readPrivateJson, replacePrivate, createPrivate, withDeviceLock, exactObject, privateDirectory } from './device-store.mjs';
import { DEVICE_SCHEMA, publicDeviceKey, spkiPin, validateTrust } from './device-identity.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const secret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const timestamp = value => Number.isSafeInteger(value) && value > 0;
export function deviceLabel(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) throw new Error('Device label must be 1-64 printable characters');
  return value;
}
export async function loadRegistry(directory, instanceId) {
  const raw = await readPrivateJson(path.join(directory, 'registry.json'), 262144);
  exactObject(raw, ['schema_version', 'instance_id', 'devices', 'invitations']);
  if (raw.schema_version !== DEVICE_SCHEMA || raw.instance_id !== instanceId || !Array.isArray(raw.devices)
      || !Array.isArray(raw.invitations) || raw.devices.length > 32 || raw.invitations.length > 64) throw new Error('Invalid device registry');
  const ids = new Set(), invites = new Set();
  for (const item of raw.devices) {
    exactObject(item, ['device_id', 'public_key', 'label', 'state', 'generation', 'created_at', 'updated_at']);
    if (!hex(item.device_id) || ids.has(item.device_id) || spkiPin(publicDeviceKey(item.public_key)) !== item.device_id
        || !['pending', 'approved', 'revoked'].includes(item.state) || !Number.isSafeInteger(item.generation) || item.generation < 1
        || !timestamp(item.created_at) || !timestamp(item.updated_at)) throw new Error('Invalid registry device');
    deviceLabel(item.label); ids.add(item.device_id);
  }
  for (const item of raw.invitations) {
    exactObject(item, ['invite_id', 'secret_hash', 'expires_at', 'used_by']);
    if (!hex(item.invite_id) || invites.has(item.invite_id) || !hex(item.secret_hash) || !timestamp(item.expires_at)
        || (item.used_by !== null && (!hex(item.used_by) || !ids.has(item.used_by)))) throw new Error('Invalid registry invitation');
    invites.add(item.invite_id);
  }
  return raw;
}
const persist = (directory, state) => replacePrivate(path.join(directory, 'registry.json'), JSON.stringify(state, null, 2) + '\n');
export async function issueInvitation(directory, out, { now = Date.now(), ttlMs = 900000 } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new Error('Invitation lifetime must be at most one hour');
  const trust = await readPrivateJson(path.join(directory, 'trust.json'), 20000); validateTrust(trust);
  const destination = path.resolve(out);
  await privateDirectory(path.dirname(destination), { create: true });
  return withDeviceLock(directory, async () => {
    const state = await loadRegistry(directory, trust.instance_id);
    state.invitations = state.invitations.filter(item => item.expires_at > now);
    if (state.invitations.length >= 64) throw new Error('Too many outstanding invitations');
    const invite = { schema_version: DEVICE_SCHEMA, trust, invite_id: randomBytes(32).toString('hex'),
      secret: randomBytes(32).toString('base64url'), expires_at: now + ttlMs };
    // Write only a private new file; a failed persistence leaves an unusable invitation, not authority.
    await createPrivate(destination, JSON.stringify(invite, null, 2) + '\n');
    state.invitations.push({ invite_id: invite.invite_id, secret_hash: digest(invite.secret), expires_at: invite.expires_at, used_by: null });
    await persist(directory, state);
    return { file: destination, expires_at: invite.expires_at, instance_id: trust.instance_id };
  });
}
export function validateInvitation(raw, now = Date.now()) {
  exactObject(raw, ['schema_version', 'trust', 'invite_id', 'secret', 'expires_at']);
  validateTrust(raw.trust);
  if (raw.schema_version !== DEVICE_SCHEMA || !hex(raw.invite_id) || !secret(raw.secret)
      || !timestamp(raw.expires_at) || raw.expires_at <= now || raw.expires_at > now + 3600000) throw new Error('Invitation invalid or expired');
  return raw;
}
export function enrollmentBytes(request) {
  return Buffer.from(JSON.stringify(['hai-bridge-device-v2', 'enroll', request.instance_id, request.device_id,
    request.invite_id, request.secret, request.public_key, request.label, request.nonce]));
}
export function enrollmentRequest(invite, identity, label) {
  const request = { instance_id: invite.trust.instance_id, device_id: identity.device_id, invite_id: invite.invite_id,
    secret: invite.secret, public_key: identity.public_key, label: deviceLabel(label), nonce: randomBytes(32).toString('base64url') };
  return { ...request, signature: sign(null, enrollmentBytes(request), identity.key).toString('base64url') };
}
export function validSignature(bytes, signature, publicKey) {
  return typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature)
    && verify(null, bytes, publicKey, Buffer.from(signature, 'base64url'));
}
export async function registerDevice(directory, instanceId, request, now = Date.now()) {
  exactObject(request, ['instance_id', 'device_id', 'invite_id', 'secret', 'public_key', 'label', 'nonce', 'signature']);
  const publicKey = publicDeviceKey(request.public_key);
  if (request.instance_id !== instanceId || !hex(request.device_id) || request.device_id !== spkiPin(publicKey)
      || !hex(request.invite_id) || !secret(request.secret) || !secret(request.nonce)) throw new Error('Invalid enrollment');
  deviceLabel(request.label);
  if (!validSignature(enrollmentBytes(request), request.signature, publicKey)) throw new Error('Invalid enrollment proof');
  return withDeviceLock(directory, async () => {
    const state = await loadRegistry(directory, instanceId);
    const invite = state.invitations.find(item => item.invite_id === request.invite_id);
    if (!invite || invite.expires_at <= now || invite.secret_hash !== digest(request.secret)
        || (invite.used_by !== null && invite.used_by !== request.device_id)) throw new Error('Invitation unavailable');
    let device = state.devices.find(item => item.device_id === request.device_id);
    // Idempotent response after a lost enrollment reply; never overwrite an existing identity/state.
    if (device && (invite.used_by !== device.device_id || device.state === 'revoked')) throw new Error('Existing device cannot be reenrolled');
    if (!device) {
      if (state.devices.length >= 32) throw new Error('Personal device limit reached');
      device = { device_id: request.device_id, public_key: request.public_key, label: request.label,
        state: 'pending', generation: 1, created_at: now, updated_at: now };
      state.devices.push(device); invite.used_by = device.device_id;
      await persist(directory, state);
    }
    return { device_id: device.device_id, state: device.state };
  });
}
export async function changeDeviceState(directory, instanceId, deviceId, state) {
  if (!hex(deviceId) || !['approved', 'revoked'].includes(state)) throw new Error('Invalid device management request');
  return withDeviceLock(directory, async () => {
    const registry = await loadRegistry(directory, instanceId);
    const device = registry.devices.find(item => item.device_id === deviceId);
    if (!device) throw new Error('Device not found; use the complete fingerprint from B');
    if (state === 'approved' && device.state !== 'pending') throw new Error('Only a pending device may be approved; revoked keys cannot be restored');
    if (device.state !== state) { device.state = state; device.generation++; device.updated_at = Date.now(); await persist(directory, registry); }
    return { device_id: deviceId, state, persistence: 'saved', running_service: 'not_confirmed', stream_revocation: 'polled_within_500ms_when_running' };
  });
}
