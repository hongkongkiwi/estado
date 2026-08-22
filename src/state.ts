import type { LockInfo } from "./types/terraform";
import type { Env } from "./types/worker-configuration";

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MAX_STATE_BYTES = 10 * 1024 * 1024;
export const MAX_LOCK_BYTES = 16 * 1024;
export const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024;
const MAX_KEY_RING_BYTES = 16 * 1024;
const MAX_KEY_COUNT = 4;
const MAX_KEY_ID_LENGTH = 32;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const ENVELOPE_VERSION = 2;
const ENVELOPE_ALGORITHM = "AES-256-GCM";
const NONCE_BYTES = 12;
const BACKUP_ATTEMPTS = 5;

interface StateEnvelope {
  version: number;
  algorithm: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
}

export function getStateKey(projectName: string): string | null {
  if (!PROJECT_NAME.test(projectName) || projectName === "." || projectName === "..") {
    return null;
  }

  return `${projectName}.tfstate`;
}

export function lockResponse(
  lockInfo: LockInfo | null,
  status = 423,
): Response {
  const body = lockInfo ?? { error: "State is not locked" };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function encryptState(
  plaintext: string,
  stateKey: string,
  keyRingSecret: string | undefined,
  activeKeyId: string | undefined,
): Promise<string> {
  const plaintextBytes = new TextEncoder().encode(plaintext);
  if (plaintextBytes.byteLength > MAX_STATE_BYTES) {
    throw new Error("State is too large");
  }

  if (!isKeyId(activeKeyId)) {
    throw new Error("Invalid active state key ID");
  }
  const keyRing = parseKeyRing(keyRingSecret, activeKeyId);
  const key = await importEncryptionKey(keyRing.get(activeKeyId)!, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce.buffer as ArrayBuffer,
      additionalData: new TextEncoder().encode(stateKey).buffer as ArrayBuffer,
    },
    key,
    plaintextBytes.buffer as ArrayBuffer,
  );

  return JSON.stringify({
    version: ENVELOPE_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    keyId: activeKeyId,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  } satisfies StateEnvelope);
}

export async function decryptState(
  envelopeText: string,
  stateKey: string,
  keyRingSecret: string | undefined,
  activeKeyId: string | undefined,
): Promise<string> {
  const envelope = parseEnvelope(envelopeText);
  const keyRing = parseKeyRing(keyRingSecret, activeKeyId);
  const keyBytes = keyRing.get(envelope.keyId);
  if (keyBytes === undefined) {
    throw new Error("Unknown state key ID");
  }
  const key = await importEncryptionKey(keyBytes, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.nonce, NONCE_BYTES).buffer as ArrayBuffer,
      additionalData: new TextEncoder().encode(stateKey).buffer as ArrayBuffer,
    },
    key,
    base64ToBytes(envelope.ciphertext).buffer as ArrayBuffer,
  );
  if (plaintext.byteLength > MAX_STATE_BYTES) {
    throw new Error("State is too large");
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
}

/**
 * Copy the current encrypted primary object to a random, versioned backup
 * before a mutation. A malformed or oversized primary is rejected so old
 * plaintext data can never be copied into the backup namespace.
 */
export async function backupExistingState(
  bucket: R2Bucket,
  stateKey: string,
): Promise<string | null> {
  const current = await bucket.get(stateKey);
  if (current === null) {
    return null;
  }
  if (current.size > MAX_ENVELOPE_BYTES) {
    throw new Error("Existing state envelope is too large");
  }

  const bytes = await current.arrayBuffer();
  const envelopeText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  parseEnvelope(envelopeText);

  for (let attempt = 0; attempt < BACKUP_ATTEMPTS; attempt += 1) {
    const backupKey = createBackupKey(stateKey);
    if (await bucket.head(backupKey) !== null) {
      continue;
    }
    await bucket.put(backupKey, bytes, {
      httpMetadata: { contentType: "application/json" },
    });
    return backupKey;
  }

  throw new Error("Unable to allocate a backup key");
}

export async function mutateState(
  request: Request,
  env: Env,
  key: string,
  lockId: string | null,
): Promise<Response> {
  const id = env.TF_STATE_LOCK.idFromName(key);
  const stub = env.TF_STATE_LOCK.get(id);
  const headers = new Headers({
    "X-Estado-Lock-ID": lockId ?? "",
  });
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    headers.set("Content-Length", contentLength);
  }
  const method = request.method === "POST" ? "PUT" : "DELETE";
  const response = await stub.fetch(
    `http://internal/state?key=${encodeURIComponent(key)}`,
    {
      method,
      headers,
      body: method === "PUT" ? request.body : undefined,
    },
  );

  return new Response(await response.text(), {
    status: response.status,
    headers: response.headers,
  });
}

export async function readLimitedBody(
  request: Request,
  maxBytes = MAX_STATE_BYTES,
): Promise<{ body: string; tooLarge: boolean }> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      return { body: "", tooLarge: true };
    }
    if (declaredLength > maxBytes) {
      return { body: "", tooLarge: true };
    }
  }

  if (request.body === null) {
    return { body: "", tooLarge: false };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { body: "", tooLarge: true };
      }
      chunks.push(result.value);
    }
  } catch {
    return { body: "", tooLarge: true };
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), tooLarge: false };
  } catch {
    return { body: "", tooLarge: false };
  }
}

export function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

export function serverError(): Response {
  return new Response(JSON.stringify({ error: "Internal server error" }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  });
}

export function isLockInfo(value: unknown): value is LockInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.ID !== "string" ||
    candidate.ID.length === 0 ||
    candidate.ID.length > 256
  ) {
    return false;
  }

  const fields = [
    ["operation", "Operation"],
    ["info", "Info"],
    ["who", "Who"],
    ["version", "Version"],
    ["created", "Created"],
    ["path", "Path"],
  ] as const;

  for (const [lowercase, uppercase] of fields) {
    const field = candidate[lowercase] ?? candidate[uppercase];
    if (typeof field !== "string" || field.length > 2048) {
      return false;
    }
    if (lowercase === "created" && Number.isNaN(Date.parse(field))) {
      return false;
    }
  }

  try {
    return JSON.stringify(candidate).length <= 16 * 1024;
  } catch {
    return false;
  }
}

async function importEncryptionKey(
  encodedSecret: Uint8Array,
  usages: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encodedSecret.buffer as ArrayBuffer, { name: "AES-GCM" }, false, usages);
}

function decodeEncryptionSecret(encodedSecret: unknown): Uint8Array {
  if (
    typeof encodedSecret !== "string" ||
    encodedSecret.length === 0 ||
    encodedSecret.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encodedSecret)
  ) {
    throw new Error("Invalid encryption secret");
  }

  const decoded = atob(encodedSecret);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) {
    throw new Error("Invalid encryption secret");
  }
  return bytes;
}

function parseKeyRing(
  keyRingSecret: string | undefined,
  activeKeyId: string | undefined,
): Map<string, Uint8Array> {
  if (
    typeof keyRingSecret !== "string" ||
    new TextEncoder().encode(keyRingSecret).byteLength > MAX_KEY_RING_BYTES
  ) {
    throw new Error("Invalid encryption key ring");
  }

  let value: unknown;
  try {
    value = JSON.parse(keyRingSecret);
  } catch {
    throw new Error("Invalid encryption key ring");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid encryption key ring");
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_KEY_COUNT || !isKeyId(activeKeyId)) {
    throw new Error("Invalid encryption key ring");
  }

  const keyRing = new Map<string, Uint8Array>();
  for (const [keyId, encodedKey] of entries) {
    if (!isKeyId(keyId) || typeof encodedKey !== "string") {
      throw new Error("Invalid encryption key ring");
    }
    keyRing.set(keyId, decodeEncryptionSecret(encodedKey));
  }
  if (!keyRing.has(activeKeyId)) {
    throw new Error("Unknown active state key ID");
  }
  return keyRing;
}

function isKeyId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_KEY_ID_LENGTH && KEY_ID.test(value);
}

function parseEnvelope(envelopeText: string): StateEnvelope {
  if (new TextEncoder().encode(envelopeText).byteLength > MAX_ENVELOPE_BYTES) {
    throw new Error("Invalid state envelope");
  }

  let value: unknown;
  try {
    value = JSON.parse(envelopeText);
  } catch {
    throw new Error("Invalid state envelope");
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid state envelope");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== ENVELOPE_VERSION ||
    candidate.algorithm !== ENVELOPE_ALGORITHM ||
    !isKeyId(candidate.keyId) ||
    typeof candidate.nonce !== "string" ||
    typeof candidate.ciphertext !== "string"
  ) {
    throw new Error("Invalid state envelope");
  }
  base64ToBytes(candidate.nonce, NONCE_BYTES);
  const ciphertext = base64ToBytes(candidate.ciphertext);
  if (ciphertext.byteLength < 16) {
    throw new Error("Invalid state envelope");
  }
  return candidate as unknown as StateEnvelope;
}

function base64ToBytes(encoded: string, expectedLength?: number): Uint8Array {
  if (
    encoded.length === 0 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error("Invalid base64 value");
  }
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  if (expectedLength !== undefined && bytes.byteLength !== expectedLength) {
    throw new Error("Invalid state envelope");
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function createBackupKey(stateKey: string): string {
  const random = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `backups/v1/${stateKey}/${Date.now()}-${random}.json`;
}
