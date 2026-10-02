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
 * once. The list is what either page may promise; the case both name it under
 * is the second export below. (Issue 954.)
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
 * ABOUT, and a page that says "contesting X cites that date", or "a correction
 * to X is decided under the Disputes section", is making the same claim the
 * list does. Both of those sentences were hand-written, one in the revision
 * paragraph of each page, which is how the terms page came to promise a
 * sanction could be contested — the drift this file exists to end, reached
 * through sentences the list itself never appears in. Both paragraphs
 * interpolate this constant now.
 *
 * MOVES WITH DISPUTE_RULES — touch both in one edit. A fourth rule naming a
 * sanction, with this constant left at "a settlement", renders a sanction rule
 * on both pages under a heading and two revision paragraphs that say a
 * settlement, and every assertion in the suite stays green: each of them
 * compares a page against whichever constant it reads, so a page cannot
 * contradict itself into a failure. Nothing here detects THAT half-move,
 * because adding a case is a legitimate product change at the list level —
 * which is exactly why it has to be a review decision and not a type error.
 *
 * The other half of the pair is covered, for the record. Widening this constant
 * and DISPUTE_RULES while leaving the terms page's Disputes heading at
 * "Contesting a settlement" fails terms-page.test.tsx, which asserts the
 * heading carries this value; that heading is the only hand-written case name
 * left on either page, and it is deliberately a literal so that a test-side
 * literal is a third source beside these two constants. A complete widening
 * therefore edits, in one commit: both constants, the terms heading, the
 * literal the terms test resolves that heading by, and the DISPUTE_RULES
 * bullets that name the case — the first and the second today. The second is
 * the sharper of the two: it is hand-written prose whose "the settlement's
 * creditor" means nothing for a sanction, which is the very incoherence this
 * file's header describes, so a widening that left it behind would ship a
 * bullet the pointer promised. The third bullet names no case and does not
 * move.
 *
 * A page interpolates it mid-sentence, so the value carries its own article
 * ("a settlement", not "settlement").
 */
export const DISPUTE_CONTESTABLE_CASE = "a settlement";
