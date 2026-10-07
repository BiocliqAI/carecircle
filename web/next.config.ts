import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Single-process demo: the SQLite DB lives in ./data and is accessed from route handlers.
  reactStrictMode: true,
  // Live-clinic mode runs alongside the sample demo, so it needs its own build directory.
  distDir: process.env.CARECIRCLE_MODE === "live" ? ".next-clinic" : ".next",
  turbopack: { root: __dirname },
  // Opening the dev server through an ngrok tunnel (testing real WhatsApp locally). Has no effect on production builds.
  allowedDevOrigins: ["*.ngrok-free.dev", "*.ngrok-free.app", "*.ngrok.app"],
};

export default nextConfig;
