import type { SweepPass } from "@/lib/fold/sweep-pass";
import type { WalkSubject } from "@/lib/forge/subject-listing";
import { CollectionWalkBound } from "@/lib/gitlab/collection-walk-bound";

export type WalkListingDriver = {
  kind: "cursor";
  listPage(options: { since?: string; cursor: string | null }): Promise<{ subjects: WalkSubject[]; nextCursor: string | null }>;
} | {
  kind: "timestamp";
  listPage(options: { collection: "issue" | "pull_request"; updatedAfter: string | null; updatedBefore?: string; page?: number }): Promise<{
    subjects: WalkSubject[]; nextAnchor: string | null; exhausted: boolean;
  }>;
};

type Visit = (subject: WalkSubject, anchor: string) => Promise<void>;
export async function visitWalkListing(listing: WalkListingDriver, anchors: ReturnType<SweepPass["walkAnchors"]>, visit: Visit): Promise<void> {
  if (listing.kind === "timestamp") {
    for (const collection of ["issue", "pull_request"] as const) {
      await visitTimestampListing(listing, collection, anchors[collection]?.updatedAt.toISOString() ?? null, visit);
    }
    return;
  }
  const since = anchors.subjects?.updatedAt.toISOString();
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page = await listing.listPage({ ...(since === undefined ? {} : { since }), cursor });
    for (const subject of page.subjects) await visit(subject, "subjects");
    cursor = page.nextCursor;
    if (cursor !== null && seen.has(cursor)) throw new Error("Subject listing repeated a cursor.");
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
}

async function visitTimestampListing(
  listing: Extract<WalkListingDriver, { kind: "timestamp" }>,
  collection: "issue" | "pull_request",
  updatedAfter: string | null,
  visit: Visit,
): Promise<void> {
  let page = await listing.listPage({ collection, updatedAfter });
  for (;;) {
    // The raw page is sorted. Commit its strict prefix before touching the boundary slice.
    for (const subject of page.subjects) await visit(subject, collection);
    if (page.exhausted) return;
    const boundary = page.nextAnchor;
    if (boundary === null) throw new Error("A full subject page has no timestamp anchor.");
    const bound = new CollectionWalkBound<WalkSubject>(`${collection} timestamp slice`);
    for (let offset = 1; ; offset += 1) {
      const slice = await listing.listPage({ collection, updatedAfter: boundary, updatedBefore: boundary, page: offset });
      bound.add(slice.subjects);
      for (const subject of slice.subjects) await visit(subject, collection);
      if (slice.exhausted) break;
    }
    // Equal timestamps can fill the inclusive lower bound's first pages. Walk past them
    // using window-local offsets; the durable resume position remains the staged timestamp.
    for (let offset = 2; ; offset += 1) {
      page = await listing.listPage({ collection, updatedAfter: boundary, page: offset });
      if (page.exhausted || (page.nextAnchor !== null && compareTimestamps(page.nextAnchor, boundary) > 0)) break;
      bound.add(page.subjects);
      for (const subject of page.subjects) await visit(subject, collection);
    }
  }
}

function compareTimestamps(left: string, right: string): number {
  const milliseconds = Date.parse(left) - Date.parse(right);
  if (milliseconds !== 0) return milliseconds;
  const fraction = (value: string) => /\.(\d+)/.exec(value)?.[1] ?? "";
  const a = fraction(left), b = fraction(right), precision = Math.max(a.length, b.length);
  return a.padEnd(precision, "0").localeCompare(b.padEnd(precision, "0"));
}
