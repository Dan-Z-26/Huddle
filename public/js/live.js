import { api, openStream } from "./api.js";
import { renderBudget } from "./budgetChart.js";
import { addLiveMessage, updateLiveDirective, updateLiveMessage } from "./chat.js";
import { addToOverview } from "./overview.js";
import { renderAttention } from "./workspace.js";
import { renderTimeline } from "./timeline.js";

let close = null;
let streamUser = null;
// The latest screen state: handlers read it, so a reload doesn't need a new connection.
let latest = null;

// Many events can arrive together; refetching once is enough.
function once(work) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => work().catch(() => {}), 250);
  };
}

/**
 * Keeps the screen live over one event stream per person. Messages and directives are added or
 * updated in place; budget, timeline and attention changes refetch their own panel, so the figures
 * always come from routes that filter by role.
 * @param {{userId: string, eventId: string, isManager: boolean, activeGroupId: () => string | null,
 *   hasPreview: () => boolean, openGroup: (id: string) => void, openBudget: () => void,
 *   openVendors: (categoryId: string) => void,
 *   onUnread: (groupId: string) => void,
 *   onGroupsChanged: () => void, onReconnect: () => void, onBudget: (budget: object) => void,
 *   onQuotes: () => Promise<void>}} ctx
 *   The person, what is on screen, and how to react.
 */
export function startLive(ctx) {
  latest = ctx;
  if (streamUser === latest.userId && close) return;
  close?.();
  streamUser = latest.userId;
  const refetchPlan = once(async () => {
    const [budget, { tasks }] = await Promise.all([
      api.budget(latest.eventId),
      api.timeline(latest.eventId),
    ]);
    // A change being previewed must not be redrawn under the manager's hands.
    if (!latest.hasPreview()) {
      renderBudget(budget);
      latest.onBudget(budget);
    }
    renderTimeline(tasks);
  });
  const refetchTimeline = once(async () => {
    // A vendor has no timeline; their own page only needs their deliverables.
    if (!latest.isVendor) renderTimeline((await api.timeline(latest.eventId)).tasks);
  });
  const refetchAttention = once(async () =>
    renderAttention(
      (await api.me()).attention,
      latest.openGroup,
      latest.openBudget,
      latest.openVendors,
    ),
  );
  const onMessage = ({ message }) => {
    addToOverview(message);
    addLiveMessage(message);
    if (message.groupId !== latest.activeGroupId()) latest.onUnread(message.groupId);
  };
  let opened = false;
  close = openStream(
    {
      "message.created": onMessage,
      "notice.created": onMessage,
      "message.updated": ({ message }) => updateLiveMessage(message),
      "directive.updated": ({ directive }) => updateLiveDirective(directive),
      "budget.updated": refetchPlan,
      "quotes.updated": once(() => latest.onQuotes()),
      "timeline.updated": refetchTimeline,
      "attention.updated": refetchAttention,
      "groups.updated": () => latest.onGroupsChanged(),
    },
    () => {
      // After a dropped connection, catch up on what was missed.
      if (opened) latest.onReconnect();
      opened = true;
    },
  );
}

/** Closes the stream, for example when the person changes. */
export function stopLive() {
  close?.();
  close = null;
  streamUser = null;
}
