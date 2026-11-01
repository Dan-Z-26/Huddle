import { loadAdvice } from "./advice.js";
import { setUpBudgetPage } from "./budgetPage.js";
import { showGroup } from "./chat.js";
import { announceError } from "./dom.js";
import { showView } from "./layout.js";
import { renderOverview } from "./overview.js";
import { setUpVendors } from "./vendors.js";
import { renderGroups } from "./workspace.js";

const $ = (id) => document.getElementById(id);
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
  const { event, template, groups, members, me, isManager, isVendor } = context;
  const { budget, showProposal, reload } = context;

  const drawGroups = () =>
    renderGroups(
      groups,
      view === "group" ? activeGroupId : null,
      (next) => openGroupPage(next, true),
      unread,
    );
  const pageOpener =
    (name, titleId) =>
    (moveFocus = false) => {
      view = name;
      showView(name);
      drawGroups();
      if (moveFocus) $(titleId).focus();
    };
  const openGroupPage = async (group, moveFocus = false) => {
    activeGroupId = group.id;
    view = "group";
    unread.delete(group.id);
    showView("group");
    drawGroups();
    if (moveFocus) $("group-title").focus();
    await showGroup(group, members, { me: me.user, isManager }, () => activeGroupId === group.id);
  };
  const openGroup = (id) => {
    const group = groups.find((item) => item.id === id);
    if (group) openGroupPage(group, true);
  };

  const showOverview = pageOpener("overview", "overview-title");
  const openOverview = async (moveFocus = false) => {
    // The brief is drawn before the first wait, so it can be shown and focused straight away, and
    // someone who moves on while the feed loads isn't pulled back.
    const drawn = renderOverview({ event, template, groups, members, openGroup });
    showOverview(moveFocus);
    await drawn;
  };
  const openTimeline = pageOpener("timeline", "timeline-title");

  const nextStepOpeners = () => ({
    budget: () => $("budget-nav").click(),
    timeline: () => $("timeline-nav").click(),
    vendors: () => $("vendors-nav").click(),
    ask: () => $("what-if-text").focus(),
  });
  const showAskPage = pageOpener("ask", "ask-title");
  const openAsk = (moveFocus = false) => {
    showAskPage(moveFocus);
    if (isManager) loadAdvice(event.id, nextStepOpeners());
  };
  // Proposed changes are all read in one place, wherever they were started.
  const proposeInAsk = (text, data) => {
    openAsk();
    showProposal(text, data);
  };

  const refreshBudgetPage = setUpBudgetPage({
    event,
    me: me.user,
    isManager,
    budget,
    showProposal: proposeInAsk,
    askAbout: (text) => {
      openAsk();
      $("what-if-text").value = text;
      $("what-if-text").focus();
    },
    reload,
  });
  const showBudgetPage = pageOpener("budget", "budget-title");
  const openBudgetPage = async (moveFocus = false) => {
    showBudgetPage(moveFocus);
    await refreshBudgetPage();
  };

  const categories = vendorCategories({ me, template, isManager });
  const canVendors = categories.length > 0;
  document.querySelector(".vendors-nav").hidden = !canVendors;
  const refreshVendors = canVendors
    ? setUpVendors({
        event,
        categories,
        // Starts where something is waiting for this person, not simply on the first category.
        startOn: me.attention.quotes?.[0]?.categoryId ?? me.attention.briefs?.[0]?.categoryId,
        isManager,
        showProposal: proposeInAsk,
      })
    : async () => {};
  const showVendorsPage = pageOpener("vendors", "vendors-title");
  const openVendorsPage = async (moveFocus = false) => {
    showVendorsPage(moveFocus);
    await refreshVendors();
  };

  $("brief-nav").onclick = () => openOverview(true).catch((err) => announceError(err.message));
  $("timeline-nav").onclick = () => openTimeline(true);
  $("flow-open").onclick = () => openTimeline(true);
  $("ask-nav").onclick = () => openAsk(true);
  $("budget-nav").onclick = () => openBudgetPage(true).catch((err) => announceError(err.message));
  if (canVendors) $("vendors-nav").onclick = () => openVendorsPage(true);

  // Everyone opens on the event brief; a vendor, who has no brief page, on their group.
  const openWanted = async () => {
    const first = groups.find(({ id }) => id === activeGroupId) ?? groups[0];
    const wanted = view ?? (isVendor ? "group" : "overview");
    if (wanted === "overview") await openOverview();
    else if (wanted === "vendors" && canVendors) await openVendorsPage();
    else if (wanted === "ask" && isManager) openAsk();
    else if (wanted === "timeline") openTimeline();
    else if (wanted === "budget") await openBudgetPage();
    else if (first) await openGroupPage(first);
  };

  return {
    openWanted,
    openGroup,
    openBudget: () => $("budget-nav").click(),
    openVendorsOn: (categoryId) => {
      $("vendor-category").value = categoryId;
      $("vendors-nav").click();
    },
    activeGroup: () => (view === "group" ? activeGroupId : null),
    noteUnread: (groupId) => {
      unread.set(groupId, (unread.get(groupId) ?? 0) + 1);
      drawGroups();
    },
    // The vendors page is redrawn when a teammate adds a quote, if it is the one on screen.
    quotesChanged: async () => {
      if (view === "vendors") await refreshVendors();
    },
    budgetChanged: () => {
      if (view === "budget") refreshBudgetPage().catch(() => {});
    },
  };
}
