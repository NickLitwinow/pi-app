import type { PackageKind, PackageSetting, PiPackage } from "./types";

const RESOURCE_KEY: Record<PackageKind, "extensions" | "skills" | "themes" | "prompts"> = {
  extension: "extensions",
  skill: "skills",
  theme: "themes",
  prompt: "prompts",
};

export function packageSource(spec: PackageSetting): string {
  return typeof spec === "string" ? spec : spec.source;
}

function gitPackagePath(source: string): string | null {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const raw = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
  const protocol = /^(?:https?|ssh|git):\/\//i.test(raw);
  if (!hasGitPrefix && !protocol) return null;

  let repositoryPath = "";
  const scp = raw.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    repositoryPath = scp[2] ?? "";
  } else if (protocol) {
    try {
      repositoryPath = new URL(raw).pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  } else {
    const slash = raw.indexOf("/");
    if (slash < 0) return null;
    repositoryPath = raw.slice(slash + 1);
  }

  repositoryPath = repositoryPath.split(/[?#]/, 1)[0];
  const refAt = repositoryPath.indexOf("@");
  if (refAt >= 0) repositoryPath = repositoryPath.slice(0, refAt);
  return repositoryPath.replace(/[\\/]+$/, "").replace(/\.git$/i, "") || null;
}

/** Convert package specs into the stable display/resource-filter name. */
export function packageNameFromSpec(spec: PackageSetting | unknown): string | null {
  const sourceSpec = typeof spec === "string"
    ? spec
    : spec && typeof spec === "object" && "source" in spec && typeof spec.source === "string"
      ? spec.source
      : "";
  const gitPath = gitPackagePath(sourceSpec);
  if (gitPath) {
    const name = gitPath.slice(gitPath.lastIndexOf("/") + 1);
    return name || null;
  }
  if (sourceSpec.startsWith("npm:")) {
    const source = sourceSpec.slice(4);
    if (source.startsWith("@")) {
      const versionSeparator = source.indexOf("@", source.indexOf("/") + 1);
      return versionSeparator > 0 ? source.slice(0, versionSeparator) : source;
    }
    const versionSeparator = source.indexOf("@");
    return versionSeparator > 0 ? source.slice(0, versionSeparator) : source;
  }
  // Pi also accepts local package directories. Keep those visible in the
  // Installed view instead of silently dropping every non-npm/non-git spec.
  const clean = sourceSpec.trim().replace(/^file:/, "").split(/[?#]/, 1)[0].replace(/[\\/]+$/, "");
  const name = clean.split(/[\\/]/).pop()?.replace(/\.git$/, "");
  return name || null;
}

export function isPackageResourceEnabled(spec: PackageSetting, kind: PackageKind): boolean {
  if (typeof spec === "string") return true;
  const filter = spec[RESOURCE_KEY[kind]];
  return filter === undefined || filter.length > 0;
}

export function setPackageResourceEnabled(
  packages: PackageSetting[],
  packageIdentifier: string,
  kind: PackageKind,
  enabled: boolean,
): PackageSetting[] {
  const key = RESOURCE_KEY[kind];
  return packages.map((spec) => {
    if (packageSource(spec) !== packageIdentifier && packageNameFromSpec(spec) !== packageIdentifier) return spec;
    const next: Exclude<PackageSetting, string> = typeof spec === "string" ? { source: spec } : { ...spec };
    if (enabled) delete next[key];
    else next[key] = [];
    return Object.keys(next).length === 1 ? next.source : next;
  });
}

export function packageCliSource(pkg: Pick<PiPackage, "name" | "source">): string {
  return pkg.source || `npm:${pkg.name}`;
}

/** Unknown manifests remain visible so custom package layouts are manageable;
 * a successfully inspected manifest with no matching resource is filtered. */
export function packageProvidesResource(
  pkg: Pick<PiPackage, "resourceKinds">,
  kind: PackageKind,
): boolean {
  return !Array.isArray(pkg.resourceKinds) || pkg.resourceKinds.includes(kind);
}

const KIND_RISK: Record<PackageKind, { label: string; title: string; className: string }> = {
  extension: { label: "исполняет код", title: "Расширение исполняется с правами текущего пользователя", className: "danger" },
  skill: { label: "контекст модели", title: "Описание и инструкции skill влияют на системный контекст", className: "context" },
  theme: { label: "только оформление", title: "Тема меняет палитру и оформление", className: "safe" },
  prompt: { label: "инструкции модели", title: "Prompt меняет инструкции, передаваемые модели", className: "context" },
};

const INSTALLED_PACKAGE_RISK = {
  label: "может исполнять код",
  title: "Установленный pi-пакет может одновременно содержать extensions, skills, themes и prompts; эта вкладка управляет только выбранным типом ресурса",
  className: "danger",
};

export function packageRisk(kind: PackageKind, installed: boolean) {
  return installed ? INSTALLED_PACKAGE_RISK : KIND_RISK[kind];
}
