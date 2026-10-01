/**
 * Issue 878: a GitHub collection walk must terminate.
 *
 * A walk ends only when the instance stops advertising a continuation — here a
 * `next` Link relation. Nothing else about that header can stop it: a walk that
 * ignores the advertised target and simply counts its own pages sees a
 * `rel="next"` that is fresh on every single response, so an instance that
 * always has another page issues requests forever, holding the caller against a
 * collection that is not converging, and nothing in the run says why.
 *
 * This ceiling makes that worst case FINITE, and makes the walk fail rather
 * than answer short: it throws a plain `Error` naming the collection and the
 * ceiling, so a read that was cut off cannot be passed off as a complete one —
 * a caller handed a truncated catalog would go on to refuse a scheme that does
 * exist. How far that message travels belongs to the callers, not to this
 * module, and today it goes no further than they: `githubSetupError` and both
 * repository route handlers map any error that is not a `GitHubApiError` to a
 * generic upstream failure, `RepositoryRegistrationError` carries no `cause`,
 * and none of those three logs. So the walk is bounded and the failure is
 * typed, but nothing here is observable by an operator; the GitLab sibling's
 * settled design has the same property, and the fix for it belongs at those
 * catches rather than in a bound.
 *
 * Sizing, and what each number costs. Both are POLICY values, not measurements
 * of any repository, and the arithmetic between them is load-bearing:
 *
 * - GitHub clamps `per_page` at 100 on this endpoint and the walk always asks
 *   for the maximum, so a full page is 100 rows. `MAX_WALK_ITEMS` is 10 000
 *   rows — 100 full pages. It counts rows FETCHED, not distinct names: a page
 *   that repeats rows the walk already has still spends its budget, so the
 *   number of names a walk can return is larger than 10 000, which is the safe
 *   direction to be wrong in. A repository's label catalog is a small
 *   collection by nature: labels are hand-created, deduplicated by name and
 *   rarely reach even the low thousands, so 10 000 sits an order of magnitude
 *   above the largest catalog worth reading and every legitimate walk
 *   completes. It is also a fifteenth of the GitLab sibling's 150 000, which is
 *   sized for a whole project's lifetime issue listing rather than one
 *   repository's label catalog — a smaller collection does not need a larger
 *   budget.
 * - `MAX_WALK_PAGES` is 200. It is the backstop for an instance that answers
 *   with empty or near-empty pages forever: the row count never moves, so the
 *   row ceiling never fires on that walk and this ceiling is the only thing
 *   that ends it. Without this ceiling such a walk is unbounded, not 200
 *   requests. A legitimate walk reaches it at 10 000 rows and not before.
 *
 * The row ceiling must stay below `MAX_WALK_PAGES * 100`, or a full-page walk
 * reaches the page ceiling first and the row ceiling is shadowed by it — dead
 * code that can never throw. At 10 000 against 20 000 the row ceiling fires at
 * request 101 and the page ceiling at 201, so both are live and each catches
 * the walk it exists for.
 *
 * The row ceiling is a MEMORY ceiling, and the honest reading of it is that a
 * legitimate maximum-size catalog is read into memory in full: a walk that
 * gets near it holds every row it has accumulated, up to 10 000 label rows.
 * That is MORE than the walk this bound replaced held, not the same: that walk
 * projected each page into a `Set<string>` as it went and kept only the
 * distinct names, never a parsed row, whereas this one accumulates the rows
 * and projects them once the walk ends. So a walk at the ceiling holds 10 000
 * parsed rows alongside the Set it projects from them. The increase is the
 * price of a bound at all — it is what buys a walk that terminates instead of
 * one that does not — and unlike the walk it replaced it is finite. Anything
 * smaller would make the ceiling a likelier cause of a failed registration
 * than a cause of protection from one.
 */
export const MAX_WALK_ITEMS = 10_000;
export const MAX_WALK_PAGES = 200;

export class CollectionWalkBound<T> {
  private pages = 0;
  private readonly rows: T[] = [];

  public constructor(private readonly collection: string) {}

  /**
   * Records one fetched page, or throws once the walk is out of budget.
   *
   * A body that is not an array gets past both checks: `NaN > MAX_WALK_ITEMS`
   * is false, and the element-wise loop then raises an incidental `TypeError`
   * rather than the typed error. The walk this replaced raised that same
   * `TypeError`, so it is not a regression, but it is the one hostile response
   * that does not get the typed error. Rejecting it belongs to the response
   * parser, which is not this module's business.
   */
  public add(page: T[]): void {
    this.pages += 1;
    if (this.pages > MAX_WALK_PAGES) {
      throw new Error(
        `GitHub returned more than ${MAX_WALK_PAGES} pages of ${this.collection}, past the collection-walk bound.`,
      );
    }
    // The row check runs BEFORE the append, on the page's own length: an
    // instance is free to answer with one oversized page, and appending such a
    // page first would spill the argument limit and die with a RangeError
    // instead of the typed error. The append below is element-wise for the
    // same reason — `push(...page)` spreads the whole page onto the stack.
    if (this.rows.length + page.length > MAX_WALK_ITEMS) {
      throw new Error(
        `GitHub returned more than ${MAX_WALK_ITEMS} rows of ${this.collection}, past the collection-walk bound.`,
      );
    }
    for (const row of page) this.rows.push(row);
  }

  /**
   * The rows collected so far, by reference: a caller that pushed into this
   * array would corrupt the accounting the next `add` reads. Every caller
   * projects it read-only.
   */
  public get collected(): T[] {
    return this.rows;
  }
}
