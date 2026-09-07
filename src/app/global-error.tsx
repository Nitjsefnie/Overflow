"use client";

import ErrorFallback from "@/components/error-fallback";
import "./globals.css";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorFallback digest={error.digest} reset={reset} headingId="global-error-title" />
      </body>
    </html>
  );
}
