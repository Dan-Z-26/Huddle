/** The app's line icons, drawn as inline SVG. */
const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS = {
  brief: "M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7",
  ask: "M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9z",
  timeline: "M5 5h14v15H5zM5 10h14M9 3v4M15 3v4",
  budget: "M12 3a9 9 0 1 0 9 9h-9zM15.5 3.7A9 9 0 0 1 20.3 8.5H15.5z",
  vendors: "M4 9l2-5h12l2 5M5 9v11h14V9M4 9h16M10 20v-6h4v6",
  announce: "M4 10v4h3l9 5V5l-9 5zM19 9a4 4 0 0 1 0 6",
  people:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M16 5a3.5 3.5 0 0 1 0 6.5M18 14.5c1.9.7 3 2.8 3 5.5",
  food: "M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 3c-2 1-3 4-3 7v3h3v8",
  stage: "M3 20h18M5 20V8l7-4 7 4v12M9 20v-6h6v6",
  music: "M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  press: "M4 8h4l2-3h4l2 3h4v11H4zM12 16a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  gift: "M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7C9 7 7 6 7 4.5S9.5 2 12 7zM12 7c3 0 5-1 5-2.5S14.5 2 12 7z",
  room: "M4 5h16v11H8l-4 4z",
};

// Rooms are named by the template or the manager, so the picture follows the words.
const ROOM_ICONS = [
  [/announce/i, "announce"],
  [/core|team|family|committee|helpers/i, "people"],
  [/food|cater|cake|beverage|meal|menu/i, "food"],
  [/stage|d[ée]cor|venue|theme|logistic/i, "stage"],
  [/music|\bav\b|sound|entertain|game/i, "music"],
  [/\bpr\b|media|photo|press|outreach|invite/i, "press"],
  [/gift|favou?r|sponsor/i, "gift"],
];

/**
 * A line icon. It is decoration, so the words beside it carry the meaning.
 * @param {string} name A key of PATHS.
 * @returns {SVGElement} The icon.
 */
function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[name] ?? PATHS.room);
  svg.append(path);
  return svg;
}

/** The icon for a room, from its name. */
export const roomIcon = (name) =>
  icon(ROOM_ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? "room");
