import { z } from "zod";

/** Only repo-wide event rows carry the owning issue. */
export const manifestEventRows = z.array(z.object({
  node_id: z.string().min(1), event: z.string(),
  issue: z.object({ id: z.number().int().positive().safe(), number: z.number().int().positive().safe() }),
}));
export const perIssueEventRows = z.array(z.object({ node_id: z.string().min(1), event: z.string() }));
export const manifestCommentRows = z.array(z.object({ node_id: z.string().min(1), issue_url: z.url() }));
