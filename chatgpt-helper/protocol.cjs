'use strict';
const { TextDecoder } = require('node:util');
const MAX_FRAME_BYTES = 1024 * 1024;
const METHODS = new Set(['STATUS', 'LOGIN_START', 'LOGIN_CANCEL', 'SELECT_PROFILE', 'LOGOUT', 'MODELS', 'TRANSLATE', 'CANCEL']);
const ERROR_CODES = new Set(['INVALID_REQUEST','PROTOCOL_ERROR','FORBIDDEN','BUSY','CANCELLED','NOT_FOUND','NOT_LOGGED_IN','AUTH_REQUIRED','AUTH_EXPIRED','LOGIN_FAILED','LOGIN_CANCELLED','RATE_LIMITED','QUOTA_EXCEEDED','MODEL_UNAVAILABLE','NETWORK_ERROR','TIMEOUT','STORAGE_ERROR','PROTECTION_FAILED','RESPONSE_TOO_LARGE','DUPLICATE_ID','INTERNAL_ERROR','UNAVAILABLE']);
class ProtocolError extends Error { constructor(code = 'PROTOCOL_ERROR') { super(code); this.code = code; } }
class FrameDecoder {
  constructor(onMessage, onError, maxBytes = MAX_FRAME_BYTES) { this.onMessage = onMessage; this.onError = onError; this.maxBytes = maxBytes; this.header = Buffer.alloc(4); this.headerUsed = 0; this.body = null; this.bodyUsed = 0; this.failed = false; }
  fail() { if (!this.failed) { this.failed = true; this.onError(new ProtocolError()); } }
  push(chunk) {
    if (this.failed) return;
    let offset = 0;
    try {
      while (offset < chunk.length && !this.failed) {
        if (!this.body) {
          const count = Math.min(4 - this.headerUsed, chunk.length - offset);
          chunk.copy(this.header, this.headerUsed, offset, offset + count); offset += count; this.headerUsed += count;
          if (this.headerUsed !== 4) continue;
          const length = this.header.readUInt32LE(0);
          if (!length || length > this.maxBytes) throw new ProtocolError();
          this.body = Buffer.alloc(length); this.bodyUsed = 0;
        }
        const count = Math.min(this.body.length - this.bodyUsed, chunk.length - offset);
        chunk.copy(this.body, this.bodyUsed, offset, offset + count); offset += count; this.bodyUsed += count;
        if (this.bodyUsed === this.body.length) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(this.body);
          const message = JSON.parse(text);
          this.body = null; this.headerUsed = 0; this.bodyUsed = 0;
          this.onMessage(message);
        }
      }
    } catch { this.fail(); }
  }
  end() { if (!this.failed && (this.headerUsed || this.body)) this.fail(); }
}
function encodeFrame(value, maxBytes = MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > maxBytes) throw new ProtocolError('RESPONSE_TOO_LARGE');
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 128) => typeof value === 'string' && value.length > 0 && value.length <= max;
function validateRequest(value) {
  if (!plain(value) || !text(value.id) || !METHODS.has(value.method) || (value.params !== undefined && !plain(value.params)) || Object.keys(value).some(k => !['id','method','params'].includes(k))) throw new ProtocolError('INVALID_REQUEST');
  const p = value.params || {};
  const allowed = { STATUS: [], LOGIN_START: ['profileId','newProfile'], LOGIN_CANCEL: [], SELECT_PROFILE: ['id'], LOGOUT: ['id'], MODELS: [], TRANSLATE: ['model','system','user'], CANCEL: ['targetId'] }[value.method];
  if (Object.keys(p).some(k => !allowed.includes(k))) throw new ProtocolError('INVALID_REQUEST');
  if (value.method === 'LOGIN_START' && ((p.profileId !== undefined && !text(p.profileId)) || (p.newProfile !== undefined && typeof p.newProfile !== 'boolean'))) throw new ProtocolError('INVALID_REQUEST');
  if (value.method === 'SELECT_PROFILE' && !text(p.id)) throw new ProtocolError('INVALID_REQUEST');
  if (value.method === 'LOGOUT' && p.id !== undefined && !text(p.id)) throw new ProtocolError('INVALID_REQUEST');
  if (value.method === 'CANCEL' && !text(p.targetId)) throw new ProtocolError('INVALID_REQUEST');
  if (value.method === 'TRANSLATE' && (!text(p.model,256) || typeof p.system !== 'string' || typeof p.user !== 'string' || !p.user.length)) throw new ProtocolError('INVALID_REQUEST');
  return { id: value.id, method: value.method, params: p };
}
const SERVICE_ERROR_MAP = Object.freeze({
  cancelled:'CANCELLED', invalid_request:'INVALID_REQUEST', invalid_output:'INTERNAL_ERROR', invalid_model:'MODEL_UNAVAILABLE', model_not_found:'MODEL_UNAVAILABLE',
  sign_in_required:'AUTH_REQUIRED', sharing_not_enabled:'AUTH_REQUIRED', invalid_id_token:'AUTH_EXPIRED', invalid_grant:'AUTH_EXPIRED', access_denied:'AUTH_REQUIRED',
  connection_busy:'BUSY', service_busy:'BUSY', storage_busy:'BUSY', profile_not_found:'NOT_FOUND',
  storage_error:'STORAGE_ERROR', storage_unsafe:'STORAGE_ERROR', storage_invalid:'STORAGE_ERROR', storage_lock_lost:'STORAGE_ERROR',
  storage_encryption_unavailable:'PROTECTION_FAILED', storage_decryption_failed:'PROTECTION_FAILED', storage_encryption_failed:'PROTECTION_FAILED', storage_provider_mismatch:'PROTECTION_FAILED', storage_encrypted_invalid:'PROTECTION_FAILED',
  sdk_unavailable:'UNAVAILABLE', connection_error:'NETWORK_ERROR', network_error:'NETWORK_ERROR', account_mismatch:'LOGIN_FAILED', revocation_failed:'LOGIN_FAILED', registration_incomplete:'LOGIN_FAILED',
  invalid_stream:'NETWORK_ERROR', stream_interrupted:'NETWORK_ERROR', response_incomplete:'NETWORK_ERROR', response_too_large:'RESPONSE_TOO_LARGE', connection_changed:'CANCELLED', refresh_not_ready:'AUTH_REQUIRED', identity_verification_unavailable:'UNAVAILABLE', endpoint_rejected:'FORBIDDEN'
});
function safeError(error) {
  const mapped = typeof error?.code === 'string' && Object.hasOwn(SERVICE_ERROR_MAP, error.code) ? SERVICE_ERROR_MAP[error.code] : undefined;
  const code = ERROR_CODES.has(error?.code) ? error.code : (mapped || (/^subscription_sharing_[a-z_]{1,70}$/.test(error?.code || '') ? 'AUTH_REQUIRED' : error?.name === 'AbortError' ? 'CANCELLED' : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'INTERNAL_ERROR'));
  return { code, retryable: ['BUSY','RATE_LIMITED','NETWORK_ERROR','TIMEOUT','UNAVAILABLE'].includes(code) };
}
module.exports = { MAX_FRAME_BYTES, FrameDecoder, ProtocolError, encodeFrame, validateRequest, safeError };
