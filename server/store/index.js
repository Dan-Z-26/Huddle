const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Creates an empty in-memory store. Messages must be inserted oldest first: pages rely on Map order.
 * @returns {object} Maps for each entity, plus messagesForGroup, groupsForUser and roleOf.
 */
export function createStore() {
  const messages = new Map();
  const groups = new Map();

  /**
   * Returns one page of a group's history, oldest first within the page.
   * @param {string} groupId
   * @param {{ before?: string, limit?: number }} [page] `before` is an exclusive message id; an id
   *   that isn't in this group gives an empty page.
   * @returns {{ messages: object[], nextBefore: string | null }}
   */
  function messagesForGroup(groupId, { before, limit = DEFAULT_PAGE_SIZE } = {}) {
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

  /**
   * Lists the groups a user belongs to, within the user's own event only.
   * @param {object} user
   * @returns {object[]}
   */
  function groupsForUser(user) {
    const seesAll = user.kind === "manager" || user.kind === "agent";
    return [...groups.values()].filter(
      (group) =>
        group.eventId === user.eventId && (seesAll || group.memberRoleIds.includes(user.roleId)),
    );
  }

  /**
   * Builds the role object that core permission checks take.
   * @param {object} user
   * @returns {{ kind: string, roleId: string, categoryIds: string[], groupIds: string[] }}
   */
  function roleOf(user) {
    return {
      kind: user.kind,
      roleId: user.roleId,
      eventId: user.eventId,
      categoryIds: user.categoryIds,
      groupIds: groupsForUser(user).map((group) => group.id),
    };
  }

  return {
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
    events: new Map(),
    users: new Map(),
    groups,
    messages,
    directives: new Map(),
    files: new Map(),
    quotes: new Map(),
    tasks: new Map(),
    budgets: new Map(),
    pendingChanges: new Map(),
    digests: new Map(),
    /** Tells open streams about a change; the app replaces this with its hub. */
    publish() {},
    /** Work running after a response was sent, so tests can wait for it. */
    background: new Set(),
    /** Removes files from disk once their records are gone; the app replaces this. */
    discardFiles() {},
    rfqPosted: new Set(),
    messagesForGroup,
    groupsForUser,
    roleOf,
  };
}
