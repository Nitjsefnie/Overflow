/**
 * A catalog label with the field name removed from its head.
 *
 * A perception-based catalog stores its labels as "<name>: <value>", so a cell
 * that renders the name as its term would print the name twice — once in the
 * term, once at the head of the value. Stripping runs only against the name the
 * page resolved for its term, never against a fallback term, and a label
 * without that exact prefix is returned unchanged.
 */
export function stripNamePrefix(label: string, name: string | undefined): string {
  if (name === undefined || name === "" || !label.startsWith(`${name}: `)) {
    return label;
  }
  return label.slice(`${name}: `.length);
}
