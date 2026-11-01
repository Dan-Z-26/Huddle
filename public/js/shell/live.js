/** Keeps the screen up to date over the live stream. */
import { renderBudget } from "../budget/budgetChart.js";
import { addLiveMessage, updateLiveDirective, updateLiveMessage } from "../chat/chat.js";
import { api, openStream } from "../shared/api.js";
import { renderTimeline } from "../timeline/timeline.js";
import { addToOverview } from "./overview.js";
import { renderAttention } from "./workspace.js";

const SETTLE_MS = 250;
let close = null;
let streamUser = null;
// The latest screen state: handlers read it, so a reload doesn't need a new connection.
let latest = null;

// Many events can arrive together; refetching once is enough.
function once(work) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => work().catch(() => {}), SETTLE_MS);
  };
}

async function refetchPlan() {
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
}

// A vendor has no timeline; their own page only needs their deliverables.
async function refetchTimeline() {
  if (!latest.isVendor) renderTimeline((await api.timeline(latest.eventId)).tasks);
}

async function refetchAttention() {
  const { attention } = await api.me();
  renderAttention(attention, latest.openGroup, latest.openBudget, latest.openVendors);
}

function onMessage({ message }) {
  addToOverview(message);
  addLiveMessage(message);
  if (message.groupId !== latest.activeGroupId()) latest.onUnread(message.groupId);
}

/**
 * Keeps the screen live over one event stream per person. Messages and directives are added or
 * updated in place; budget, timeline and attention changes refetch their own panel, so the figures
 * always come from routes that filter by role.
 * @param {{userId: string, eventId: string, isVendor: boolean, activeGroupId: () => string | null,
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
  let opened = false;
  close = openStream(
    {
      "message.created": onMessage,
      "notice.created": onMessage,
      "message.updated": ({ message }) => updateLiveMessage(message),
      "directive.updated": ({ directive }) => updateLiveDirective(directive),
      "budget.updated": once(refetchPlan),
      "quotes.updated": once(() => latest.onQuotes()),
      "timeline.updated": once(refetchTimeline),
      "attention.updated": once(refetchAttention),
      "groups.updated": () => latest.onGroupsChanged(),
    },
    () => {
      // After a dropped connection, catch up on what was missed.
      if (opened) latest.onReconnect();
      opened = true;
    },
  );
}
