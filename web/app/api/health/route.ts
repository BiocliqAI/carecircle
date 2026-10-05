// Unauthenticated liveness check for the hosting platform (excluded from the password gate).
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true });
}
