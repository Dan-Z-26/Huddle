// The only module that talks to the server.

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
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
  users: () => request("/users"),
  viewAs: (userId) => request("/view-as", { method: "POST", body: { userId } }),
  me: () => request("/me"),
  eventTypes: () => request("/event-types"),
  createEvent: (eventType) => request("/events", { method: "POST", body: { eventType } }),
  event: (id) => request(`/events/${encodeURIComponent(id)}`),
  intake: (id, answer) =>
    request(`/events/${encodeURIComponent(id)}/intake`, {
      method: "POST",
      body: answer === undefined ? {} : { answer },
    }),
  confirmIntake: (id) =>
    request(`/events/${encodeURIComponent(id)}/intake/confirm`, { method: "POST" }),
  ideas: (id) => request(`/events/${encodeURIComponent(id)}/ideas`, { method: "POST" }),
  budget: (id) => request(`/events/${encodeURIComponent(id)}/budget`),
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
  messages: (groupId) => request(`/groups/${encodeURIComponent(groupId)}/messages`),
};
