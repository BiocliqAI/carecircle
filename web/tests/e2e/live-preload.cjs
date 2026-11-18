// Test-only preload: serve the existing demo build (.next) while the app code runs in live-clinic mode.
// next.config.ts picks distDir ".next-clinic" when CARECIRCLE_MODE=live, and no live build exists (we must not
// rebuild). So CARECIRCLE_MODE is hidden while Next loads its config and set to "live" afterwards, before any route
// module (lib/mode.ts) is evaluated.
const Module = require("module");
const orig = Module._load;
Module._load = function (request, parent, isMain) {
  const exp = orig.apply(this, arguments);
  if ((request === "./config" || request === "../config" || /next[\\/]dist[\\/]server[\\/]config(\.js)?$/.test(request)) && parent && /next[\\/]dist[\\/]/.test(parent.filename)) {
    if (exp && typeof exp.default === "function" && !exp.__ccWrapped) {
      const load = exp.default;
      const wrapped = async function (...a) {
        delete process.env.CARECIRCLE_MODE;
        try { return await load.apply(this, a); } finally { process.env.CARECIRCLE_MODE = "live"; }
      };
      return new Proxy(exp, { get: (t, k) => (k === "default" ? wrapped : k === "__ccWrapped" ? true : t[k]) });
    }
  }
  return exp;
};
process.env.CARECIRCLE_MODE = "live";
