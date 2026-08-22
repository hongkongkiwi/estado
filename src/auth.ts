import type { Env } from "./types/worker-configuration";

const AUTH_SCHEME = "Basic";
const AUTH_REALM = "estado";

/**
 * Authenticate a request with the credentials configured on the Worker.
 * Missing configuration is an authentication failure, so an accidentally
 * deployed Worker never becomes an unauthenticated state server.
 */
export async function authenticate(
  request: Request,
  env: Env,
): Promise<Response | undefined> {
  const expectedUsername = env.ESTADO_USERNAME;
  const expectedPassword = env.ESTADO_PASSWORD;
  const supplied = parseBasicCredentials(request.headers.get("Authorization"));

  const configured =
    typeof expectedUsername === "string" &&
    typeof expectedPassword === "string" &&
    expectedUsername.length > 0 &&
    expectedPassword.length > 0;

  const valid =
    configured &&
    supplied !== null &&
    (await constantTimeEqual(
      `${supplied.username}\u0000${supplied.password}`,
      `${expectedUsername}\u0000${expectedPassword}`,
    ));

  if (valid) {
    return undefined;
  }

  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `${AUTH_SCHEME} realm="${AUTH_REALM}", charset="UTF-8"`,
      "Cache-Control": "no-store",
    },
  });
}

function parseBasicCredentials(
  header: string | null,
): { username: string; password: string } | null {
  if (header === null) {
    return null;
  }

  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (match === null || match[1].length % 4 !== 0) {
    return null;
  }

  try {
    const decoded = atob(match[1]);
    const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const credentials = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    const separator = credentials.indexOf(":");

    if (separator < 0) {
      return null;
    }

    return {
      username: credentials.slice(0, separator),
      password: credentials.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }

  return difference === 0;
}
