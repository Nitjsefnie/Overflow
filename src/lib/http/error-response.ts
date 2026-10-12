/** The error body shared by HTTP failures and the recorded API surface. */
export function errorEnvelope(code: string, message: string, extra?: Record<string, unknown>) {
  return { error: { code, message, ...extra } };
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  options?: { extra?: Record<string, unknown>; headers?: HeadersInit },
): Response {
  return Response.json(errorEnvelope(code, message, options?.extra), {
    status,
    headers: options?.headers,
  });
}
