import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

export function Sparkline({
  data,
  tone = "auto",
  height = 32,
}: {
  data: number[];
  tone?: "auto" | "positive" | "negative" | "muted";
  height?: number;
}) {
  if (!data || data.length < 2) {
    return <div className="text-[11px] text-muted-foreground">—</div>;
  }
  const first = data[0];
  const last = data[data.length - 1];
  const t =
    tone === "auto" ? (last >= first ? "positive" : "negative") : tone;
  const color =
    t === "positive"
      ? "var(--color-positive)"
      : t === "negative"
        ? "var(--color-negative)"
        : "var(--color-muted-foreground)";
  return (
    <div style={{ height, width: "100%" }}>
      <ResponsiveContainer>
        <LineChart data={data.map((v, i) => ({ i, v }))}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
