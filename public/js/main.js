import { api } from "./api.js";
import { countdown, renderBrief } from "./brief.js";
import { renderBudget } from "./budgetChart.js";
import { hideConsequences, setUpWhatIf } from "./consequences.js";
import { announce, announceError, formatDate } from "./dom.js";
import { setUpGroupsAdmin } from "./groupsAdmin.js";
import { hideIdeas, setUpIdeas } from "./ideas.js";
import { startIntake } from "./intake.js";
import { drawHeader, setLayout, show } from "./layout.js";
import { startLive } from "./live.js";
import { setUpNewEvent } from "./newEvent.js";
import { createPages, resetView } from "./pages.js";
import { bump } from "./session.js";
import { showSignIn } from "./signin.js";
import { renderTimeline, setTimelineGroups, setUpTimelineTools } from "./timeline.js";
import { renderVendorHome } from "./vendorHome.js";
import { renderAttention, renderGroups } from "./workspace.js";

const INVITE_NOTES = {
  invalid: "That invite link has expired or been replaced. Please ask for a new one.",
  "signed-in":
    "You're already signed in here, so that invite wasn't used. To use it, open it in a private window.",
};
let shownBudget = null;
const previewOpen = () => !document.getElementById("consequences").hidden;

async function signedIn() {
  try {
    return await api.me();
  } catch (err) {
    if (err.status !== 401) throw err;
    return null;
  }
}

// A full reload on sign-in: nothing drawn for the last person can stay on the page for the next.
const signInAgain = () => showSignIn(() => location.assign("/"));

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
  if (!isManager) return () => {};
  setUpIdeas(event.id);
  return setUpPlanTools(event);
}

// While setting up there are no groups yet, and only the manager has anything to do.
async function loadSetup({ me, event, template, isManager, focusIntake }) {
  if (!isManager) announce("The event manager is still setting this event up.");
  renderGroups([], null, () => {});
  if (!isManager) return;
  await startIntake(event, template, {
    focus: focusIntake,
    onProfile: (profile) => renderBrief(profile, template, me.permissions.seeTotalBudget),
    onConfirmed: async () => {
      await load();
      document.getElementById("overview-title").focus();
      announce("Workspace created.");
    },
  });
}

async function loadWorkspace({ me, event, template, groups, members, isManager, isVendor }) {
  const showProposal = isVendor ? () => {} : await loadPlan(event, isManager, groups);
  if (isVendor) await renderVendorHome();
  document.getElementById("timeline-about").textContent = event.date
    ? `Every step up to ${formatDate(event.date)}. ${countdown(event.date)}.`
    : "";
  const pages = createPages({
    event,
    template,
    groups,
    members,
    me,
    isManager,
    isVendor,
    budget: () => shownBudget,
    showProposal,
    reload: load,
  });
  renderAttention(me.attention, pages.openGroup, pages.openBudget, pages.openVendorsOn);
  document.getElementById("manage-groups").hidden = !isManager;
  if (isManager) setUpGroupsAdmin({ event, groups, roles: template.roles, onChanged: load });
  startLive({
    isVendor,
    userId: me.user.id,
    eventId: event.id,
    activeGroupId: pages.activeGroup,
    hasPreview: previewOpen,
    openGroup: pages.openGroup,
    openBudget: pages.openBudget,
    openVendors: pages.openVendorsOn,
    onUnread: pages.noteUnread,
    // shortcut: while a preview is open a live reload waits for the next view change; a stale
    // preview is still safe, because the server refuses to apply a change to a moved base.
    onGroupsChanged: () => previewOpen() || load(),
    onReconnect: () => previewOpen() || load(),
    onQuotes: pages.quotesChanged,
    onBudget: (budget) => {
      shownBudget = budget;
      pages.budgetChanged();
    },
  });
  await pages.openWanted();
}

async function load({ focusIntake = false } = {}) {
  bump();
  hideConsequences();
  hideIdeas();
  const me = await signedIn();
  if (!me) {
    await signInAgain();
    return;
  }
  const { event, template, groups, members } = await api.event(me.user.eventId);
  const isVendor = me.user.kind === "vendor";
  const isManager = me.user.kind === "manager";
  const settingUp = event.intakeStatus === "in_progress";
  drawHeader(me, event, template, signInAgain);
  if (!isVendor) renderBrief(event, template, me.permissions.seeTotalBudget);
  setLayout({ settingUp, isManager, isVendor });
  if (settingUp) await loadSetup({ me, event, template, isManager, focusIntake });
  else await loadWorkspace({ me, event, template, groups, members, isManager, isVendor });
}

for (const list of document.querySelectorAll("ul, ol")) list.setAttribute("role", "list");
setUpNewEvent((options) => {
  resetView();
  document.getElementById("signin").hidden = true;
  document.querySelector(".app").hidden = false;
  return load(options);
});
const inviteNote = INVITE_NOTES[new URLSearchParams(location.search).get("invite")];
if (inviteNote) announce(inviteNote, { keep: true });
document.getElementById("notice-close").onclick = () => {
  announce("");
  document.getElementById("main").focus();
};
load().catch((err) => announceError(err.message));
