// Wording of the consent reminder, shared by the PA's "Resend" button and the automatic follow-up.
export const consentReminderBody = (role: string, patientName: string, clinic: string | null) =>
  role === "PATIENT"
    ? `🔔 Reminder from ${clinic ?? "your clinic"}: please reply *YES* so your readings can be shared with your care team, or *NO* to decline.`
    : `🔔 Reminder: ${patientName} has asked you to be in their CareCircle${clinic ? ` at ${clinic}` : ""}. Reply *YES* to join, or *NO* to decline.`;
