import { randomUUID } from "node:crypto";
import type { SqlClient } from "@/lib/db/types";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import type { WebhookDeliveryClaim, WebhookReceiptScope } from "@/lib/webhooks/processor";

type WebhookDeliveryClaimRow = {
  status: WebhookDeliveryClaim["status"];
  id: string | null;
  processing_lease_token: string | null;
};

/**
 * Claims a delivery's receipt under a fresh processing lease, classifying it in
 * the same statement as the upsert so no second read can race it. CLAIMED when
 * the receipt was new, FAILED or held by a lapsed lease; DUPLICATE when the
 * scoped receipt is PROCESSED — by delivery key, or by the signed body's
 * digest whatever the delivery id; IN_PROGRESS otherwise — a live lease, or a
 * conflicting row committed after this statement's snapshot, which it cannot
 * see. Legacy receipts carry no registration and never match the lookup.
 *
 * The digest is the mixed-version safe leg of that rule: the previous release
 * keeps writing digest-less receipts during the switch, so the lookup can only
 * match rows this release wrote, and a claim whose digest is absent matches
 * nothing at all and falls back to the delivery-id-only rule (issue 1041).
 */
export async function claimDelivery(
  sql: SqlClient,
  delivery: GitHubWebhookDelivery,
  scope: WebhookReceiptScope,
): Promise<WebhookDeliveryClaim> {
  const leaseToken = randomUUID();
  const [row] = await sql<WebhookDeliveryClaimRow[]>`
      with replay as (
        select exists (
          select 1 from webhook_deliveries
          where provider = ${scope.provider}
            and registration_id = ${scope.registrationId}
            and body_digest = ${scope.bodyDigest ?? null}
            and processing_state = ${"PROCESSED"}
        ) as hit
      ),
      claimed as (
        insert into webhook_deliveries (
          provider, registration_id, delivery_key, execution_id, event_name, body_digest,
          processing_state, processing_lease_token, lease_expires_at, attempt_count
        )
        select ${scope.provider}, ${scope.registrationId}, ${delivery.deliveryId}, ${delivery.executionId},
          ${delivery.event}, ${scope.bodyDigest ?? null},
          ${"PENDING"}, ${leaseToken}, now() + interval '5 minutes', 1
        where not exists (select 1 from replay where hit)
        on conflict (provider, registration_id, delivery_key) where registration_id is not null do update
        set event_name = excluded.event_name, execution_id = excluded.execution_id,
            body_digest = excluded.body_digest,
            processing_state = ${"PENDING"},
            processing_lease_token = excluded.processing_lease_token,
            lease_expires_at = excluded.lease_expires_at,
            attempt_count = webhook_deliveries.attempt_count + 1,
            error_message = null, processed_at = null
        where webhook_deliveries.processing_state = ${"FAILED"}
          or (
            webhook_deliveries.processing_state = ${"PENDING"}
            and coalesce(webhook_deliveries.lease_expires_at, webhook_deliveries.received_at) <= now()
          )
        returning id::text, processing_lease_token::text
      )
      select 'CLAIMED' as status, id, processing_lease_token from claimed
      union all
      select case
          when (select hit from replay) then 'DUPLICATE'
          when exists (
            select 1 from webhook_deliveries existing
            where existing.provider = ${scope.provider}
              and existing.registration_id = ${scope.registrationId}
              and existing.delivery_key = ${delivery.deliveryId}
              and existing.processing_state = ${"PROCESSED"}
          ) then 'DUPLICATE'
          else 'IN_PROGRESS'
        end, null, null
      where not exists (select 1 from claimed)
    `;
  if (row?.status === "CLAIMED" && row.id !== null && row.processing_lease_token !== null) {
    return { status: "CLAIMED", receiptId: row.id, leaseToken: row.processing_lease_token };
  }
  // A missing row cannot occur against a real database; if it ever does, it must stay IN_PROGRESS, the retry side.
  return { status: row?.status === "DUPLICATE" ? "DUPLICATE" : "IN_PROGRESS" };
}

/** Marks a receipt PROCESSED; true only when the caller still held its lease. */
export async function markProcessed(sql: SqlClient, receiptId: string, leaseToken: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
      update webhook_deliveries
      set processing_state = ${"PROCESSED"},
          processed_at = now(),
          error_message = null,
          processing_lease_token = null, lease_expires_at = null
      where id = ${receiptId}
        and processing_state = ${"PENDING"}
        and processing_lease_token = ${leaseToken}
      returning id
    `;
  return rows.length === 1;
}

/**
 * Marks a receipt FAILED; true only when the caller still held its lease. The
 * stored message is a fixed string, so `errorMessage` is deliberately unused.
 */
export async function markFailed(
  sql: SqlClient,
  receiptId: string,
  leaseToken: string,
  errorMessage: string,
): Promise<boolean> {
  void errorMessage;
  const rows = await sql<{ id: string }[]>`
      update webhook_deliveries
      set processing_state = ${"FAILED"},
          error_message = ${"Webhook processing failed."},
          processed_at = now(),
          processing_lease_token = null,
          lease_expires_at = null
      where id = ${receiptId}
        and processing_state = ${"PENDING"}
        and processing_lease_token = ${leaseToken}
      returning id
    `;
  return rows.length === 1;
}
