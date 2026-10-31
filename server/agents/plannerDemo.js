// Offline stand-in for the Planner's intent reading: plain keyword rules, checked in this order.
const RULES = [
  ["ideas", /\b(ideas?|inspir\w*|themes?|suggest\w*|brainstorm\w*)\b/i],
  [
    "vendor_help",
    /\b(vendors?|rfq|quotes?|checklist|suppliers?|caterers?|photographers?|questions to ask)\b/i,
  ],
  ["timeline", /\b(timeline|schedule|deadlines?|due|digest|summary|at risk|overdue|tasks?)\b/i],
  [
    "budget_change",
    /\b(budget|guests?|cost|price|swap|replace|increase|decrease|cut|add|remove|afford|over)\b/i,
  ],
];
const DIRECTIVE =
  /\b(by|before|deadline|asap|must|make sure|please (?:send|share|confirm|submit))\b/i;

/**
 * Reads what an @huddle message is asking for.
 * @param {string} text The message without the @huddle mention.
 * @returns {{intent: string, suggestDirective: boolean}} The intent and whether it reads like an instruction.
 */
export function demoIntent(text) {
  const intent = RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "question";
  return { intent, suggestDirective: DIRECTIVE.test(text) };
}
