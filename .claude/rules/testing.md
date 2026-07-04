---
description: Tests — a claimed behavior must have an assertion that fails when it breaks
globs:
  - "**/*.spec.ts"
  - "**/*.spec.tsx"
---

# Tests — no false pins

- **A test whose name or comment claims to pin a behavior must FAIL when that
  behavior is reverted.** Before finishing a spec, re-read each title/comment
  and ask: "which assertion fails if this promise breaks?" If none does, fix
  the assertion or delete the claim — a false pin is worse than no test: it
  certifies a behavior nothing verifies.
- **Assert the real observable, never a proxy the test fabricated.** Asserting
  on a string the spec itself constructed (instead of one produced by the code
  under test), or on an outcome that holds with the fix deleted (e.g. "a
  follow-up create succeeds" when claims are keyed by fresh UUIDs), passes
  regardless of the code. Observe the actual state: spy the real key, read the
  produced value, drive the genuine error path.
- **A defensive branch worth writing is worth a test that enters it.** A
  try/catch or guard added "for safety" ships unpinned otherwise, and a later
  "this is dead code" cleanup silently removes the protection with a green
  suite. (M4: the registry shutdown loop's cancel isolation needed a
  deliberately-throwing handle to be testable at all.)
