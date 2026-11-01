/** The app's entry point: finds out who is signed in, then draws setup or the workspace. */
import { renderBudget } from "./budget/budgetChart.js";
import { hideConsequences, setUpWhatIf } from "./budget/consequences.js";
import { hideIdeas, setUpIdeas } from "./budget/ideas.js";
import { setUpGroupsAdmin } from "./chat/groupsAdmin.js";
import { renderBrief } from "./setup/brief.js";
import { startIntake } from "./setup/intake.js";
import { api } from "./shared/api.js";
import { $, announce, announceError, countdown, formatDate } from "./shared/dom.js";
import { bump } from "./shared/session.js";
import { drawHeader, setLayout, show } from "./shell/layout.js";
import { startLive } from "./shell/live.js";
import { setUpNewEvent } from "./shell/newEvent.js";
import { createPages, resetView } from "./shell/pages.js";
import { showSignIn } from "./shell/signin.js";
import { renderAttention, renderGroups } from "./shell/workspace.js";
import { renderTimeline, setTimelineGroups, setUpTimelineTools } from "./timeline/timeline.js";
import { renderVendorHome } from "./vendors/vendorHome.js";

const INVITE_NOTES = {
  invalid: "That invite link has expired or been replaced. Please ask for a new one.",
  "signed-in":
    "You're already signed in here, so that invite wasn't used. To use it, open it in a private window.",
};
let shownBudget = null;
const previewOpen = () => !$("consequences").hidden;

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
      const summary = $("budget-summary").textContent;
      const told = notices
        ? ` ${notices} ${notices === 1 ? "group was" : "groups were"} notified.`
        : "";
      announce(`Change applied. ${summary}${told}`);
      $("what-if-text").focus();
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
      $("overview-title").focus();
      announce("Workspace created.");
    },
  });
}

async function loadWorkspace({ me, event, template, groups, members, isManager, isVendor }) {
  const showProposal = isVendor ? () => {} : await loadPlan(event, isManager, groups);
  if (isVendor) await renderVendorHome();
  $("timeline-about").textContent = event.date
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
  $("manage-groups").hidden = !isManager;
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
  $("signin").hidden = true;
  document.querySelector(".app").hidden = false;
  return load(options);
});
const inviteNote = INVITE_NOTES[new URLSearchParams(location.search).get("invite")];
if (inviteNote) announce(inviteNote, { keep: true });
$("notice-close").onclick = () => {
  announce("");
  $("main").focus();
};
load().catch((err) => announceError(err.message));
