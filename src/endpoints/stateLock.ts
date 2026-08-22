import type { Env } from "../types/worker-configuration";
import { badRequest, getStateKey, serverError } from "../state";

export class StateLock {
  async handle(request: Request, env: Env, _context: ExecutionContext, projectName: string) {
    const key = getStateKey(projectName);
    if (key === null) {
      return badRequest("Invalid project name");
    }

    const id = env.TF_STATE_LOCK.idFromName(key);
    const stub = env.TF_STATE_LOCK.get(id);

    try {
      if (request.method === "GET") {
        const response = await stub.fetch("http://internal/lock");
        return new Response(await response.text(), {
          status: response.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }

      if (!["PUT", "LOCK", "DELETE", "UNLOCK"].includes(request.method)) {
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, LOCK, UNLOCK, PUT, DELETE" },
        });
      }

      const internalPath = request.method === "PUT" || request.method === "LOCK"
        ? "lock"
        : "unlock";
      const lockResponse = await stub.fetch(`http://internal/${internalPath}`, {
        method: "POST",
        body: request.body,
      });
      return new Response(await lockResponse.text(), {
        status: lockResponse.status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return serverError();
    }
  }
}
