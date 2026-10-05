import type { Metadata } from "next";
import "./globals.css";
import { SessionProvider } from "@/components/client";
import { TopBar } from "@/components/TopBar";

export const metadata: Metadata = {
  title: "CareCircle — between-visit care on WhatsApp",
  description: "Patients and caregivers log on WhatsApp; doctors see the whole story between visits.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>
          <TopBar />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
