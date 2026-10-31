// The only module that talks to the server.

async function request(path, { method = "GET", body } = {}) {
  // A FormData body carries a file; the browser sets its own content type and boundary.
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
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

export const api = {
  me: () => request("/me"),
  eventTypes: () => request("/event-types"),
  createEvent: (eventType) => request("/events", { method: "POST", body: { eventType } }),
  event: (id) => request(`/events/${encodeURIComponent(id)}`),
  intake: (id, answer, mode) =>
    request(`/events/${encodeURIComponent(id)}/intake`, {
      method: "POST",
      body: answer === undefined ? {} : { answer, mode },
    }),
  confirmIntake: (id) =>
    request(`/events/${encodeURIComponent(id)}/intake/confirm`, { method: "POST" }),
  rfq: (id, categoryId) =>
    request(`/events/${encodeURIComponent(id)}/rfq`, { method: "POST", body: { categoryId } }),
  quotes: (id, categoryId) =>
    request(
      `/events/${encodeURIComponent(id)}/quotes?categoryId=${encodeURIComponent(categoryId)}`,
    ),
  addQuote: (id, form) =>
    request(`/events/${encodeURIComponent(id)}/quotes`, { method: "POST", body: form }),
  confirmQuote: (quoteId, body) =>
    request(`/quotes/${encodeURIComponent(quoteId)}/confirm`, { method: "POST", body }),
  acceptQuote: (quoteId) =>
    request(`/quotes/${encodeURIComponent(quoteId)}/accept`, { method: "POST" }),
  comparison: (id, categoryId) =>
    request(
      `/events/${encodeURIComponent(id)}/comparison?categoryId=${encodeURIComponent(categoryId)}`,
    ),
  people: () => request("/people"),
  signIn: (userId) => request("/session", { method: "POST", body: { userId } }),
  signOut: () => request("/session/logout", { method: "POST" }),
  hiring: (id) => request(`/events/${encodeURIComponent(id)}/hiring`),
  createBrief: (id, categoryId, answers) =>
    request(`/events/${encodeURIComponent(id)}/briefs`, {
      method: "POST",
      body: { categoryId, answers },
    }),
  sendBrief: (id) => request(`/briefs/${encodeURIComponent(id)}/send`, { method: "POST" }),
  decideBrief: (id, body) =>
    request(`/briefs/${encodeURIComponent(id)}/decision`, { method: "POST", body }),
  declineDraft: (id) =>
    request(`/quotes/${encodeURIComponent(id)}/decline-draft`, { method: "POST" }),
  requestRevision: (id) =>
    request(`/quotes/${encodeURIComponent(id)}/request-revision`, { method: "POST" }),
  createInvite: (id) => request(`/vendors/${encodeURIComponent(id)}/invite`, { method: "POST" }),
  revokeInvite: (id) => request(`/vendors/${encodeURIComponent(id)}/invite`, { method: "DELETE" }),
  vendorHome: () => request("/vendor/home"),
  setDeliverable: (id, done) =>
    request(`/deliverables/${encodeURIComponent(id)}`, { method: "PATCH", body: { done } }),
  advice: (id) => request(`/events/${encodeURIComponent(id)}/advice`, { method: "POST" }),
  ideas: (id) => request(`/events/${encodeURIComponent(id)}/ideas`, { method: "POST" }),
  budget: (id) => request(`/events/${encodeURIComponent(id)}/budget`),
  expenses: (id) => request(`/events/${encodeURIComponent(id)}/expenses`),
  addExpense: (id, body) =>
    request(`/events/${encodeURIComponent(id)}/expenses`, { method: "POST", body }),
  deleteExpense: (id) => request(`/expenses/${encodeURIComponent(id)}`, { method: "DELETE" }),
  coverFromBuffer: (id, categoryId) =>
    request(`/events/${encodeURIComponent(id)}/buffer/cover`, {
      method: "POST",
      body: { categoryId },
    }),
  setBuffer: (id, percent) =>
    request(`/events/${encodeURIComponent(id)}/buffer`, { method: "POST", body: { percent } }),
  timeline: (id) => request(`/events/${encodeURIComponent(id)}/timeline`),
  proposeChange: (id, text) =>
    request(`/events/${encodeURIComponent(id)}/changes`, { method: "POST", body: { text } }),
  acceptChange: (id, changeId, choice) =>
    request(`/events/${encodeURIComponent(id)}/changes/${encodeURIComponent(changeId)}/accept`, {
      method: "POST",
      body: choice,
    }),
  reschedule: (id, date) =>
    request(`/events/${encodeURIComponent(id)}/reschedule`, { method: "POST", body: { date } }),
  setTask: (id, status) =>
    request(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } }),
  digest: (id) => request(`/events/${encodeURIComponent(id)}/digest`, { method: "POST" }),
  postMessage: (groupId, form) =>
    request(`/groups/${encodeURIComponent(groupId)}/messages`, { method: "POST", body: form }),
  pinDirective: (messageId, addressedUserIds) =>
    request(`/messages/${encodeURIComponent(messageId)}/directive`, {
      method: "POST",
      body: { addressedUserIds },
    }),
  ack: (directiveId) =>
    request(`/directives/${encodeURIComponent(directiveId)}/ack`, { method: "POST" }),
  createGroup: (eventId, body) =>
    request(`/events/${encodeURIComponent(eventId)}/groups`, { method: "POST", body }),
  patchGroup: (groupId, body) =>
    request(`/groups/${encodeURIComponent(groupId)}`, { method: "PATCH", body }),
  deleteGroup: (groupId) => request(`/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" }),
  messages: (groupId) => request(`/groups/${encodeURIComponent(groupId)}/messages`),
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
