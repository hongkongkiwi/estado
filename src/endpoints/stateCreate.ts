import type { Env } from "../types/worker-configuration";
import {
  badRequest,
  getStateKey,
  mutateState,
  serverError,
} from "../state";

export class StateCreate {
  async handle(request: Request, env: Env, _context: ExecutionContext, projectName: string) {
    const key = getStateKey(projectName);
    if (key === null) {
      return badRequest("Invalid project name");
    }

    try {
      return await mutateState(
        request,
        env,
        key,
        new URL(request.url).searchParams.get("ID"),
      );
    } catch {
      return serverError();
    }
  }
}
