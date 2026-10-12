import { formatWithOptions } from "node:util";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";

let installed = false;

/** Installs sd-daemon priorities on the Node server's journal-connected stderr. */
export function installJournalLevels(): void {
  if (!process.env.JOURNAL_STREAM || installed) return;

  // Next's console wrappers can prepend ANSI dim codes. Render and write here
  // so the journal priority is the first bytes of every line, even in a dimmed
  // render scope. Non-journal processes retain their existing console methods.
  console.error = (...args: unknown[]) => writeJournalLine(3, args);
  console.warn = (...args: unknown[]) => writeJournalLine(4, args);
  installed = true;
}

function writeJournalLine(priority: 3 | 4, args: unknown[]): void {
  // Next 16.3.8's console-exit uses this shared store to isolate inspection and
  // output from prerender sync-I/O tracking. Preserve it without console-dim.
  workUnitAsyncStorage.exit(() => {
    const prefix = `<${priority}>`;
    const rendered = formatWithOptions({ colors: false }, ...args);
    process.stderr.write(rendered.split("\n").map((line) => prefix + line).join("\n") + "\n");
  });
}
