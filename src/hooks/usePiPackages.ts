import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "../lib/backend";
import { packageNameFromSpec, packageSource } from "../lib/marketplace";
import type { ConfigFile, PackageKind, PackageSetting } from "../lib/types";

function parsePackageSettings(content: string): PackageSetting[] {
  const root = JSON.parse(content) as unknown;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    throw new Error("settings.json: корень должен быть объектом");
  }
  const raw = (root as Record<string, unknown>).packages ?? [];
  if (!Array.isArray(raw)) throw new Error("settings.json: packages должен быть массивом");
  if (raw.some((item) =>
    typeof item !== "string"
    && !(item && typeof item === "object" && "source" in item && typeof item.source === "string")
  )) {
    throw new Error("settings.json: каждый package должен быть строкой или объектом с source");
  }
  return raw as PackageSetting[];
}

/** Installed packages plus scoped, atomic resource controls. */
export function useInstalledPackages(scope: "global" | "project" = "global", cwd?: string | null): {
  installed: Set<string>;
  specs: string[];
  entries: PackageSetting[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  setResourceEnabled: (packageName: string, kind: PackageKind, enabled: boolean) => Promise<void>;
} {
  const [entries, setEntries] = useState<PackageSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reloadGeneration = useRef(0);
  const reload = useCallback(() => {
    const generation = ++reloadGeneration.current;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        if (scope === "project" && !cwd) {
          if (generation === reloadGeneration.current) setEntries([]);
          return;
        }
        const be = await getBackend();
        const file = scope === "project"
          ? await be.invoke<ConfigFile>("read_project_settings", { cwd })
          : await be.invoke<ConfigFile>("read_pi_config", { name: "settings" });
        const packages = parsePackageSettings(file.content);
        if (generation === reloadGeneration.current) {
          setEntries(packages);
          setError(null);
        }
      } catch (loadError) {
        if (generation === reloadGeneration.current) {
          setEntries([]);
          setError(`Не удалось прочитать установленные пакеты: ${String(loadError)}`);
        }
      } finally {
        if (generation === reloadGeneration.current) setLoading(false);
      }
    })();
  }, [scope, cwd]);

  useEffect(() => {
    setEntries([]);
    setLoading(true);
    setError(null);
    reload();
    return () => {
      reloadGeneration.current++;
    };
  }, [reload]);

  const installed = new Set(entries.map(packageNameFromSpec).filter((name): name is string => Boolean(name)));
  const specs = entries.map(packageSource);
  const setResourceEnabled = useCallback(async (packageName: string, kind: PackageKind, enabled: boolean) => {
    const generation = ++reloadGeneration.current;
    try {
      const be = await getBackend();
      if (scope === "project" && !cwd) throw new Error("Сначала откройте проект");
      const content = await be.invoke<string>("set_extension_resource_enabled", {
        scope,
        cwd: cwd ?? null,
        packageIdentifier: packageName,
        kind,
        enabled,
      });
      const packages = parsePackageSettings(content);
      if (generation === reloadGeneration.current) {
        setEntries(packages);
        setError(null);
      }
    } catch (mutationError) {
      if (generation === reloadGeneration.current) reload();
      throw mutationError;
    }
  }, [cwd, reload, scope]);

  return { installed, specs, entries, loading, error, reload, setResourceEnabled };
}

/** Run a Pi package command and keep its streamed lifecycle output together. */
export function useRunPi(onDone?: () => void) {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef(false);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const runPi = async (args: string[], cwd?: string | null) => {
    if (runningRef.current) return false;
    runningRef.current = true;
    setRunning(true);
    setLog((lines) => [...lines, `$ pi ${args.join(" ")}`]);
    let unlisten: (() => void) | null = null;
    let succeeded = false;
    try {
      const be = await getBackend();
      let runId: string | null = null;
      const buffered: Record<string, unknown>[] = [];
      let finish: () => void = () => {};
      const donePromise = new Promise<void>((resolve) => (finish = resolve));
      const handle = (payload: Record<string, unknown>) => {
        if (runId == null) {
          buffered.push(payload);
          return;
        }
        if (payload.runId !== runId) return;
        if (payload.done) {
          setLog((lines) => [...lines, `— завершено (код ${String(payload.code ?? "?")})`]);
          succeeded = Number(payload.code ?? 1) === 0;
          finish();
        } else if (payload.line) {
          setLog((lines) => [...lines.slice(-400), String(payload.line)]);
        }
      };
      unlisten = await be.listen("pi-cli-output", handle);
      runId = await be.invoke<string>("pi_cli_run", { args, cwd: cwd ?? null });
      for (const payload of buffered.splice(0)) handle(payload);
      await donePromise;
    } catch (error) {
      setLog((lines) => [...lines, `ошибка: ${String(error)}`]);
    } finally {
      unlisten?.();
      runningRef.current = false;
      setRunning(false);
      onDone?.();
    }
    return succeeded;
  };

  return { log, running, runPi, logRef, clearLog: () => setLog([]) };
}
