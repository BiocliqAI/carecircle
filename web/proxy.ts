// Password gate for hosted deployments. Set APP_PASSWORD (and optionally APP_USER) to require
// HTTP Basic auth on every page and API route. Unset (local use) = no gate. Twilio webhooks are exempt: they
// carry Twilio's signature instead, which the routes check.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) return NextResponse.next();
  const user = process.env.APP_USER || "carecircle";
  const header = req.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const [u, ...rest] = atob(header.slice(6)).split(":");
    if (u === user && rest.join(":") === password) return NextResponse.next();
  }
  return new NextResponse("Authentication required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="CareCircle", charset="UTF-8"' } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health|api/twilio).*)"],
};
