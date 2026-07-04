import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { getBackend } from "../lib/backend";
import type { AnalyticsOverview, DayStat } from "../lib/types";
import { useStore } from "../state/store";

type Range = "all" | "30d" | "7d";
type Tab = "overview" | "models";

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

/** Текущая и рекордная серии активных дней (по датам с сообщениями). */
function streaks(active: Set<string>): { current: number; longest: number } {
  if (active.size === 0) return { current: 0, longest: 0 };
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  // текущая: считаем назад от сегодня, пока дни присутствуют
  let current = 0;
  const cur = new Date();
  while (active.has(dayKey(cur))) {
    current++;
    cur.setDate(cur.getDate() - 1);
  }
  // рекордная: самый длинный непрерывный отрезок
  const sorted = [...active].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + "T00:00:00Z");
    const d = new Date(sorted[i] + "T00:00:00Z");
    const gap = Math.round((d.getTime() - prev.getTime()) / 86400e3);
    run = gap === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

function peakHourLabel(perHour: number[]): string {
  if (!perHour?.length) return "—";
  let best = 0;
  for (let h = 1; h < perHour.length; h++) if (perHour[h] > perHour[best]) best = h;
  if (perHour[best] === 0) return "—";
  return `${String(best).padStart(2, "0")}:00`;
}

function shortModel(id: string): string {
  const base = id.split("/").pop() ?? id;
  return base.length > 22 ? base.slice(0, 21) + "…" : base;
}

const WEEKS = 26;

function Heatmap({ perDay }: { perDay: DayStat[] }) {
  const cells = useMemo(() => {
    const byDate = new Map(perDay.map((d) => [d.date, d]));
    const out: { date: string; messages: number }[] = [];
    const today = new Date();
    const total = WEEKS * 7;
    for (let i = total - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400e3);
      const key = d.toISOString().slice(0, 10);
      out.push({ date: key, messages: byDate.get(key)?.messages ?? 0 });
    }
    return out;
  }, [perDay]);

  const max = Math.max(1, ...cells.map((c) => c.messages));
  return (
    <div className="heatmap">
      {cells.map((c) => {
        const ratio = c.messages / max;
        const bg =
          c.messages === 0
            ? "var(--bg-active)"
            : `color-mix(in srgb, var(--accent) ${Math.round(22 + ratio * 78)}%, transparent)`;
        return <div key={c.date} className="hm-cell" style={{ background: bg }} title={`${c.date}: ${c.messages} сообщ.`} />;
      })}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="s-label">{label}</div>
      <div className="s-val">{value}</div>
    </div>
  );
}

export default function StartScreen() {
  const displayName = useStore((s) => s.appConfig.displayName);
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [range, setRange] = useState<Range>("all");
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    let stale = false;
    void (async () => {
      const be = await getBackend();
      const d = await be.invoke<AnalyticsOverview>("analytics_overview").catch(() => null);
      if (!stale) setData(d);
    })();
    return () => {
      stale = true;
    };
  }, []);

  const derived = useMemo(() => {
    if (!data) return null;
    const cutoff = range === "all" ? null : new Date(Date.now() - (range === "7d" ? 7 : 30) * 86400e3).toISOString().slice(0, 10);
    const days = cutoff ? data.perDay.filter((d) => d.date >= cutoff) : data.perDay;
    const active = new Set(days.filter((d) => d.messages > 0).map((d) => d.date));
    const sum = (f: (d: DayStat) => number) => days.reduce((a, d) => a + f(d), 0);
    const { current, longest } = streaks(active);
    return {
      sessions: range === "all" ? data.totals.sessions : sum((d) => d.sessions),
      messages: range === "all" ? data.totals.messages : sum((d) => d.messages),
      tokens: range === "all" ? data.totals.input + data.totals.output : sum((d) => d.input + d.output),
      activeDays: active.size,
      current,
      longest,
      peak: peakHourLabel(data.perHour),
      favorite: data.perModel[0]?.model ? shortModel(data.perModel[0].model) : "—",
    };
  }, [data, range]);

  const greeting = displayName ? `Чем займёмся, ${displayName}?` : "Чем займёмся дальше?";

  return (
    <div className="startscreen">
      <div className="ss-greeting">
        <Sparkles size={22} strokeWidth={1.75} />
        <span>{greeting}</span>
      </div>

      <div className="ss-card">
        <div className="ss-card-head">
          <div className="ss-tabs">
            <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
              Обзор
            </button>
            <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}>
              Модели
            </button>
          </div>
          <div className="ss-range">
            {(["all", "30d", "7d"] as Range[]).map((r) => (
              <button key={r} className={range === r ? "active" : ""} onClick={() => setRange(r)}>
                {r === "all" ? "Всё" : r}
              </button>
            ))}
          </div>
        </div>

        {!data || !derived ? (
          <div className="ss-loading">
            <div className="spinner" />
          </div>
        ) : tab === "overview" ? (
          <>
            <div className="stat-grid ss-stats">
              <Stat label="Сессии" value={fmt(derived.sessions)} />
              <Stat label="Сообщения" value={fmt(derived.messages)} />
              <Stat label="Всего токенов" value={fmt(derived.tokens)} />
              <Stat label="Активных дней" value={String(derived.activeDays)} />
              <Stat label="Текущая серия" value={`${derived.current} дн`} />
              <Stat label="Рекордная серия" value={`${derived.longest} дн`} />
              <Stat label="Пиковый час" value={derived.peak} />
              <Stat label="Любимая модель" value={derived.favorite} />
            </div>
            <Heatmap perDay={data.perDay} />
          </>
        ) : (
          <table className="data ss-models">
            <thead>
              <tr>
                <th>Модель</th>
                <th>Сообщений</th>
                <th>Ввод</th>
                <th>Вывод</th>
                <th>Стоимость</th>
              </tr>
            </thead>
            <tbody>
              {data.perModel.map((m) => (
                <tr key={m.model}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{m.model}</td>
                  <td>{fmt(m.messages)}</td>
                  <td>{fmt(m.input)}</td>
                  <td>{fmt(m.output)}</td>
                  <td>${m.cost.toFixed(2)}</td>
                </tr>
              ))}
              {data.perModel.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    Пока нет данных
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
