/** The message box under a group: drafting, attaching files and sending. */
import { api } from "../shared/api.js";
import { $, clear, el, formatSize } from "../shared/dom.js";

const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1048576;
const THINKING_MS = 45_000;
const HUDDLE = /@huddle\b/i;

let composerGroupId = null;
let picked = [];

function say(message, isError = false) {
  const status = $("composer-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function drawPicked() {
  const list = $("composer-picked");
  clear(list);
  list.hidden = picked.length === 0;
  for (const file of picked)
    list.append(
      el(
        "li",
        {},
        `${file.name} (${formatSize(file.size)})`,
        el("button", {
          type: "button",
          text: "×",
          "aria-label": `Remove ${file.name}`,
          onclick: () => {
            picked = picked.filter((item) => item !== file);
            drawPicked();
            $("composer-status").textContent = `${file.name} removed.`;
            $("composer-text").focus();
          },
        }),
      ),
    );
}

function fitText() {
  const text = $("composer-text");
  text.style.height = "auto";
  text.style.height = `${text.scrollHeight}px`;
}

function pickFiles() {
  const files = $("composer-files");
  const next = [...picked, ...files.files];
  files.value = "";
  if (next.length > MAX_FILES) {
    say(`Please attach up to ${MAX_FILES} files.`, true);
    return;
  }
  const big = next.find(({ size }) => size > MAX_FILE_BYTES);
  if (big) {
    say(`${big.name} is over the 5 MB limit.`, true);
    return;
  }
  picked = next;
  drawPicked();
  say(`${picked.length} ${picked.length === 1 ? "file" : "files"} ready to send.`);
}

function showHuddleThinking(message) {
  if (!HUDDLE.test(message.text)) return;
  const waiting = el("p", { class: "thinking", text: "Huddle is working on that" });
  $("messages").append(waiting);
  // If no reply comes, don't leave this standing.
  setTimeout(() => waiting.remove(), THINKING_MS);
}

function uploadingText() {
  return picked.length === 1 ? "Uploading 1 file" : `Uploading ${picked.length} files`;
}

async function send(e, group, addMessage) {
  e.preventDefault();
  const text = $("composer-text");
  const button = $("composer-send");
  const body = text.value.trim();
  if (button.getAttribute("aria-disabled") === "true") return;
  if (!body && picked.length === 0) {
    say("Write a message or attach a file first.", true);
    return;
  }
  const data = new FormData();
  if (body) data.set("text", body);
  for (const file of picked) data.append("files", file);
  // aria-disabled, not disabled, so focus stays on the button while it works.
  button.setAttribute("aria-disabled", "true");
  button.setAttribute("aria-label", picked.length ? "Uploading" : "Sending");
  say(picked.length ? uploadingText() : "Sending");
  try {
    const { message } = await api.postMessage(group.id, data);
    text.value = "";
    picked = [];
    drawPicked();
    fitText();
    say("Message sent.");
    addMessage(message);
    showHuddleThinking(message);
    $("messages").scrollTop = $("messages").scrollHeight;
  } catch (err) {
    say(err.message, true);
  } finally {
    button.removeAttribute("aria-disabled");
    button.setAttribute("aria-label", "Send message");
  }
}

function wireText(form) {
  const text = $("composer-text");
  text.oninput = fitText;
  text.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  $("composer-huddle").onclick = () => {
    if (!HUDDLE.test(text.value)) text.value = `@huddle ${text.value}`;
    fitText();
    text.focus();
  };
}

/**
 * Wires the message box for a group. A draft or chosen file stays while the same group redraws.
 * @param {object} group The group on screen, with `canPost`.
 * @param {(message: object) => void} addMessage Puts a sent message in the log.
 * @param {boolean} [isVendor] A vendor can't call on the AI, so isn't offered it.
 */
export function setUpComposer(group, addMessage, isVendor = false) {
  const form = $("composer");
  const note = $("composer-note");
  form.hidden = !group.canPost;
  note.hidden = group.canPost;
  note.textContent =
    group.kind === "announcements"
      ? "Only the event manager and AI members post here."
      : "You can read this room. Posting here is for the people who own this area.";
  // A draft or file is meant for one group, so it never follows you into another.
  if (composerGroupId !== group.id) {
    composerGroupId = group.id;
    $("composer-text").value = "";
    picked = [];
    drawPicked();
    say("");
  }
  $("composer-text").placeholder = `Message ${group.name}`;
  fitText();
  wireText(form);
  $("composer-files").onchange = pickFiles;
  $("composer-huddle").hidden = isVendor;
  form.onsubmit = (e) => send(e, group, addMessage);
}
