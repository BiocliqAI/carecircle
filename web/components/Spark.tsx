// Small trend line with the doctor's target band shaded.
export function Spark({ points, lo, hi, tone = "brand", width = 104, height = 30, label }: { points: number[]; lo?: number | null; hi?: number | null; tone?: "brand" | "red" | "amber" | "grey"; width?: number; height?: number; label?: string }) {
  if (points.length < 2) return <span className="v2-sub">—</span>;
  const vals = [...points, ...(lo != null ? [lo] : []), ...(hi != null ? [hi] : [])];
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1) { max += 1; min -= 1; }
  const pad = 3;
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (height - pad * 2);
  const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const color = { brand: "#0F5C55", red: "#B42318", amber: "#B54708", grey: "#9FB0AC" }[tone];
  const band = lo != null && hi != null ? { y1: y(Math.min(hi, max)), y2: y(Math.max(lo, min)) } : null;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label ?? "Trend"} style={{ display: "block" }}>
      {band && <rect x="0" y={band.y1} width={width} height={Math.max(2, band.y2 - band.y1)} fill="#E8F2F0" />}
      <polyline points={points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(points[points.length - 1])} r="2.8" fill={color} />
    </svg>
  );
}
