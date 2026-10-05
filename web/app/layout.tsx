import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/components/client";
import { AppShell } from "@/components/AppShell";
import { MODE } from "@/lib/mode";

export const metadata: Metadata = {
  title: "CareCircle — between-visit care on WhatsApp",
  description: "Patients and caregivers log on WhatsApp; doctors see the whole story between visits.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-mode={MODE}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,650;1,9..144,500&family=Figtree:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <SessionProvider>
          <AppShell>{children}</AppShell>
        </SessionProvider>
      </body>
    </html>
  );
}
