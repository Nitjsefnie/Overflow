"use client";

import ErrorFallback from "@/components/error-fallback";

export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorFallback digest={error.digest} reset={reset} headingId="error-title" />
  );
}
