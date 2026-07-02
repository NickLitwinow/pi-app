import { useEffect, useMemo, useState } from "react";
import { getBackend } from "../lib/backend";
import type { AnalyticsOverview } from "../lib/types";

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

const WEEKS = 26;

function Heatmap({ perDay }: { perDay: AnalyticsOverview["perDay"] }) {
  const cells = useMemo(() => {
    const byDate = new Map(perDay.map((d) => [d.date, d]));
    const out: { date: string; messages: number; cost: number }[] = [];
    const today = new Date();
    // align to the end of the current week
    const total = WEEKS * 7;
    for (let i = total - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400e3);
      const key = d.toISOString().slice(0, 10);
      const stat = byDate.get(key);
      out.push({ date: key, messages: stat?.messages ?? 0, cost: stat?.cost ?? 0 });
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
            : `color-mix(in srgb, var(--accent) ${Math.round(25 + ratio * 75)}%, transparent)`;
        return (
          <div
            key={c.date}
            className="hm-cell"
            style={{ background: bg }}
            title={`${c.date}: ${c.messages} сообщ.${c.cost > 0 ? `, $${c.cost.toFixed(2)}` : ""}`}
          />
        );
      })}
    </div>
  );
}

export default function AnalyticsView() {
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const be = await getBackend();
        setData(await be.invoke<AnalyticsOverview>("analytics_overview"));
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, []);

  if (err) return <div className="empty">{err}</div>;
  if (!data)
    return (
      <div className="empty">
        <div className="spinner" />
      </div>
    );

  const t = data.totals;

  return (
    <div className="chat">
      <div className="topbar" data-tauri-drag-region>
        <span className="title">Аналитика</span>
      </div>
      <div className="view">
      <div className="stat-grid">
        <div className="stat">
          <div className="s-label">Стоимость (всего)</div>
          <div className="s-val">${t.cost.toFixed(2)}</div>
        </div>
        <div className="stat">
          <div className="s-label">Сессии</div>
          <div className="s-val">{fmt(t.sessions)}</div>
        </div>
        <div className="stat">
          <div className="s-label">Сообщения</div>
          <div className="s-val">{fmt(t.messages)}</div>
        </div>
        <div className="stat">
          <div className="s-label">Токены ввода</div>
          <div className="s-val">{fmt(t.input)}</div>
        </div>
        <div className="stat">
          <div className="s-label">Токены вывода</div>
          <div className="s-val">{fmt(t.output)}</div>
        </div>
        <div className="stat">
          <div className="s-label">Кэш (чтение)</div>
          <div className="s-val">{fmt(t.cacheRead)}</div>
        </div>
      </div>

      <h2>Активность за {WEEKS} недель</h2>
      <Heatmap perDay={data.perDay} />

      <h2>По моделям</h2>
      <table className="data">
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
        </tbody>
      </table>
      </div>
    </div>
  );
}
