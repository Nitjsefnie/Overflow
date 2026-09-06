/**
 * How a figure reads when the ledger holds points that no GitHub label backs.
 *
 * A granted correction is the only way that state is reached: the moderator
 * records the points while the issue's settled label stays null, because the
 * grant priced the work and did not claim GitHub recorded a label. Both
 * outcomes land in it, and both surfaces show it — the moderator's queue while
 * deciding, and the member's proof page afterwards.
 *
 * It lives here rather than in either component because the two must agree:
 * they are one state read by the two parties to one decision, and a page that
 * called it something else would be describing a second state that does not
 * exist. Neither surface may depend on the other, so the words belong to the
 * corrections domain that produces them.
 */
export const UNLABELLED_POINTS = "no label recorded";
