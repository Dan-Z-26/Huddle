import { api } from "./api.js";
import { clear, el, formatSize } from "./dom.js";

const $ = (id) => document.getElementById(id);
const MAX_FILES = 3;
const MAX_FILE_BYTES = 5 * 1048576;

let composerGroupId = null;
let picked = [];

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
  const text = $("composer-text");
  const files = $("composer-files");
  const send = $("composer-send");
  const status = $("composer-status");
  const say = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  };
  // A draft or file is meant for one group, so it never follows you into another.
  if (composerGroupId !== group.id) {
    composerGroupId = group.id;
    text.value = "";
    picked = [];
    drawPicked();
    say("");
  }
  text.placeholder = `Message ${group.name}`;
  fitText();
  text.oninput = fitText;
  text.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  };
  files.onchange = () => {
    const next = [...picked, ...files.files];
    files.value = "";
    if (next.length > MAX_FILES) return say(`Please attach up to ${MAX_FILES} files.`, true);
    const big = next.find(({ size }) => size > MAX_FILE_BYTES);
    if (big) return say(`${big.name} is over the 5 MB limit.`, true);
    picked = next;
    drawPicked();
    return say(`${picked.length} ${picked.length === 1 ? "file" : "files"} ready to send.`);
  };
  $("composer-huddle").hidden = isVendor;
  $("composer-huddle").onclick = () => {
    if (!/@huddle\b/i.test(text.value)) text.value = `@huddle ${text.value}`;
    fitText();
    text.focus();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = text.value.trim();
    if (send.getAttribute("aria-disabled") === "true") return;
    if (!body && picked.length === 0) {
      say("Write a message or attach a file first.", true);
      return;
    }
    const data = new FormData();
    if (body) data.set("text", body);
    for (const file of picked) data.append("files", file);
    // aria-disabled, not disabled, so focus stays on the button while it works.
    send.setAttribute("aria-disabled", "true");
    send.setAttribute("aria-label", picked.length ? "Uploading" : "Sending");
    say(
      picked.length
        ? `Uploading ${picked.length === 1 ? "1 file" : `${picked.length} files`}`
        : "Sending",
    );
    try {
      const { message } = await api.postMessage(group.id, data);
      text.value = "";
      picked = [];
      drawPicked();
      fitText();
      say("Message sent.");
      addMessage(message);
      if (/@huddle\b/i.test(message.text)) {
        const waiting = el("p", { class: "thinking", text: "Huddle is working on that" });
        $("messages").append(waiting);
        // If no reply comes, don't leave this standing.
        setTimeout(() => waiting.remove(), 45_000);
      }
      $("messages").scrollTop = $("messages").scrollHeight;
    } catch (err) {
      say(err.message, true);
    } finally {
      send.removeAttribute("aria-disabled");
      send.setAttribute("aria-label", "Send message");
    }
  };
}
