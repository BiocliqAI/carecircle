// Unauthenticated liveness check for the hosting platform (excluded from the password gate).
// Reports the deployed commit so anyone can confirm which version is live.
export const dynamic = "force-dynamic";

const commit = process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || null;

export function GET() {
  return Response.json({
    ok: true,
    commit: commit ? commit.slice(0, 7) : "unknown",
    branch: process.env.RAILWAY_GIT_BRANCH || null,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
  });
}
