import type { Env } from "../types/worker-configuration";
import {
  badRequest,
  decryptState,
  getStateKey,
  MAX_ENVELOPE_BYTES,
  serverError,
} from "../state";

export class StateFetch {
  async handle(request: Request, env: Env, _context: ExecutionContext, projectName: string) {
    const key = getStateKey(projectName);
    if (key === null) {
      return badRequest("Invalid project name");
    }

    try {
      const state: R2ObjectBody | null = await env.TF_STATE_BUCKET.get(key);
      if (state === null) {
        return new Response(null, { status: 204 });
      }
      if (state.size > MAX_ENVELOPE_BYTES) {
        return serverError();
      }

      const plaintext = await decryptState(
        await state.text(),
        key,
        env.ESTADO_STATE_KEY_RING,
        env.ESTADO_STATE_ACTIVE_KEY_ID,
      );
      return new Response(plaintext, {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return serverError();
    }
  }
}
