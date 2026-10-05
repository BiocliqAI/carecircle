# EMERGENCY_ESCALATION.md
Purpose: ensure an explicitly defined emergency event is acknowledged and owned by a responsible person.

This state machine is independent of compliance.

Flow: explicit emergency event -> L1 notified -> acknowledgement/action; if no acknowledgement within configured interval -> L2 -> L3 -> resolved/exhausted.

Rules:
- emergency contacts may differ from compliance caregivers
- abnormal measurements are not automatically emergencies unless an explicit configured emergency rule says so
- emergency criteria, timing and wording are versioned configuration/policy
- free-form AI judgment cannot initiate emergency state
- all transitions and acknowledgements are audited
