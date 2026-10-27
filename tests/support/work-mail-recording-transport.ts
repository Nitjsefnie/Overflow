import type { SendResult, WorkMailMessage, WorkMailTransport } from "@/lib/accounts/work-mail-transport";

export function recordingTransport(result: SendResult = { ok: true }): WorkMailTransport & { sent: WorkMailMessage[] } {
  const sent: WorkMailMessage[] = [];
  return {
    sent,
    send: async (message) => {
      sent.push(message);
      return result;
    },
  };
}
