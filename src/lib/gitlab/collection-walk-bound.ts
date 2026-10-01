/**
 * Issue 869: a GitLab collection walk must terminate.
 *
 * A walk ends only when the instance stops advertising a continuation — a
 * fresh `x-next-cursor`, a strictly increasing `x-next-page`, or a `next` Link
 * relation. Every guard in the walker rejects a REPEATED continuation (a
 * repeated cursor, a repeated normalized target, a non-advancing page), and
 * none of them can reject one that is distinct on every single response. An
 * instance that always has another page therefore issues requests forever,
 * holding a reconciliation worker slot and renewing a lease against a
 * collection that is not converging, and nothing in the run says why.
 *
 * This ceiling makes that worst case FINITE and the failure OBSERVABLE: it
 * throws the same plain `GitLab returned ...` Error the walk's other guards
 * throw, so the failure lands in the gateway's existing error path and fails
 * the reconciliation loudly instead of truncating the evidence silently.
 *
 * Sizing, and what each number costs. Both are POLICY values, not measurements
 * of any instance, and the arithmetic between them is load-bearing:
 *
 * - GitLab clamps `per_page` at 100 on every list endpoint and the walker always
 *   asks for the maximum, so a full page is 100 rows. `MAX_WALK_ITEMS` is
 *   150 000 rows — 1 500 full pages — which is deliberately far above what any
 *   single project's lifetime collection holds (a full issue listing, a label
 *   catalog, one issue's notes and label events, a merge request's commits),
 *   so every legitimate walk completes and the ceiling only ever fires on an
 *   instance that is not answering the walk.
 * - `MAX_WALK_PAGES` is 2 000. It is the backstop for an instance that answers
 *   with near-empty pages forever: the row count never moves, and without it
 *   that walk is still 2 000 requests against a collection that will not end.
 *
 * The row ceiling must stay below `MAX_WALK_PAGES * 100`, or a full-page walk
 * reaches the page ceiling first and the row ceiling is shadowed by it — dead
 * code that can never throw. At 150 000 against 200 000 the row ceiling fires
 * at request 1 501 and the page ceiling at 2 001, so both are live and each
 * catches the walk it exists for.
 *
 * The row ceiling is a MEMORY ceiling, and the honest reading of it is that a
 * legitimate maximum-size collection is read into memory in full: a walk that
 * gets near it holds every row it has accumulated, up to 150 000 rows of
 * whatever shape is being walked. That retained-whole cost is the price of the
 * array being bounded at all — the alternative is the unbounded walk above,
 * which holds the same rows plus a worker slot, a lease and the run itself.
 * Anything smaller would make the ceiling a likelier cause of a failed
 * reconciliation than a cause of protection from one.
 */
export const MAX_WALK_ITEMS = 150_000;
export const MAX_WALK_PAGES = 2_000;

export class CollectionWalkBound<T> {
  private pages = 0;
  private readonly rows: T[] = [];

  public constructor(private readonly collection: string) {}

  /** Records one fetched page, or throws once the walk is out of budget. */
  public add(page: T[]): void {
    this.pages += 1;
    if (this.pages > MAX_WALK_PAGES) {
      throw new Error(
        `GitLab returned more than ${MAX_WALK_PAGES} pages of ${this.collection}, past the collection-walk bound.`,
      );
    }
    // The row check runs BEFORE the append, on the page's own length: an
    // instance is free to answer with one oversized page, and appending such a
    // page first would spill the argument limit and die with a RangeError
    // instead of the typed error. The append below is element-wise for the
    // same reason — `push(...page)` spreads the whole page onto the stack.
    if (this.rows.length + page.length > MAX_WALK_ITEMS) {
      throw new Error(
        `GitLab returned more than ${MAX_WALK_ITEMS} rows of ${this.collection}, past the collection-walk bound.`,
      );
    }
    for (const row of page) this.rows.push(row);
  }

  public get collected(): T[] {
    return this.rows;
  }
}
