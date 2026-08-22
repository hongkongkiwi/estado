import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src";
import {
  backupExistingState,
  decryptState,
  encryptState,
  MAX_STATE_BYTES,
} from "../src/state";
import type { Env } from "../src/types/worker-configuration";
import { OperationQueue } from "../src/operationQueue";
import mockStateFile from "./terraform/terraform.json";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const username = "test-user";
const password = "test-password";
const currentKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const previousKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const keyRing = JSON.stringify({ current: currentKey, previous: previousKey });
const activeKeyId = "current";
const mockState = JSON.stringify(mockStateFile);

function authHeaders(): Headers {
  return new Headers({
    Authorization: `Basic ${btoa(`${username}:${password}`)}`,
    "Content-Type": "application/json",
  });
}

function request(
  url: string,
  init: RequestInit = {},
  authenticated = true,
): Request {
  const headers = new Headers(init.headers);
  if (authenticated) {
    for (const [name, value] of authHeaders()) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
  }

  return new IncomingRequest(
    `http://example.com${url}`,
    { ...init, headers } as RequestInit<IncomingRequestCfProperties>,
  );
}

async function fetchWorker(input: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(input, env as unknown as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function lockInfo(id: string) {
  return {
    ID: id,
    operation: "apply",
    info: "test lock",
    who: "test-user@example.com",
    version: "1.7.3",
    created: new Date().toISOString(),
    path: "/test/terraform.tfstate",
  };
}

function testBucket(): R2Bucket {
  return (env as typeof env & { TF_STATE_BUCKET: R2Bucket }).TF_STATE_BUCKET;
}

async function backupKeys(project: string): Promise<string[]> {
  const listing = await testBucket().list({ prefix: `backups/v1/${project}.tfstate/` });
  return listing.objects.map((object) => object.key);
}

async function lockState(project: string, info: ReturnType<typeof lockInfo>) {
  return fetchWorker(
    request(`/${project}/lock`, {
      method: "LOCK",
      body: JSON.stringify(info),
    }),
  );
}

async function unlockState(project: string, info: ReturnType<typeof lockInfo>) {
  return fetchWorker(
    request(`/${project}/lock`, {
      method: "UNLOCK",
      body: JSON.stringify(info),
    }),
  );
}

describe("Estado Worker", () => {
  beforeAll(() => {
    const testEnv = env as typeof env & {
      ESTADO_USERNAME: string;
      ESTADO_PASSWORD: string;
      ESTADO_STATE_KEY_RING: string;
      ESTADO_STATE_ACTIVE_KEY_ID: string;
    };
    testEnv.ESTADO_USERNAME = username;
    testEnv.ESTADO_PASSWORD = password;
    testEnv.ESTADO_STATE_KEY_RING = keyRing;
    testEnv.ESTADO_STATE_ACTIVE_KEY_ID = activeKeyId;
  });

  it("rejects requests without Basic authentication", async () => {
    const response = await fetchWorker(request("/auth-missing", {}, false));

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("Basic");
  });

  it("rejects malformed Basic authentication", async () => {
    const response = await fetchWorker(
      request(
        "/auth-malformed",
        { headers: { Authorization: "Basic not-valid-base64" } },
        false,
      ),
    );

    expect(response.status).toBe(401);
  });

  it("rejects traversal-like and invalid state paths", async () => {
    const response = await fetchWorker(request("/bad%5Cpath", { method: "GET" }));
    expect(response.status).toBe(400);

    const invalid = await fetchWorker(request("/-invalid", { method: "GET" }));
    expect(invalid.status).toBe(400);
  });

  it("requires a current lock for state writes", async () => {
    const response = await fetchWorker(
      request("/write-without-lock", { method: "POST", body: mockState }),
    );

    expect(response.status).toBe(423);
    expect(await response.json()).toEqual({ error: "State is not locked" });
  });

  it("returns the existing lock body for lock conflicts", async () => {
    const info = lockInfo("lock-conflict");
    expect((await lockState("lock-conflict", info)).status).toBe(200);

    const conflict = await lockState("lock-conflict", lockInfo("second-lock"));
    expect(conflict.status).toBe(423);
    expect(await conflict.json()).toEqual(info);

    expect((await unlockState("lock-conflict", info)).status).toBe(200);
  });

  it("rejects writes with the wrong lock ID and accepts the owner ID", async () => {
    const info = lockInfo("write-owner");
    expect((await lockState("write-owner", info)).status).toBe(200);

    const wrong = await fetchWorker(
      request("/write-owner?ID=wrong-id", { method: "POST", body: mockState }),
    );
    expect(wrong.status).toBe(423);
    expect(await wrong.json()).toEqual(info);

    const correct = await fetchWorker(
      request("/write-owner?ID=write-owner", { method: "POST", body: mockState }),
    );
    expect(correct.status).toBe(200);

    const stored = await testBucket().get("write-owner.tfstate");
    const storedText = await stored!.text();
    expect(storedText).not.toContain(mockState);
    expect(JSON.parse(storedText)).toMatchObject({
      version: 2,
      algorithm: "AES-256-GCM",
      keyId: activeKeyId,
    });

    const fetched = await fetchWorker(request("/write-owner", { method: "GET" }));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual(mockStateFile);

    expect((await unlockState("write-owner", info)).status).toBe(200);
  });

  it("rejects a stale writer after unlock and relock", async () => {
    const oldInfo = lockInfo("old-lock");
    const newInfo = lockInfo("new-lock");
    expect((await lockState("stale-writer", oldInfo)).status).toBe(200);
    expect((await unlockState("stale-writer", oldInfo)).status).toBe(200);
    expect((await lockState("stale-writer", newInfo)).status).toBe(200);

    const staleWrite = await fetchWorker(
      request("/stale-writer?ID=old-lock", { method: "POST", body: mockState }),
    );
    expect(staleWrite.status).toBe(423);
    expect(await staleWrite.json()).toEqual(newInfo);

    expect((await unlockState("stale-writer", newInfo)).status).toBe(200);
  });

  it("rejects malformed state JSON", async () => {
    const info = lockInfo("invalid-json");
    expect((await lockState("invalid-json", info)).status).toBe(200);

    const response = await fetchWorker(
      request("/invalid-json?ID=invalid-json", { method: "POST", body: "not-json" }),
    );
    expect(response.status).toBe(415);

    expect((await unlockState("invalid-json", info)).status).toBe(200);
  });

  it("fails closed when the encrypted state is tampered with or read with the wrong key", async () => {
    const info = lockInfo("tampered-state");
    expect((await lockState("tampered-state", info)).status).toBe(200);
    expect(
      (
        await fetchWorker(
          request("/tampered-state?ID=tampered-state", { method: "POST", body: mockState }),
        )
      ).status,
    ).toBe(200);

    const stored = await testBucket().get("tampered-state.tfstate");
    const envelope = JSON.parse(await stored!.text()) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -2)}AA==`;
    await testBucket().put("tampered-state.tfstate", JSON.stringify(envelope));
    expect((await fetchWorker(request("/tampered-state", { method: "GET" }))).status).toBe(500);

    const validEnvelope = await encryptState(
      mockState,
      "tampered-state.tfstate",
      keyRing,
      activeKeyId,
    );
    await testBucket().put("tampered-state.tfstate", validEnvelope);
    const testEnv = env as typeof env & { ESTADO_STATE_KEY_RING: string };
    testEnv.ESTADO_STATE_KEY_RING = JSON.stringify({ current: previousKey });
    expect((await fetchWorker(request("/tampered-state", { method: "GET" }))).status).toBe(500);
    testEnv.ESTADO_STATE_KEY_RING = keyRing;

    expect((await unlockState("tampered-state", info)).status).toBe(200);
  });

  it("encrypts with the active key and decrypts a previous key during rotation", async () => {
    const previousEnvelope = await encryptState(
      mockState,
      "rotation-state.tfstate",
      keyRing,
      "previous",
    );
    const currentEnvelope = await encryptState(
      mockState,
      "rotation-state.tfstate",
      keyRing,
      "current",
    );

    expect(JSON.parse(previousEnvelope).keyId).toBe("previous");
    expect(JSON.parse(currentEnvelope).keyId).toBe("current");
    expect(await decryptState(previousEnvelope, "rotation-state.tfstate", keyRing, "current")).toBe(mockState);
    expect(await decryptState(currentEnvelope, "rotation-state.tfstate", keyRing, "current")).toBe(mockState);

    const unknownKeyEnvelope = JSON.stringify({ ...JSON.parse(currentEnvelope), keyId: "retired" });
    await expect(
      decryptState(unknownKeyEnvelope, "rotation-state.tfstate", keyRing, "current"),
    ).rejects.toThrow();
  });

  it("backs up encrypted state before overwrite and delete", async () => {
    const info = lockInfo("backup-state");
    const firstState = JSON.stringify({ version: 1, secret: "first" });
    const secondState = JSON.stringify({ version: 2, secret: "second" });
    expect((await lockState("backup-state", info)).status).toBe(200);

    expect(
      (
        await fetchWorker(
          request("/backup-state?ID=backup-state", { method: "POST", body: firstState }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetchWorker(
          request("/backup-state?ID=backup-state", { method: "POST", body: secondState }),
        )
      ).status,
    ).toBe(200);

    const overwriteBackups = await backupKeys("backup-state");
    expect(overwriteBackups).toHaveLength(1);
    const backupObject = await testBucket().get(overwriteBackups[0]);
    const backupText = await backupObject!.text();
    expect(backupText).not.toContain(firstState);
    expect(await decryptState(backupText, "backup-state.tfstate", keyRing, activeKeyId)).toBe(firstState);

    expect(
      (
        await fetchWorker(
          request("/backup-state", { method: "DELETE" }),
        )
      ).status,
    ).toBe(423);
    const deleted = await fetchWorker(
      request("/backup-state?ID=backup-state", { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    expect(await backupKeys("backup-state")).toHaveLength(2);

    expect((await unlockState("backup-state", info)).status).toBe(200);
  });

  it("leaves the primary untouched when backup preparation fails", async () => {
    const envelope = await encryptState(mockState, "failed-backup.tfstate", keyRing, activeKeyId);
    let primary = envelope;
    const failingBucket = {
      get: async () => ({
        size: primary.length,
        arrayBuffer: async () => new TextEncoder().encode(primary).buffer,
      }),
      head: async () => null,
      put: async () => {
        throw new Error("backup failed");
      },
    } as unknown as R2Bucket;

    await expect(backupExistingState(failingBucket, "failed-backup.tfstate")).rejects.toThrow();
    expect(primary).toBe(envelope);
  });

  it("does not overwrite a primary when its backup envelope is invalid", async () => {
    const info = lockInfo("invalid-backup-primary");
    expect((await lockState("invalid-backup-primary", info)).status).toBe(200);
    expect(
      (
        await fetchWorker(
          request("/invalid-backup-primary?ID=invalid-backup-primary", {
            method: "POST",
            body: mockState,
          }),
        )
      ).status,
    ).toBe(200);

    await testBucket().put("invalid-backup-primary.tfstate", "not-an-envelope");
    const failed = await fetchWorker(
      request("/invalid-backup-primary?ID=invalid-backup-primary", {
        method: "POST",
        body: JSON.stringify({ replacement: true }),
      }),
    );
    expect(failed.status).toBe(500);
    expect(await (await testBucket().get("invalid-backup-primary.tfstate"))!.text()).toBe(
      "not-an-envelope",
    );
    expect((await unlockState("invalid-backup-primary", info)).status).toBe(200);
  });

  it("avoids a backup-key collision", async () => {
    const envelope = await encryptState(mockState, "collision.tfstate", keyRing, activeKeyId);
    let headCalls = 0;
    const writtenKeys: string[] = [];
    const collisionBucket = {
      get: async () => ({
        size: envelope.length,
        arrayBuffer: async () => new TextEncoder().encode(envelope).buffer,
      }),
      head: async () => (headCalls++ === 0 ? {} : null),
      put: async (key: string) => {
        writtenKeys.push(key);
      },
    } as unknown as R2Bucket;

    const backupKey = await backupExistingState(collisionBucket, "collision.tfstate");
    expect(headCalls).toBe(2);
    expect(writtenKeys).toEqual([backupKey]);
  });

  it("rejects state bodies above the configured size limit", async () => {
    const info = lockInfo("oversized-state");
    expect((await lockState("oversized-state", info)).status).toBe(200);
    const oversized = await fetchWorker(
      request(
        "/oversized-state?ID=oversized-state",
        {
          method: "POST",
          body: "{}",
          headers: { "Content-Length": String(MAX_STATE_BYTES + 1) },
        },
      ),
    );
    expect(oversized.status).toBe(413);
    expect((await unlockState("oversized-state", info)).status).toBe(200);
  });

  it("enforces lock ownership for unlock", async () => {
    const info = lockInfo("unlock-owner");
    expect((await lockState("unlock-owner", info)).status).toBe(200);

    const wrong = await unlockState("unlock-owner", lockInfo("wrong-owner"));
    expect(wrong.status).toBe(423);
    expect(await wrong.json()).toEqual(info);

    expect((await unlockState("unlock-owner", info)).status).toBe(200);
    const lock = await fetchWorker(request("/unlock-owner/lock", { method: "GET" }));
    expect(await lock.json()).toBeNull();
  });

  it("deletes the R2 object only for the lock owner", async () => {
    const info = lockInfo("delete-owner");
    expect((await lockState("delete-owner", info)).status).toBe(200);

    const write = await fetchWorker(
      request("/delete-owner?ID=delete-owner", { method: "POST", body: mockState }),
    );
    expect(write.status).toBe(200);

    const wrong = await fetchWorker(
      request("/delete-owner?ID=wrong-id", { method: "DELETE" }),
    );
    expect(wrong.status).toBe(423);

    const deleted = await fetchWorker(
      request("/delete-owner?ID=delete-owner", { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    const testEnv = env as typeof env & { TF_STATE_BUCKET: R2Bucket };
    expect(await testEnv.TF_STATE_BUCKET.get("delete-owner.tfstate")).toBeNull();

    expect((await unlockState("delete-owner", info)).status).toBe(200);
    expect((await fetchWorker(request("/delete-owner", { method: "GET" }))).status).toBe(204);
  });

  it("allows an unlocked delete without an ID", async () => {
    const info = lockInfo("unlocked-delete");
    expect((await lockState("unlocked-delete", info)).status).toBe(200);
    expect(
      (
        await fetchWorker(
          request("/unlocked-delete?ID=unlocked-delete", {
            method: "POST",
            body: mockState,
          }),
        )
      ).status,
    ).toBe(200);
    expect((await unlockState("unlocked-delete", info)).status).toBe(200);

    const deleted = await fetchWorker(request("/unlocked-delete", { method: "DELETE" }));
    expect(deleted.status).toBe(200);
    const testEnv = env as typeof env & { TF_STATE_BUCKET: R2Bucket };
    expect(await testEnv.TF_STATE_BUCKET.get("unlocked-delete.tfstate")).toBeNull();
  });

  it("returns 405 for unsupported lock methods", async () => {
    const response = await fetchWorker(
      request("/unsupported-method/lock", { method: "POST", body: "{}" }),
    );
    expect(response.status).toBe(405);
  });

  it("returns 400 for malformed lock information", async () => {
    const response = await fetchWorker(
      request("/malformed-lock/lock", { method: "LOCK", body: "{}" }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects lock JSON larger than 16 KiB before parsing", async () => {
    const response = await fetchWorker(
      request("/oversized-lock/lock", {
        method: "LOCK",
        body: JSON.stringify({ oversized: "x".repeat(16 * 1024) }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("serializes deferred write and delete operations in order", async () => {
    const queue = new OperationQueue();
    const events: string[] = [];
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const write = queue.run(async () => {
      events.push("write-start");
      await writeGate;
      events.push("write-end");
    });
    const deleteOperation = queue.run(async () => {
      events.push("delete");
    });

    await Promise.resolve();
    expect(events).toEqual(["write-start"]);
    releaseWrite();
    await Promise.all([write, deleteOperation]);
    expect(events).toEqual(["write-start", "write-end", "delete"]);
  });

  it("releases the queue after a failed operation", async () => {
    const queue = new OperationQueue();
    const followup = queue.run(async () => {
      throw new Error("first operation failed");
    });
    await expect(followup).rejects.toThrow("first operation failed");
    await expect(queue.run(async () => "completed")).resolves.toBe("completed");
  });
});
