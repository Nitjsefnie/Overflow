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
 * Sizing. GitLab clamps `per_page` at 100 on every list endpoint and the
 * walker always asks for the maximum, so a full page is 100 rows: the row
 * ceiling of 100 000 is a thousand full pages, an order of magnitude above any
 * real issue listing, per-issue note or label-event collection, label catalog
 * or merge request commit history, and far beyond what one reconciliation pass
 * carries. The page ceiling of 2 000 is the second, independent bound, and it
 * is the one that catches an instance answering with near-empty pages forever
 * while staying under the row ceiling — at one row a page, 2 000 requests is
 * still 2 000 requests against a collection that will not end.
 *
 * Both are enforced, because they bound different things: the row ceiling
 * bounds the accumulated array this issue names, and the page ceiling bounds
 * the request cost an under-populated instance can still inflict.
 */
export const MAX_WALK_ITEMS = 100_000;
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
    this.rows.push(...page);
    if (this.rows.length > MAX_WALK_ITEMS) {
      throw new Error(
        `GitLab returned more than ${MAX_WALK_ITEMS} rows of ${this.collection}, past the collection-walk bound.`,
      );
    }
  }

  public get collected(): T[] {
    return this.rows;
  }
}