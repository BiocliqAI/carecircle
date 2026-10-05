# COMPLIANCE_ESCALATION.md
Purpose: resolve an incomplete required monitoring/care task; this is not emergency management.

Flow: Task due -> patient reminder(s) -> OVERDUE -> L1_NOTIFIED -> L1_ACKNOWLEDGED/resolution window -> L2 if timeout -> L3 -> RESOLVED or EXHAUSTED.

Rules:
- acknowledgement is not resolution
- acknowledgement may pause advancement for configured resolution window
- patient completion at any active level resolves idempotently
- no proactive Doctor/PA notification
- every send, acknowledgement, timeout, transition and resolution is audited
- timers are configuration, not code constants
- invalid transitions are rejected and audited
