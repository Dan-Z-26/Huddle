import { api } from "./api.js";
import { renderBrief, countdown } from "./brief.js";
import { renderBudget } from "./budgetChart.js";
import { setUpBudgetPage } from "./budgetPage.js";
import { hideConsequences, setUpWhatIf } from "./consequences.js";
import { showGroup } from "./chat.js";
import { announce, announceError, formatDate } from "./dom.js";
import { setUpGroupsAdmin } from "./groupsAdmin.js";
import { loadAdvice } from "./advice.js";
import { hideIdeas, setUpIdeas } from "./ideas.js";
import { startIntake } from "./intake.js";
import { renderTimeline, setTimelineGroups, setUpTimelineTools } from "./timeline.js";
import { bump } from "./session.js";
import { setUpVendors } from "./vendors.js";
import { setUpNewEvent } from "./newEvent.js";
import { showSignIn } from "./signin.js";
import { renderVendorHome } from "./vendorHome.js";
import { startLive } from "./live.js";
import { renderAttention, renderGroups } from "./workspace.js";

const show = (id, visible) => (document.getElementById(id).hidden = !visible);
let activeGroupId = null;
let shownBudget = null;
let wasSettingUp = null;
let view = null;
const unread = new Map();
const previewOpen = () => !document.getElementById("consequences").hidden;

// A new person starts from their own first page, not the last person's.
function resetView() {
  activeGroupId = null;
  view = null;
  unread.clear();
}

async function signedIn() {
  try {
    return await api.me();
  } catch (err) {
    if (err.status !== 401) throw err;
    return null;
  }
}

// A full reload on sign-in: nothing drawn for the last person can stay on the page for the next.
const signInAgain = () => showSignIn(async () => location.assign("/"));

function setUpPlanTools(event) {
  const whatIf = setUpWhatIf(event, {
    currentBudget: () => shownBudget,
    onApplied: async (notices) => {
      await load();
      const summary = document.getElementById("budget-summary").textContent;
      const told = notices
        ? ` ${notices} ${notices === 1 ? "group was" : "groups were"} notified.`
        : "";
      announce(`Change applied. ${summary}${told}`);
      document.getElementById("what-if-text").focus();
    },
  });
  setUpTimelineTools(event, load);
  return whatIf.show;
}

async function loadPlan(event, isManager, groups) {
  const [budget, { tasks }] = await Promise.all([api.budget(event.id), api.timeline(event.id)]);
  shownBudget = budget;
  renderBudget(budget);
  setTimelineGroups(groups);
  renderTimeline(tasks);
  show("ask-nav", isManager);
  show("timeline-tools", isManager);
  let showProposal = () => {};
  if (isManager) {
    showProposal = setUpPlanTools(event);
    setUpIdeas(event.id);
  }
  return showProposal;
}

async function load({ focusIntake = false } = {}) {
  bump();
  hideConsequences();
  hideIdeas();
  const me = await signedIn();
  if (!me) return signInAgain();
  const { event, template, groups, members } = await api.event(me.user.eventId);
  const isVendor = me.user.kind === "vendor";
  document.getElementById("signed-in").textContent = `${me.user.name}, ${me.user.roleName}`;
  show("switch-person", !me.invited);
  show("new-event", !isVendor);
  document.getElementById("switch-person").onclick = signInAgain;

  document.getElementById("event-title").textContent = event.name || template.label;
  document.title = `${event.name || template.label} · Huddle`;
  document.getElementById("event-countdown").textContent = countdown(event.date);
  if (!isVendor) renderBrief(event, template, me.permissions.seeTotalBudget);

  const settingUp = event.intakeStatus === "in_progress";
  const isManager = me.user.kind === "manager";
  show("intake", settingUp && isManager);
  // Groups and vendors don't exist yet, so setup shows only what it needs.
  document.querySelector(".side").classList.toggle("is-setup", settingUp);
  if (settingUp) {
    showView(null);
    show("ask-nav", false);
  }
  show("budget-panel", !settingUp && !isVendor);
  show("vendor-panel", isVendor);
  show("brief-details", !isVendor);
  show("timeline-nav", !settingUp && !isVendor);
  show("budget-nav", !settingUp && !isVendor);
  show("flow", !settingUp && !isVendor);
  // Only when setup starts or ends, so a later refresh doesn't close a brief someone opened.
  const brief = document.getElementById("brief-details");
  if (wasSettingUp !== settingUp) brief.open = settingUp;
  wasSettingUp = settingUp;
  if (settingUp && !isManager) announce("The event manager is still setting this event up.");
  if (settingUp) {
    renderGroups([], null, () => {});
    if (isManager) {
      await startIntake(event, template, {
        focus: focusIntake,
        onProfile: (profile) => renderBrief(profile, template, me.permissions.seeTotalBudget),
        onConfirmed: async () => {
          await load();
          document.getElementById("ask-title").focus();
          announce("Workspace created.");
        },
      });
    }
    return;
  }
  const showProposal = isVendor ? () => {} : await loadPlan(event, isManager, groups);
  if (isVendor) await renderVendorHome();
  document.getElementById("timeline-about").textContent = event.date
    ? `Every step up to ${formatDate(event.date)}. ${countdown(event.date)}.`
    : "";
  const pageOpener =
    (name, titleId) =>
    (moveFocus = false) => {
      view = name;
      showView(name);
      drawGroups();
      if (moveFocus) document.getElementById(titleId).focus();
    };
  const openTimeline = pageOpener("timeline", "timeline-title");
  const nextStepOpeners = () => ({
    budget: () => document.getElementById("budget-nav").click(),
    timeline: () => document.getElementById("timeline-nav").click(),
    vendors: () => document.getElementById("vendors-nav").click(),
    ask: () => document.getElementById("what-if-text").focus(),
  });
  document.getElementById("timeline-nav").onclick = () => openTimeline(true);
  document.getElementById("flow-open").onclick = () => openTimeline(true);
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
    budget: () => shownBudget,
    showProposal: proposeInAsk,
    reload: load,
  });
  const showBudgetPage = pageOpener("budget", "budget-title");
  const openBudget = async (moveFocus = false) => {
    showBudgetPage(moveFocus);
    await refreshBudgetPage();
  };
  document.getElementById("budget-nav").onclick = () =>
    openBudget(true).catch((err) => announceError(err.message));
  const drawGroups = () =>
    renderGroups(
      groups,
      view === "group" ? activeGroupId : null,
      (next) => open(next, true),
      unread,
    );
  const open = async (group, moveFocus = false) => {
    activeGroupId = group.id;
    view = "group";
    unread.delete(group.id);
    showView("group");
    drawGroups();
    if (moveFocus) document.getElementById("group-title").focus();
    await showGroup(group, members, { me: me.user, isManager }, () => activeGroupId === group.id);
  };
  const openById = (id) => {
    const group = groups.find((item) => item.id === id);
    if (group) open(group, true);
  };
  renderAttention(me.attention, openById);
  if (isManager) setUpGroupsAdmin({ event, groups, roles: template.roles, onChanged: load });
  startLive({
    isVendor,
    userId: me.user.id,
    eventId: event.id,
    activeGroupId: () => (view === "group" ? activeGroupId : null),
    hasPreview: previewOpen,
    openGroup: openById,
    onUnread: (groupId) => {
      unread.set(groupId, (unread.get(groupId) ?? 0) + 1);
      drawGroups();
    },
    // shortcut: while a preview is open a live reload waits for the next view change; a stale
    // preview is still safe, because the server refuses to apply a change to a moved base.
    onGroupsChanged: () => previewOpen() || load(),
    onReconnect: () => previewOpen() || load(),
    onBudget: (budget) => {
      shownBudget = budget;
      if (view === "budget") refreshBudgetPage().catch(() => {});
    },
  });
  // Vendors and quotes are for the manager and the core members who own a category.
  const mine = isManager
    ? template.categories
    : template.categories.filter(({ id }) => me.user.categoryIds?.includes(id));
  const canVendors = me.permissions.viewQuotes && mine.length > 0;
  document.querySelector(".vendors-nav").hidden = !canVendors;
  document.getElementById("manage-groups").hidden = !isManager;
  let refreshVendors = async () => {};
  const showVendorsPage = pageOpener("vendors", "vendors-title");
  const openVendors = async (moveFocus = false) => {
    showVendorsPage(moveFocus);
    await refreshVendors();
  };
  if (canVendors) {
    refreshVendors = setUpVendors({
      event,
      categories: mine,
      isManager,
      showProposal: proposeInAsk,
    });
    document.getElementById("vendors-nav").onclick = () => openVendors(true);
  }
  document.getElementById("ask-nav").onclick = () => openAsk(true);
  const first = groups.find(({ id }) => id === activeGroupId) ?? groups[0];
  // The manager opens on Ask Huddle; everyone else on their first group.
  const wanted = view ?? (isManager ? "ask" : "group");
  if (wanted === "vendors" && canVendors) await openVendors();
  else if (wanted === "ask" && isManager) openAsk();
  else if (wanted === "timeline") openTimeline();
  else if (wanted === "budget") await openBudget();
  else if (first) await open(first);
}

function showView(name) {
  show("group-view", name === "group");
  show("vendors-view", name === "vendors");
  show("ask-view", name === "ask");
  show("timeline-view", name === "timeline");
  show("budget-view", name === "budget");
  show("flow-open", name !== "timeline");
  document.getElementById("vendors-nav").setAttribute("aria-current", String(name === "vendors"));
  document.getElementById("ask-nav").setAttribute("aria-current", String(name === "ask"));
  document.getElementById("timeline-nav").setAttribute("aria-current", String(name === "timeline"));
  document.getElementById("budget-nav").setAttribute("aria-current", String(name === "budget"));
}

for (const list of document.querySelectorAll("ul, ol")) list.setAttribute("role", "list");
setUpNewEvent((options) => {
  resetView();
  document.getElementById("signin").hidden = true;
  document.querySelector(".app").hidden = false;
  return load(options);
});
if (new URLSearchParams(location.search).get("invite") === "invalid")
  announce("That invite link has expired or been replaced. Please ask for a new one.", {
    keep: true,
  });
document.getElementById("notice-close").onclick = () => {
  announce("");
  document.getElementById("main").focus();
};
load().catch((err) => announceError(err.message));
