import { api } from "./api.js";
import { renderBrief, countdown } from "./brief.js";
import { renderBudget } from "./budgetChart.js";
import { hideConsequences, setUpWhatIf } from "./consequences.js";
import { announce, el } from "./dom.js";
import { hideIdeas, setUpIdeas } from "./ideas.js";
import { startIntake } from "./intake.js";
import { renderTimeline } from "./timeline.js";
import { bump } from "./session.js";
import { setUpViewAs } from "./viewAs.js";
import { renderAttention, renderGroups, showGroup } from "./workspace.js";

const DEMO_MANAGER = "user-manager@demo";
const TYPE_ABOUT = {
  corporate_launch: "Product launches, conferences and company events",
  wedding: "Ceremonies, receptions and family functions",
  birthday: "Milestone birthdays and celebrations",
  community: "Festivals, fundraisers and neighbourhood gatherings",
};
const show = (id, visible) => (document.getElementById(id).hidden = !visible);
let activeGroupId = null;
let shownBudget = null;
let wasSettingUp = null;

async function signedIn() {
  try {
    return await api.me();
  } catch (err) {
    if (err.status !== 401) throw err;
    await api.viewAs(DEMO_MANAGER);
    return api.me();
  }
}

function setUpPlanTools(event) {
  setUpWhatIf(event, {
    currentBudget: () => shownBudget,
    onApplied: async (notices) => {
      await load();
      const groups = `${notices} ${notices === 1 ? "group was" : "groups were"} notified`;
      const summary = document.getElementById("budget-summary").textContent;
      announce(`Change applied. ${summary} ${groups}.`);
      document.getElementById("what-if-text").focus();
    },
  });
  const date = document.getElementById("reschedule-date");
  document.getElementById("reschedule").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.reschedule(event.id, date.value.trim());
      date.value = "";
      await load();
      announce("Event date moved and timeline replanned.");
    } catch (err) {
      announce(err.message);
    }
  };
  const digestButton = document.getElementById("post-digest");
  digestButton.onclick = async () => {
    digestButton.disabled = true;
    try {
      await api.digest(event.id);
      await load();
      announce("Digest posted in #announcements.");
    } catch (err) {
      announce(err.message);
    } finally {
      digestButton.disabled = false;
    }
  };
}

async function loadPlan(event, isManager) {
  const [budget, { tasks }] = await Promise.all([api.budget(event.id), api.timeline(event.id)]);
  shownBudget = budget;
  renderBudget(budget);
  renderTimeline(tasks);
  show("ask", isManager);
  show("timeline-tools", isManager);
  if (isManager) {
    setUpPlanTools(event);
    setUpIdeas(event.id);
  }
}

async function load({ focusIntake = false } = {}) {
  bump();
  announce("");
  hideConsequences();
  hideIdeas();
  const me = await signedIn();
  const { event, template, groups, members } = await api.event(me.user.eventId);
  await setUpViewAs(me.user.id, async (name) => {
    await load();
    announce(`Now viewing as ${name}.`);
  });

  document.getElementById("event-title").textContent = event.name || template.label;
  document.getElementById("event-countdown").textContent = countdown(event.date);
  renderBrief(event, template, me.permissions.seeTotalBudget);
  renderAttention(me.attention);

  const settingUp = event.intakeStatus === "in_progress";
  const isManager = me.user.kind === "manager";
  show("intake", settingUp && isManager);
  show("group-view", !settingUp);
  show("budget-panel", !settingUp);
  show("timeline-panel", !settingUp);
  if (settingUp) show("ask", false);
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
          document.getElementById("group-title").focus();
          announce("Workspace created.");
        },
      });
    }
    return;
  }
  await loadPlan(event, isManager);
  const open = async (group, moveFocus = false) => {
    activeGroupId = group.id;
    renderGroups(groups, group.id, (next) => open(next, true));
    if (moveFocus) document.getElementById("group-title").focus();
    await showGroup(group, members, () => activeGroupId === group.id);
  };
  const first = groups.find(({ id }) => id === activeGroupId) ?? groups[0];
  if (first) await open(first);
}

function setUpNewEvent() {
  const dialog = document.getElementById("new-event-dialog");
  const list = dialog.querySelector(".type-list");
  document.getElementById("new-event").onclick = async () => {
    let eventTypes;
    try {
      ({ eventTypes } = await api.eventTypes());
    } catch (err) {
      announce(err.message);
      return;
    }
    list.replaceChildren(list.querySelector("legend"));
    eventTypes.forEach(({ eventType, label }, i) => {
      list.append(
        el(
          "label",
          { class: "type-option" },
          el("input", { type: "radio", name: "eventType", value: eventType, checked: i === 0 }),
          el("span", { text: label }),
          el("small", { text: TYPE_ABOUT[eventType] ?? "" }),
        ),
      );
    });
    dialog.showModal();
  };
  document.getElementById("new-event-cancel").onclick = () => dialog.close();
  document.getElementById("new-event-form").onsubmit = async (e) => {
    e.preventDefault();
    const chosen = dialog.querySelector("input[name=eventType]:checked");
    dialog.close();
    try {
      await api.createEvent(chosen.value);
      await load({ focusIntake: true });
    } catch (err) {
      announce(err.message);
    }
  };
}

setUpNewEvent();
load().catch((err) => announce(err.message));
