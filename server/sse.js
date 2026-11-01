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

// Decided at send time from the store, so a change of membership applies at once. Budget changes
// are only a nudge to refetch: the figures themselves come from routes that filter by role.
function mayReceive(store, user, event) {
  if (GROUP_EVENTS.has(event.type)) {
    const group = store.groups.get(event.groupId);
    return Boolean(group) && canView(store.roleOf(user), { type: "group", group });
  }
  // Only a nudge to refetch, which routes that filter by role answer.
  if (event.type === "budget.updated" || event.type === "quotes.updated")
    return user.kind === "manager" || user.kind === "core";
  return true;
}

/**
 * Keeps the open event streams and sends each event only to the people who may see it.
 * @param {{heartbeatMs?: number}} [options] The heartbeat interval, for tests.
 * @returns {{add: Function, send: Function, size: () => number, close: () => void}} The hub.
 */
export function createHub({ heartbeatMs = HEARTBEAT_MS } = {}) {
  const clients = new Set();

  const write = (client, chunk) => {
    try {
      // A client that isn't reading would make the server hold its events in memory.
      if (client.res.writableLength > MAX_BUFFERED_BYTES) {
        client.res.end();
        clients.delete(client);
        return;
      }
      client.res.write(chunk);
    } catch {
      clients.delete(client);
    }
  };
  // A comment line keeps proxies from closing a quiet connection.
  const beat = setInterval(() => {
    for (const client of clients) write(client, ": heartbeat\n\n");
  }, heartbeatMs);
  beat.unref();

  return {
    /**
     * Opens a stream for one person.
     * @param {import("express").Response} res The response to stream on.
     * @param {object} user The person.
     * @param {string} [sessionId] Their session: the stream ends with it.
     * @param {string} [address] Where they connect from.
     * @returns {boolean} False when there are too many connections, in total, for this person or
     *   from this address.
     */
    add(res, user, sessionId, address) {
      const all = [...clients];
      if (
        clients.size >= MAX_CLIENTS ||
        all.filter((client) => client.userId === user.id).length >= MAX_PER_USER ||
        all.filter((client) => client.address === address).length >= MAX_PER_ADDRESS
      )
        return false;
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
      return true;
    },
    /**
     * Sends an event to everyone in its event who may see it.
     * @param {object} store The store.
     * @param {{type: string, eventId: string}} event The event, with its payload.
     */
    send(store, event) {
      const frame = (payload) => `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;
      const data = frame(event);
      for (const client of clients) {
        const session = store.sessions.get(client.sessionId);
        if (client.sessionId && (!session || sessionExpired(session))) {
          client.res.end();
          clients.delete(client);
          continue;
        }
        const user = store.users.get(client.userId);
        if (user?.eventId === event.eventId && mayReceive(store, user, event))
          write(
            client,
            user.kind === "vendor" ? frame(redactEventForVendor(event, user.id)) : data,
          );
      }
    },
    size: () => clients.size,
    close() {
      clearInterval(beat);
      for (const client of clients) client.res.end();
      clients.clear();
    },
  };
}
