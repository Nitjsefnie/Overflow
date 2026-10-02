/**
 * The rules for asking for a correction, in one place.
 *
 * The terms page names the Disputes section of the rules page as the source of
 * truth for how correction requests work, so the terms page is making a promise
 * about a case the rules page must actually carry. It used to keep its own copy
 * of the promise instead, and the copies drifted: the terms page promised a
 * sanction could be contested while the rules it pointed at spoke only of
 * settlements, and its "the settlement's creditor or the sponsor can ask"
 * sentence was meaningless for a sanction, which has no creditor. A reader
 * following the pointer found no such case.
 *
 * One exported source removes the gap. The rules page renders this list, the
 * terms page renders the same list, and neither page can assert a correction
 * route the other does not carry — an edit to a rule is one edit, and a rule
 * that stops being true of a settlement stops being claimed for both pages at
 * once. (Issue 954.)
 *
 * The wording is the text a reader is held to, so it moves the way a legal
 * document moves: through src/lib/legal-revisions.ts, never as a quiet copy
 * edit. The two pages are two views of one rule, not two rules, so neither
 * carries its own revision stamp for this list.
 */
export const DISPUTE_RULES = [
  "Ask for a correction if a settlement is wrong — including when review rounds cost you credits through a maintainer's mistake.",
  "The settlement's creditor or the sponsor can ask; a moderator decides.",
  "One open request per issue at a time.",
] as const;

/**
 * The case a correction request can be made for, named the way a page names it
 * mid-sentence.
 *
 * DISPUTE_RULES above is the rules themselves; this is the noun those rules are
 * ABOUT, and a page that says "contesting X cites that date" is making the same
 * claim the list does. It lived only as a hand-written phrase in the terms
 * revision paragraph, which is how that paragraph came to promise a sanction
 * could be contested — the drift this file exists to end, reached through a
 * sentence the list itself never appears in. Generating the sentence from this
 * constant removes the second place the claim can be made.
 *
 * A page interpolates it mid-sentence, so the value carries its own article
 * ("a settlement", not "settlement").
 */
export const DISPUTE_CONTESTABLE_CASE = "a settlement";
