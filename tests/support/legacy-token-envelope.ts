/**
 * A credential envelope produced by the pre-rotation v1 cipher (no key id, no
 * associated data) under a fixed test key. It stands for rows stored before
 * the v2 envelope existed, so it must never be regenerated with current code.
 */
export const legacyV1Key = "WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo";
export const legacyV1Envelope = "v1.I8w9W7wBj4TkEfz-.iA9UmEanB0g4T9bBHPpHyQ.uLwOuu9IwcxCYG5eNadFDIP5l7E";
export const legacyV1Plaintext = "legacy-v1-credential";
