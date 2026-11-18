import fs from "node:fs";
export function killPort(port: number) {
  for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.includes(`PORT=${port}`) && env.some((e) => e.startsWith("CARECIRCLE_DB=") && e.includes("cc-e2e-"))) process.kill(Number(pid), "SIGKILL");
    } catch {}
  }
}
