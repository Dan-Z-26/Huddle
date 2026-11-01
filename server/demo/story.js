import { hideAmounts } from "../core/amount.js";
import { canPost } from "../core/permissions.js";
import { runReminders } from "../reminders.js";
import { ackDirective } from "../routes/directives.js";
import { sendBrief } from "../routes/hiringSupport.js";
import { replyAsPlanner } from "../routes/plannerReply.js";
import { groupPeople } from "../views.js";
import { DEMO_EVENT_ID as ID } from "../store/seed.js";
import { addMessage } from "../store/workspace.js";
import { newId } from "../store/ids.js";

const PRODUCTION = `user-production-lead@${ID}`;
const DESIGNER = `user-creative-director@${ID}`;
const FOOD = `user-fb-lead@${ID}`;
const PRESS = `user-pr-head@${ID}`;
const REPLY_MS = 4000;

const firstName = ({ name }) => name.split(" ")[0];

// The owner of a category among the team, if there is one.
const ownerOf = (store, categoryId) =>
  [...store.users.values()].find(
    ({ eventId, kind, categoryIds }) =>
      eventId === ID && kind === "core" && categoryIds?.includes(categoryId),
  );

/**
 * Plays the demo: scripted teammates act through the same code as real people, so the AI replies,
 * notices and figures that follow are all real. Only what the teammates say is scripted.
 * @param {object} store A store with the demo event and its history.
 * @param {{speed?: number}} [options] 1 is real time; 0 plays at once, for tests.
 * @returns {{start: () => Promise<void>, react: (kind: string, details: object) => void}} `start`
 *   runs the story once, however often it is called. `react` has a teammate answer what a viewer
 *   just did.
 */
export function createStory(store, { speed = 1 } = {}) {
  const wait = (ms) =>
    speed ? new Promise((done) => setTimeout(done, ms * speed).unref?.()) : Promise.resolve();
  const say = (slug, userId, text) => {
    const group = store.groups.get(`g-${ID}-${slug}`);
    const user = store.users.get(userId);
    // A viewer can have removed them from the room since; they don't speak where they can't.
    if (!group || !user || !canPost(store.roleOf(user), group)) return null;
    const message = addMessage(store, {
      id: newId("m"),
      groupId: group.id,
      authorId: user.id,
      authorKind: "human",
      text: hideAmounts(text),
      fileIds: [],
      createdAt: new Date().toISOString(),
      rationale: null,
    });
    return { message, group, user, askedText: text };
  };
  const askHuddle = async (slug, userId, text) => {
    const said = say(slug, userId, text);
    if (said) await replyAsPlanner({ store, event: store.events.get(ID), ...said });
  };
  // A room can have been renamed or removed by the viewer, so anything here may find nothing.
  const inRoomOf = (categoryId) =>
    [...store.groups.values()].find(
      ({ eventId, kind, categoryIds }) =>
        eventId === ID && kind === "category" && categoryIds?.includes(categoryId),
    );

  const BEATS = [
    [8000, () => say("music-av", PRODUCTION, "The LED wall advance went out this morning.")],
    [
      3000,
      () => askHuddle("music-av", PRODUCTION, "@huddle we paid ₹3 lakh for the LED wall under AV"),
    ],
    [
      14000,
      () =>
        askHuddle(
          "food-beverage",
          FOOD,
          "@huddle a few partners are vegan. What should I ask the caterer?",
        ),
    ],
    [
      14000,
      () => askHuddle("pr-media", PRESS, "@huddle please draft a vendor brief for PR and media"),
    ],
    [
      10000,
      () => {
        const brief = store.briefs.get(`b-${ID}-pr`);
        if (!brief || brief.status === "approved" || brief.status === "pending") return;
        say("pr-media", PRESS, "That reads well. Sending it to Asha for approval.");
        sendBrief({
          store,
          event: store.events.get(ID),
          brief,
          user: store.users.get(PRESS),
        });
      },
    ],
    [10000, () => runReminders(store, new Date().toISOString(), { slaMinutes: 0, eventId: ID })],
    [
      8000,
      () => {
        const directive = [...store.directives.values()].find(
          ({ groupId, acks, addressedUserIds }) =>
            groupId === `g-${ID}-announcements` &&
            addressedUserIds.includes(DESIGNER) &&
            !acks.some(({ userId }) => userId === DESIGNER),
        );
        if (directive) ackDirective(store, directive, DESIGNER);
      },
    ],
  ];

  let started = null;
  const play = async () => {
    for (const [gapMs, beat] of BEATS) {
      await wait(gapMs);
      try {
        await beat();
      } catch (err) {
        console.error(`Demo story step failed with ${err.name}`);
      }
    }
  };

  const REACTIONS = {
    overspend: ({ categoryId, status }) => {
      const owner = ownerOf(store, categoryId);
      const room = inRoomOf(categoryId);
      // A booked vendor reads this room, and this is about negotiating with them.
      const hasVendor = room && groupPeople(store, room).some(({ kind }) => kind === "vendor");
      if (owner && room && !hasVendor)
        say(
          room.slug,
          owner.id,
          status === "over"
            ? "Seen. I'll ask the vendor whether any of the balance can come down, and update this room."
            : "Noted. I'll check what's still to come before the next payment.",
        );
    },
    directive: async ({ directive }) => {
      // One person is left to go, so "acknowledged" and "pending" can both be seen.
      for (const userId of directive.addressedUserIds.slice(0, -1)) {
        await wait(REPLY_MS);
        ackDirective(store, directive, userId);
      }
    },
    brief: ({ categoryId, approved }) => {
      const owner = ownerOf(store, categoryId);
      const room = inRoomOf(categoryId);
      if (owner && room)
        say(
          room.slug,
          owner.id,
          approved
            ? "Thanks. I'll send it to vendors today and add the quotes as they come in."
            : "On it. I'll update the brief and send it back.",
        );
    },
    booked: ({ categoryId, vendorName }) => {
      const owner = ownerOf(store, categoryId);
      const room = inRoomOf(categoryId);
      if (owner && room)
        say(
          room.slug,
          owner.id,
          `Welcome aboard, ${vendorName}. Your deliverables are listed here.`,
        );
    },
    // Someone named in a message answers, if they are in that room and didn't write it themselves.
    message: ({ group, user, text }) => {
      const named = groupPeople(store, group).find(
        (person) =>
          person.kind === "core" &&
          person.id !== user.id &&
          new RegExp(`\\b${firstName(person)}\\b`, "i").test(text),
      );
      if (named) say(group.slug, named.id, `On it, ${firstName(user)}.`);
    },
  };

  return {
    start: () => (started ??= play()),
    react: (kind, details) => {
      const work = wait(REPLY_MS)
        .then(() => REACTIONS[kind]?.(details))
        .catch((err) => console.error(`Demo reaction failed with ${err.name}`))
        .finally(() => store.background.delete(work));
      store.background.add(work);
    },
  };
}

/**
 * Turns the story on for a store: it starts at the first sign-in, and teammates answer what happens
 * on the demo event. Events a viewer creates themselves are left alone.
 * @param {object} store The store.
 * @param {{speed?: number}} [options] As for `createStory`.
 * @returns {ReturnType<typeof createStory>} The story.
 */
export function installStory(store, options) {
  const story = createStory(store, options);
  store.startDemoStory = (eventId) => {
    if (eventId === ID) return story.start();
    return undefined;
  };
  store.reactInDemo = (kind, { event, ...details }) => {
    if (event?.id === ID) story.react(kind, details);
  };
  return story;
}
