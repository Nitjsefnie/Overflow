import { errorResponse } from "@/lib/http/error-response";
import { PostgresWorkMailStore } from "@/lib/accounts/work-mail-store";
import { verifyUnsubscribeToken } from "@/lib/accounts/work-mail-unsubscribe";

export type WorkMailUnsubscribeRouteDependencies = {
  deleteSubscriptionById: (subscriptionId: string) => Promise<boolean>;
  verifyToken?: (token: string) => string | null;
};

// RFC 8058's one-click POST carries no cookie and a form body: the signed token is the only authority.
export function createWorkMailUnsubscribePostHandler(dependencies: WorkMailUnsubscribeRouteDependencies) {
  return async function unsubscribeWorkMail(request: Request): Promise<Response> {
    try {
      const token = new URL(request.url).searchParams.get("token") ?? "";
      const subscriptionId = (dependencies.verifyToken ?? verifyUnsubscribeToken)(token);
      if (subscriptionId !== null) await dependencies.deleteSubscriptionById(subscriptionId);
    } catch {
      console.error("Work mail unsubscribe failed.");
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to unsubscribe.");
    }
    return Response.json({ received: true });
  };
}

// A form with no action posts back to this exact URL, token included.
const CONFIRM_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stop Overflow work emails</title></head>
<body>
<h1>Stop Overflow work emails</h1>
<form method="post"><button type="submit">Unsubscribe</button></form>
</body>
</html>
`;

/** A client without one-click support opens the link with GET, which only offers the POST. */
export async function GET(): Promise<Response> {
  return new Response(CONFIRM_PAGE, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export const POST = createWorkMailUnsubscribePostHandler({
  deleteSubscriptionById: (subscriptionId) => new PostgresWorkMailStore().deleteSubscriptionById(subscriptionId),
});
