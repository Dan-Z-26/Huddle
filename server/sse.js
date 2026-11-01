/** Live updates over Server-Sent Events: one stream per client, filtered by what they may see. */
import { canView } from "./core/permissions.js";
import { sessionExpired } from "./http.js";
import { redactEventForVendor } from "./views.js";

const HEARTBEAT_MS = 25_000;
const MAX_CLIENTS = 200;
const MAX_PER_USER = 5;
// A new event makes new people, so a per-person limit alone would let one client take them all.
const MAX_PER_ADDRESS = 30;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const GROUP_EVENTS = new Set([
  "message.created",
  "notice.created",
  "message.updated",
  "directive.updated",
]);
// Only a nudge to refetch, which routes that filter by role answer.
const TEAM_NUDGES = new Set(["budget.updated", "quotes.updated"]);

const frame = (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

// Decided at send time from the store, so a change of membership applies at once.
function mayReceive(store, user, event) {
  if (GROUP_EVENTS.has(event.type)) {
    const group = store.groups.get(event.groupId);
    return Boolean(group) && canView(store.roleOf(user), { type: "group", group });
  }
  if (TEAM_NUDGES.has(event.type)) return user.kind === "manager" || user.kind === "core";
  return true;
}

// A client that isn't reading would make the server hold its events in memory.
function write(clients, client, chunk) {
  try {
    if (client.res.writableLength > MAX_BUFFERED_BYTES) {
      client.res.end();
      clients.delete(client);
      return;
    }
    client.res.write(chunk);
  } catch {
    clients.delete(client);
  }
}

function hasRoom(clients, userId, address) {
  const all = [...clients];
  return (
    clients.size < MAX_CLIENTS &&
    all.filter((client) => client.userId === userId).length < MAX_PER_USER &&
    all.filter((client) => client.address === address).length < MAX_PER_ADDRESS
  );
}

function openStream(clients, { res, user, sessionId, address }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const client = { res, userId: user.id, sessionId, address };
  clients.add(client);
  res.on("close", () => clients.delete(client));
}

// A stream ends with its session, whether that was signed out or ran out of time.
function sessionEnded(store, { sessionId }) {
  if (!sessionId) return false;
  const session = store.sessions.get(sessionId);
  return !session || sessionExpired(session);
}

function sendToAll(clients, store, event) {
  const data = frame(event);
  for (const client of clients) {
    if (sessionEnded(store, client)) {
      client.res.end();
      clients.delete(client);
      continue;
    }
    const user = store.users.get(client.userId);
    if (user?.eventId === event.eventId && mayReceive(store, user, event))
      write(
        clients,
        client,
        user.kind === "vendor" ? frame(redactEventForVendor(event, user.id)) : data,
      );
  }
}

/**
 * Keeps the open event streams and sends each event only to the people who may see it.
 * @param {{heartbeatMs?: number}} [options] The heartbeat interval, for tests.
 * @returns {{add: Function, send: Function, size: () => number, close: () => void}} The hub. `add`
 *   opens a stream for a person, and returns false when there are too many connections in total,
 *   for this person or from this address.
 */
export function createHub({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Set();
  // A comment line keeps proxies from closing a quiet connection.
  const beat = setInterval(() => {
    for (const client of clients) write(clients, client, ": heartbeat\n\n");
  }, heartbeatMs);
  beat.unref();
  return {
    add(res, user, sessionId, address) {
      if (!hasRoom(clients, user.id, address)) return false;
      openStream(clients, { res, user, sessionId, address });
      return true;
    },
    send: (store, event) => sendToAll(clients, store, event),
    size: () => clients.size,
    close() {
      clearInterval(beat);
      for (const client of clients) client.res.end();
      clients.clear();
    },
  };
}
