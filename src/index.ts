import { StateCreate } from "./endpoints/stateCreate";
import { StateDelete } from "./endpoints/stateDelete";
import { StateFetch } from "./endpoints/stateFetch";
import { StateLock } from "./endpoints/stateLock";
import { DurableState } from "./durableState";
import { authenticate } from "./auth";
import type { Env } from "./types/worker-configuration";

export { DurableState };

const stateCreate = new StateCreate();
const stateDelete = new StateDelete();
const stateFetch = new StateFetch();
const stateLock = new StateLock();

export const router = {
  handle: handleRequest,
};

async function handleRequest(
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> {
  const authentication = await authenticate(request, env);
  if (authentication !== undefined) {
    return authentication;
  }

  const url = new URL(request.url);
  const lockMatch = /^\/([^/]+)\/lock$/.exec(url.pathname);
  if (lockMatch !== null) {
    return stateLock.handle(request, env, context, decodeProjectName(lockMatch[1]));
  }

  const stateMatch = /^\/([^/]+)$/.exec(url.pathname);
  if (stateMatch === null) {
    return notFound();
  }

  const projectName = decodeProjectName(stateMatch[1]);
  switch (request.method) {
    case "GET":
      return stateFetch.handle(request, env, context, projectName);
    case "POST":
      return stateCreate.handle(request, env, context, projectName);
    case "DELETE":
      return stateDelete.handle(request, env, context, projectName);
    default:
      return notFound();
  }
}

function decodeProjectName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  fetch: handleRequest,
} satisfies ExportedHandler<Env>;
