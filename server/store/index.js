/** The in-memory store: plain Maps behind a few small functions. It resets when the server does. */
import { randomUUID } from "node:crypto";

const DEFAULT_PAGE_SIZE = 50;
const MAX_SESSIONS = 5000;
const MAX_PAGE_SIZE = 100;

// One page of a group's history, oldest first within the page. `before` is an exclusive message id;
// an id that isn't in this group gives an empty page.
function pageOfHistory(messages, groupId, { before, limit = DEFAULT_PAGE_SIZE } = {}) {
  const history = [...messages.values()].filter((message) => message.groupId === groupId);
  const end = before == null ? history.length : history.findIndex(({ id }) => id === before);
  if (end === -1) return { messages: [], nextBefore: null };
  const size = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const start = Math.max(end - size, 0);
  return {
    messages: history.slice(start, end),
    nextBefore: start > 0 ? history[start].id : null,
  };
}

// The groups a person belongs to, within their own event only.
function groupsOf(groups, user) {
  const seesAll = user.kind === "manager" || user.kind === "agent";
  return [...groups.values()].filter(
    (group) =>
      group.eventId === user.eventId && (seesAll || group.memberRoleIds.includes(user.roleId)),
  );
}

// At the limit the same person's oldest session goes first, so signing in over and over only pushes
// out oneself.
function dropOldSession(sessions, userId, newId) {
  if (sessions.size <= MAX_SESSIONS) return;
  const own = [...sessions].find(([id, session]) => session.userId === userId && id !== newId);
  sessions.delete(own?.[0] ?? sessions.keys().next().value);
}

/**
 * Creates an empty in-memory store. Messages must be inserted oldest first: pages rely on Map order.
 * @returns {object} Maps for each entity, and the functions that read across them.
 */
export function createStore() {
  const groups = new Map();
  const messages = new Map();
  const groupsForUser = (user) => groupsOf(groups, user);
  return {
    events: new Map(),
    users: new Map(),
    groups,
    messages,
    directives: new Map(),
    files: new Map(),
    quotes: new Map(),
    tasks: new Map(),
    budgets: new Map(),
    expenses: new Map(),
    briefs: new Map(),
    deliverables: new Map(),
    invites: new Map(),
    sessions: new Map(),
    pendingChanges: new Map(),
    adviceCache: new Map(),
    digests: new Map(),
    rfqPosted: new Set(),
    /** Work running after a response was sent, so tests can wait for it. */
    background: new Set(),
    /**
     * Keeps hold of work that runs on after a response was sent.
     * @param {Promise<*>} work The work.
     * @returns {Promise<*>} The same work.
     */
    track(work) {
      const done = () => this.background.delete(work);
      this.background.add(work);
      work.then(done, done);
      return work;
    },
    /** Tells open streams about a change; the app replaces this with its hub. */
    publish() {},
    /** Removes files from disk once their records are gone; the app replaces this. */
    discardFiles() {},
    /** Hears that someone signed in; the demo's teammates replace this. */
    onSignIn() {},
    /** Hears what people just did, by kind; the demo's teammates replace this to answer back. */
    onActivity() {},
    /**
     * Tells open streams that things changed for an event, for them to refetch.
     * @param {string} eventId The event.
     * @param {...string} types What changed, such as "budget.updated".
     */
    nudge(eventId, ...types) {
      for (const type of types) this.publish({ type, eventId });
    },
    /**
     * Starts a server-side session: the cookie only ever holds this random id.
     * @param {string} userId The person.
     * @param {{invited?: boolean}} [options] `invited` came through a vendor's invite link.
     * @returns {string} The session id.
     */
    openSession(userId, { invited = false } = {}) {
      const id = randomUUID();
      this.sessions.set(id, { userId, invited, startedAt: Date.now() });
      dropOldSession(this.sessions, userId, id);
      return id;
    },
    /** @returns {object[]} The people on an event: everyone but its AI members. */
    peopleOf(eventId) {
      return [...this.users.values()].filter(
        (user) => user.eventId === eventId && user.kind !== "agent",
      );
    },
    /** @returns {object[]} One event's tasks. */
    tasksForEvent(eventId) {
      return [...this.tasks.values()].filter((task) => task.eventId === eventId);
    },
    /** @returns {object[]} One event's directives; each belongs to a group in the event. */
    directivesForEvent(eventId) {
      const ids = new Set(
        [...groups.values()].filter((group) => group.eventId === eventId).map(({ id }) => id),
      );
      return [...this.directives.values()].filter(({ groupId }) => ids.has(groupId));
    },
    /**
     * @param {string} groupId The group.
     * @param {{before?: string, limit?: number}} [page] Which page of its history.
     * @returns {{messages: object[], nextBefore: string | null}} The page.
     */
    messagesForGroup: (groupId, page) => pageOfHistory(messages, groupId, page),
    groupsForUser,
    /**
     * Builds the role object that core permission checks take.
     * @param {object} user The person.
     * @returns {{kind: string, roleId: string, eventId: string, categoryIds: string[],
     *   groupIds: string[]}} Their role.
     */
    roleOf: (user) => ({
      kind: user.kind,
      roleId: user.roleId,
      eventId: user.eventId,
      categoryIds: user.categoryIds,
      groupIds: groupsForUser(user).map((group) => group.id),
    }),
  };
}
