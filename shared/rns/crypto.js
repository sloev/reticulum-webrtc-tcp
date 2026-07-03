import { ed25519 } from '@noble/curves/ed25519.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf as hkdfDeriv } from '@noble/hashes/hkdf.js';
import { randomBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { cbc } from '@noble/ciphers/aes.js';

export { randomBytes, hexToBytes, bytesToHex };

export function concat(...arrs) {
  const totalLength = arrs.reduce((acc, val) => acc + val.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrs) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export function private_identity() {
  const x25519_priv = randomBytes(32);
  const ed25519_priv = randomBytes(32);
  const result = new Uint8Array(64);
  result.set(x25519_priv, 0);
  result.set(ed25519_priv, 32);
  return result;
}

export function public_identity(identity_priv) {
  const x25519_priv = identity_priv.slice(0, 32);
  const ed25519_priv = identity_priv.slice(32, 64);
  const x25519_pub = x25519.getPublicKey(x25519_priv);
  const ed25519_pub = ed25519.getPublicKey(ed25519_priv);
  const result = new Uint8Array(64);
  result.set(x25519_pub, 0);
  result.set(ed25519_pub, 32);
  return result;
}

export function private_ratchet() {
  return randomBytes(32);
}

export function public_ratchet(ratchet_priv) {
  return x25519.getPublicKey(ratchet_priv);
}

export function sha256(data) {
  return sha256Hash(data);
}

export function hmac_sha256(key, data) {
  return hmac(sha256Hash, key, data);
}

export function hkdf(ikm, length, salt = null, info = null) {
  salt = salt || new Uint8Array(32);
  info = info || new Uint8Array(0);
  return hkdfDeriv(sha256Hash, ikm, salt, info, length);
}

export function aes_cbc_encrypt(key, iv, plaintext) {
  const cipher = cbc(key, iv);
  return cipher.encrypt(plaintext);
}

export function aes_cbc_decrypt(key, iv, ciphertext) {
  const cipher = cbc(key, iv);
  return cipher.decrypt(ciphertext);
}

export function ed25519_sign(private_key, message) {
  return ed25519.sign(message, private_key);
}

export function ed25519_validate(signature, message, public_key) {
  try {
    return ed25519.verify(signature, message, public_key);
  } catch {
    return false;
  }
}

export function x25519_exchange(private_key, public_key) {
  return x25519.getSharedSecret(private_key, public_key);
}
