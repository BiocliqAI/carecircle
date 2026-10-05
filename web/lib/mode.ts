// Two ways to run the app:
//  - demo (default): seeded sample clinic with a scripted history, data/carecircle.db
//  - live: starts empty; the clinic, staff, patients and care circles are onboarded for real, data/clinic.db
export type AppMode = "demo" | "live";

export const MODE: AppMode = process.env.CARECIRCLE_MODE === "live" ? "live" : "demo";
export const LIVE = MODE === "live";
