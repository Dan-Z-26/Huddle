// Offline stand-in for the Planner's intent reading: plain keyword rules, checked in this order.
const RULES = [
  ["log_expense", /\b(log|record|paid)\b|\bspent\b.*\d/i],
  ["vendor_brief", /\b(brief|hire|hiring|need an? (?:\w+ )?vendor|find an? (?:\w+ )?vendor)\b/i],
  [
    "advice",
    /\b(what (?:should|do) (?:i|we) do|next steps?|what(?:'s| is) next|advice|advise|recommend\w*)\b/i,
  ],
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
// "paid 2 lakh for the LED wall, under AV" says it paid for "the LED wall".
const PAID_FOR = /\bfor\s+(.+?)(?:\s+(?:under|in|from)\b|[.,;]|$)/i;
const DIRECTIVE =
  /\b(by|before|deadline|asap|must|make sure|please (?:send|share|confirm|submit))\b/i;

/**
 * Reads what an @huddle message is asking for.
 * @param {string} text The message without the @huddle mention.
 * @returns {{intent: string, suggestDirective: boolean, expenseDescription: string | null}} The
 *   intent, whether it reads like an instruction, and what an expense paid for.
 */
export function demoIntent(text) {
  const intent = RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "question";
  const expenseDescription =
    intent === "log_expense" ? (text.match(PAID_FOR)?.[1].slice(0, 120) ?? null) : null;
  return { intent, suggestDirective: DIRECTIVE.test(text), expenseDescription };
}
