/** The only module that talks to the server. Errors come back as an Error with status and code. */

async function request(url, { method = "GET", body } = {}) {
  // A FormData body carries a file; the browser sets its own content type and boundary.
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${url}`, {
    method,
    headers: body && !isForm ? { "content-type": "application/json" } : {},
    body: body && !isForm ? JSON.stringify(body) : body,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error?.message ?? "Something went wrong."), {
      status: res.status,
      code: data.error?.code,
    });
  }
  return data;
}

// Builds a path with every value escaped, as a tag: path`/events/${id}/budget`.
const path = (parts, ...values) =>
  parts.reduce((built, part, index) => `${built}${encodeURIComponent(values[index - 1])}${part}`);

const get = (url) => request(url);
const post = (url, body) => request(url, { method: "POST", body });
const patch = (url, body) => request(url, { method: "PATCH", body });
const remove = (url) => request(url, { method: "DELETE" });

/** Every call the app makes, by name. */
export const api = {
  me: () => get("/me"),
  people: () => get("/people"),
  signIn: (userId) => post("/session", { userId }),
  signOut: () => post("/session/logout"),

  eventTypes: () => get("/event-types"),
  createEvent: (eventType) => post("/events", { eventType }),
  event: (id) => get(path`/events/${id}`),
  intake: (id, answer, mode) =>
    post(path`/events/${id}/intake`, answer === undefined ? {} : { answer, mode }),
  confirmIntake: (id) => post(path`/events/${id}/intake/confirm`),
  advice: (id) => post(path`/events/${id}/advice`),
  ideas: (id) => post(path`/events/${id}/ideas`),
  activity: (id) => get(path`/events/${id}/activity`),

  budget: (id) => get(path`/events/${id}/budget`),
  proposeChange: (id, text) => post(path`/events/${id}/changes`, { text }),
  acceptChange: (id, changeId, choice) =>
    post(path`/events/${id}/changes/${changeId}/accept`, choice),
  expenses: (id) => get(path`/events/${id}/expenses`),
  addExpense: (id, body) => post(path`/events/${id}/expenses`, body),
  deleteExpense: (id) => remove(path`/expenses/${id}`),
  coverFromBuffer: (id, categoryId) => post(path`/events/${id}/buffer/cover`, { categoryId }),
  setBuffer: (id, percent) => post(path`/events/${id}/buffer`, { percent }),

  timeline: (id) => get(path`/events/${id}/timeline`),
  reschedule: (id, date) => post(path`/events/${id}/reschedule`, { date }),
  setTask: (id, status) => patch(path`/tasks/${id}`, { status }),
  digest: (id) => post(path`/events/${id}/digest`),

  rfq: (id, categoryId) => post(path`/events/${id}/rfq`, { categoryId }),
  quotes: (id, categoryId) => get(path`/events/${id}/quotes?categoryId=${categoryId}`),
  addQuote: (id, form) => post(path`/events/${id}/quotes`, form),
  confirmQuote: (id, body) => post(path`/quotes/${id}/confirm`, body),
  acceptQuote: (id) => post(path`/quotes/${id}/accept`),
  comparison: (id, categoryId) => get(path`/events/${id}/comparison?categoryId=${categoryId}`),

  hiring: (id) => get(path`/events/${id}/hiring`),
  createBrief: (id, categoryId, answers) =>
    post(path`/events/${id}/briefs`, { categoryId, answers }),
  sendBrief: (id) => post(path`/briefs/${id}/send`),
  decideBrief: (id, body) => post(path`/briefs/${id}/decision`, body),
  declineDraft: (id) => post(path`/quotes/${id}/decline-draft`),
  requestRevision: (id) => post(path`/quotes/${id}/request-revision`),

  createInvite: (id) => post(path`/vendors/${id}/invite`),
  revokeInvite: (id) => remove(path`/vendors/${id}/invite`),
  vendorHome: () => get("/vendor/home"),
  setDeliverable: (id, done) => patch(path`/deliverables/${id}`, { done }),

  messages: (groupId) => get(path`/groups/${groupId}/messages`),
  postMessage: (groupId, form) => post(path`/groups/${groupId}/messages`, form),
  pinDirective: (messageId, addressedUserIds) =>
    post(path`/messages/${messageId}/directive`, { addressedUserIds }),
  ack: (directiveId) => post(path`/directives/${directiveId}/ack`),
  createGroup: (eventId, body) => post(path`/events/${eventId}/groups`, body),
  patchGroup: (groupId, body) => patch(path`/groups/${groupId}`, body),
  deleteGroup: (groupId) => remove(path`/groups/${groupId}`),
};

/**
 * Opens the live stream. The browser reconnects by itself if it drops; `onOpen` runs on every
 * (re)connection, so the screen can catch up on anything it missed.
 * @param {Record<string, (event: object) => void>} handlers One function per event type.
 * @param {() => void} onOpen Called each time the stream opens.
 * @returns {() => void} Closes the stream.
 */
export function openStream(handlers, onOpen) {
  const source = new EventSource("/api/stream");
  source.onopen = onOpen;
  for (const [type, handler] of Object.entries(handlers)) {
    source.addEventListener(type, (message) => handler(JSON.parse(message.data)));
  }
  return () => source.close();
}
