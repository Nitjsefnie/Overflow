// --import preload: every fetch fails.
let calls = 0;
globalThis.fetch = async () => {
  console.error(`fetch ${(calls += 1)}`);
  if (process.env.OVERFLOW_FAIL_FETCH_MODE === "503") return new Response("unavailable", { status: 503 });
  throw new TypeError("fetch failed");
};
process.on("exit", (code) => console.error(`fetches ${calls}, exit code ${code}`));
