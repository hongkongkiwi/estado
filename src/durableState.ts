import type { LockInfo } from "./types/terraform";
import { DurableObject } from "cloudflare:workers";
import {
  backupExistingState,
  encryptState,
  getStateKey,
  isLockInfo,
  lockResponse,
  MAX_LOCK_BYTES,
  readLimitedBody,
} from "./state";
import { OperationQueue } from "./operationQueue";
import type { Env } from "./types/worker-configuration";

export class DurableState extends DurableObject<Env> {
  private readonly operations = new OperationQueue();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/lock") {
      return this.operations.run(async () => jsonResponse(await this.getLockInfo()));
    }

    if (request.method === "POST" && url.pathname === "/lock") {
      const info = await parseLockInfo(request);
      if (info === null) {
        return jsonResponse({ error: "Invalid lock information" }, 400);
      }

      const result = await this.tryLock(info);
      return result.acquired
        ? new Response(null, { status: 200 })
        : lockResponse(result.current);
    }

    if (request.method === "POST" && url.pathname === "/unlock") {
      const info = await parseLockInfo(request);
      if (info === null) {
        return jsonResponse({ error: "Invalid lock information" }, 400);
      }

      const result = await this.tryUnlock(info);
      return result.released
        ? new Response(null, { status: 200 })
        : lockResponse(result.current);
    }

    if (url.pathname === "/state" && (request.method === "PUT" || request.method === "DELETE")) {
      return this.mutateState(request, url);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  async lock(info: LockInfo): Promise<boolean> {
    if (!isLockInfo(info)) {
      return false;
    }
    return (await this.tryLock(info)).acquired;
  }

  private async tryLock(info: LockInfo): Promise<{ acquired: boolean; current: LockInfo | null }> {
    return this.operations.run(async () => {
      const currentLock = await this.getLockInfo();
      if (currentLock === null) {
        await this.ctx.storage.put("lock", info);
        return { acquired: true, current: null };
      }
      return { acquired: false, current: currentLock };
    });
  }

  async unlock(info: LockInfo): Promise<boolean> {
    return (await this.tryUnlock(info)).released;
  }

  private async tryUnlock(info: LockInfo): Promise<{ released: boolean; current: LockInfo | null }> {
    return this.operations.run(async () => {
      const currentLock = await this.getLockInfo();
      if (currentLock && currentLock.ID === info.ID) {
        await this.ctx.storage.delete("lock");
        return { released: true, current: null };
      }
      return { released: false, current: currentLock };
    });
  }

  async getLockInfo(): Promise<LockInfo | null> {
    return (await this.ctx.storage.get<LockInfo>("lock")) ?? null;
  }

  private async mutateState(request: Request, url: URL): Promise<Response> {
    const keyParameter = url.searchParams.get("key") ?? "";
    const projectName = keyParameter.endsWith(".tfstate")
      ? keyParameter.slice(0, -".tfstate".length)
      : "";
    const key = getStateKey(projectName);
    const requestedId = request.headers.get("X-Estado-Lock-ID");
    return this.operations.run(async () => {
      let response = jsonResponse({ error: "Internal server error" }, 500);
      const currentLock = await this.getLockInfo();
      if (
        (currentLock === null &&
          !(request.method === "DELETE" &&
            (requestedId === null || requestedId === ""))) ||
        (currentLock !== null && requestedId !== currentLock.ID)
      ) {
        return lockResponse(currentLock);
      }

      if (key === null) {
        return jsonResponse({ error: "Invalid state key" }, 400);
      }

      try {
        if (request.method === "PUT") {
          const stateBody = await readLimitedBody(request);
          if (stateBody?.tooLarge) {
            return jsonResponse({ error: "State body is too large" }, 413);
          }
          try {
            JSON.parse(stateBody?.body ?? "");
          } catch {
            return jsonResponse({ error: "Invalid state JSON" }, 415);
          }
          const encryptedState = await encryptState(
            stateBody?.body ?? "",
            key,
            this.env.ESTADO_STATE_KEY_RING,
            this.env.ESTADO_STATE_ACTIVE_KEY_ID,
          );
          await backupExistingState(this.env.TF_STATE_BUCKET, key);
          await this.env.TF_STATE_BUCKET.put(key, encryptedState, {
            httpMetadata: { contentType: "application/json" },
          });
        } else {
          await backupExistingState(this.env.TF_STATE_BUCKET, key);
          await this.env.TF_STATE_BUCKET.delete(key);
        }
        response = new Response(null, { status: 200 });
      } catch {
        response = jsonResponse({ error: "Internal server error" }, 500);
      }
      return response;
    });
  }
}

async function parseLockInfo(request: Request): Promise<LockInfo | null> {
  try {
    const body = await readLimitedBody(request, MAX_LOCK_BYTES);
    if (body.tooLarge) {
      return null;
    }
    const value: unknown = JSON.parse(body.body);
    return isLockInfo(value) ? value : null;
  } catch {
    return null;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
