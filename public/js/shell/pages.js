/** The sidebar's pages: which one is open, and what opening each one does. */
import { loadAdvice } from "../budget/advice.js";
import { setUpBudgetPage } from "../budget/budgetPage.js";
import { showGroup } from "../chat/chat.js";
import { $, announceError } from "../shared/dom.js";
import { setUpVendors } from "../vendors/vendors.js";
import { showView } from "./layout.js";
import { renderOverview } from "./overview.js";
import { renderGroups } from "./workspace.js";

let activeGroupId = null;
let view = null;
const unread = new Map();

/** A new person starts from their own first page, not the last person's. */
export function resetView() {
  activeGroupId = null;
  view = null;
  unread.clear();
}

// Vendors and quotes are for the manager and the core members who own a category.
function vendorCategories({ me, template, isManager }) {
  const mine = isManager
    ? template.categories
    : template.categories.filter(({ id }) => me.user.categoryIds?.includes(id));
  return me.permissions.viewQuotes && mine.length > 0 ? mine : [];
}

function drawGroups(nav) {
  renderGroups(
    nav.groups,
    view === "group" ? activeGroupId : null,
    (group) => openGroupPage(nav, group, true),
    unread,
  );
}

function openPage(nav, name, titleId, moveFocus) {
  view = name;
  showView(name);
  drawGroups(nav);
  if (moveFocus) $(titleId).focus();
}

async function openGroupPage(nav, group, moveFocus = false) {
  activeGroupId = group.id;
  unread.delete(group.id);
  openPage(nav, "group", "group-title", moveFocus);
  const who = { me: nav.me.user, isManager: nav.isManager };
  await showGroup(group, nav.members, who, () => activeGroupId === group.id);
}

function openGroupById(nav, id) {
  const group = nav.groups.find((item) => item.id === id);
  if (group) openGroupPage(nav, group, true);
}

// The brief is drawn before the first wait, so it can be shown and focused straight away, and
// someone who moves on while the feed loads isn't pulled back.
async function openOverview(nav, moveFocus = false) {
  const { event, template, groups, members } = nav;
  const openGroup = (id) => openGroupById(nav, id);
  const drawn = renderOverview({ event, template, groups, members, openGroup });
  openPage(nav, "overview", "overview-title", moveFocus);
  await drawn;
}

const nextStepOpeners = () => ({
  budget: () => $("budget-nav").click(),
  timeline: () => $("timeline-nav").click(),
  vendors: () => $("vendors-nav").click(),
  ask: () => $("what-if-text").focus(),
});

function openAsk(nav, moveFocus = false) {
  openPage(nav, "ask", "ask-title", moveFocus);
  if (nav.isManager) loadAdvice(nav.event.id, nextStepOpeners());
}

async function openBudgetPage(nav, moveFocus = false) {
  openPage(nav, "budget", "budget-title", moveFocus);
  await nav.refreshBudget();
}

async function openVendorsPage(nav, moveFocus = false) {
  openPage(nav, "vendors", "vendors-title", moveFocus);
  await nav.refreshVendors();
}

function setUpPages(nav) {
  const { event, me, isManager, budget, reload } = nav;
  // Proposed changes are all read in one place, wherever they were started.
  const showProposal = (text, data) => {
    openAsk(nav);
    nav.showProposal(text, data);
  };
  nav.refreshBudget = setUpBudgetPage({
    event,
    me: me.user,
    isManager,
    budget,
    showProposal,
    askAbout: (text) => {
      openAsk(nav);
      $("what-if-text").value = text;
      $("what-if-text").focus();
    },
    reload,
  });
  const categories = vendorCategories(nav);
  nav.canVendors = categories.length > 0;
  document.querySelector(".vendors-nav").hidden = !nav.canVendors;
  nav.refreshVendors = nav.canVendors
    ? setUpVendors({
        event,
        categories,
        // Starts where something is waiting for this person, not simply on the first category.
        startOn: me.attention.quotes?.[0]?.categoryId ?? me.attention.briefs?.[0]?.categoryId,
        isManager,
        showProposal,
      })
    : async () => {};
}

function wireSidebar(nav) {
  const reportingErrors = (open) => () => open().catch((err) => announceError(err.message));
  const openTimeline = () => openPage(nav, "timeline", "timeline-title", true);
  $("brief-nav").onclick = reportingErrors(() => openOverview(nav, true));
  $("timeline-nav").onclick = openTimeline;
  $("flow-open").onclick = openTimeline;
  $("ask-nav").onclick = () => openAsk(nav, true);
  $("budget-nav").onclick = reportingErrors(() => openBudgetPage(nav, true));
  if (nav.canVendors) $("vendors-nav").onclick = () => openVendorsPage(nav, true);
}

// Everyone opens on the event brief; a vendor, who has no brief page, on their group.
async function openWanted(nav) {
  const first = nav.groups.find(({ id }) => id === activeGroupId) ?? nav.groups[0];
  const openers = {
    overview: () => openOverview(nav),
    timeline: () => openPage(nav, "timeline", "timeline-title", false),
    budget: () => openBudgetPage(nav),
    ...(nav.canVendors ? { vendors: () => openVendorsPage(nav) } : {}),
    ...(nav.isManager ? { ask: () => openAsk(nav) } : {}),
  };
  const opener = openers[view ?? (nav.isVendor ? "group" : "overview")];
  if (opener) await opener();
  else if (first) await openGroupPage(nav, first);
}

/**
 * Wires the sidebar's pages for this person and this event.
 * @param {{event: object, template: object, groups: object[], members: object[], me: object,
 *   isManager: boolean, isVendor: boolean, budget: () => object,
 *   showProposal: (text: string, data: object) => void, reload: () => Promise<void>}} context
 *   What the pages draw, and how to show a proposed change and redraw everything.
 * @returns {object} What the live stream and the first draw need: `openWanted`, `openGroup`,
 *   `openBudget`, `openVendorsOn`, `activeGroup`, `noteUnread`, `quotesChanged`, `budgetChanged`.
 */
export function createPages(context) {
  const nav = { ...context };
  setUpPages(nav);
  wireSidebar(nav);
  return {
    openWanted: () => openWanted(nav),
    openGroup: (id) => openGroupById(nav, id),
    openBudget: () => $("budget-nav").click(),
    openVendorsOn: (categoryId) => {
      $("vendor-category").value = categoryId;
      $("vendors-nav").click();
    },
    activeGroup: () => (view === "group" ? activeGroupId : null),
    noteUnread: (groupId) => {
      unread.set(groupId, (unread.get(groupId) ?? 0) + 1);
      drawGroups(nav);
    },
    // The vendors page is redrawn when a teammate adds a quote, if it is the one on screen.
    quotesChanged: async () => {
      if (view === "vendors") await nav.refreshVendors();
    },
    budgetChanged: () => {
      if (view === "budget") nav.refreshBudget().catch(() => {});
    },
  };
}
