import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getBackend } from "../lib/backend";
import type { ModelAvatarConfig } from "../lib/types";
import { updateAppConfig, useStore } from "../state/store";

const PRESETS = [
	{ id: "pi", glyph: "π", label: "Pi" },
	{ id: "spark", glyph: "✦", label: "Spark" },
	{ id: "orbit", glyph: "◈", label: "Orbit" },
	{ id: "terminal", glyph: "›_", label: "Terminal" },
	{ id: "reasoning", glyph: "Σ", label: "Reasoning" },
] as const;

/** Аватар не настроен → стандартная иконка Pi (не пёстрый identicon). */
export const DEFAULT_PRESET = PRESETS[0];

const dataCache = new Map<string, Promise<string>>();

/** Lottie-данные приходят как data:application/json (или dotlottie) — их рисует плеер. */
export function isLottieData(data: string): boolean {
	return (
		data.startsWith("data:application/json") ||
		data.startsWith("data:application/vnd.dotlottie")
	);
}

export function decodeDataUrlJson(data: string): unknown | null {
	const comma = data.indexOf(",");
	if (comma < 0) return null;
	try {
		const raw = data.slice(comma + 1);
		const text = data.slice(0, comma).includes(";base64")
			? decodeURIComponent(escape(atob(raw)))
			: decodeURIComponent(raw);
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** Плеер Lottie: lottie-web подгружается лениво — только когда реально нужен. */
function LottieAvatar({ data, size }: { data: string; size: number }) {
	const hostRef = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		const animationData = decodeDataUrlJson(data);
		const host = hostRef.current;
		if (!animationData || !host) return;
		let anim: { destroy: () => void } | null = null;
		let cancelled = false;
		void import("lottie-web")
			.then((mod) => {
				if (cancelled || !hostRef.current) return;
				anim = mod.default.loadAnimation({
					container: hostRef.current,
					renderer: "svg",
					loop: true,
					autoplay: true,
					animationData,
				});
			})
			.catch(() => {});
		return () => {
			cancelled = true;
			anim?.destroy();
		};
	}, [data]);
	return (
		<span
			ref={hostRef}
			className="lottie-host"
			style={{ width: size, height: size, overflow: "visible" }}
			aria-hidden="true"
		/>
	);
}

export function avatarHash(identity: string): number {
	let hash = 2166136261;
	for (let index = 0; index < identity.length; index++) {
		hash ^= identity.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function avatarVariant(
	config: ModelAvatarConfig | undefined,
	working: boolean,
): { kind: "preset" | "path"; value: string } | null {
	if (working && config?.workingKind && config.workingValue) {
		return { kind: config.workingKind, value: config.workingValue };
	}
	return config?.kind && config.value
		? { kind: config.kind, value: config.value }
		: null;
}

function useAvatarConfig(modelKey: string): ModelAvatarConfig | undefined {
	return useStore((state) => state.appConfig.modelAvatars?.[modelKey]);
}

export function ModelAvatar({
	modelKey,
	size = 26,
	title,
	working = false,
}: {
	modelKey: string;
	size?: number;
	title?: string;
	working?: boolean;
}) {
	const config = useAvatarConfig(modelKey);
	const [image, setImage] = useState<string | null>(null);
	const hash = avatarHash(modelKey);
	const variant = avatarVariant(config, working);
	const activeKind = variant?.kind;
	const activeValue = variant?.value;
	// без настроенного варианта показываем стандартную иконку Pi
	const preset =
		activeKind === "preset"
			? PRESETS.find((item) => item.id === activeValue) ?? DEFAULT_PRESET
			: variant == null
				? DEFAULT_PRESET
				: null;

	useEffect(() => {
		let cancelled = false;
		if (activeKind !== "path" || !activeValue) {
			setImage(null);
			return;
		}
		let pending = dataCache.get(activeValue);
		if (!pending) {
			pending = getBackend().then((backend) =>
				backend.invoke<string>("read_avatar_data", { path: activeValue }),
			);
			dataCache.set(activeValue, pending);
		}
		void pending
			.then((data) => {
				if (!cancelled) setImage(data);
			})
			.catch(() => {
				dataCache.delete(activeValue);
				if (!cancelled) setImage(null);
			});
		return () => {
			cancelled = true;
		};
	}, [activeKind, activeValue]);

	const style = {
		width: size,
		height: size,
		"--avatar-hue": `${hash % 360}`,
		"--avatar-hue-alt": `${(hash >>> 9) % 360}`,
		"--avatar-turn": `${hash % 4}`,
	} as CSSProperties;

	const lottie = image != null && isLottieData(image);
	// Векторные аватары (SVG/Lottie) вписываем целиком: object-fit:cover обрезает
	// их по краям (растр кадрировать нормально, вектор — нет).
	const vector = lottie || (image != null && image.startsWith("data:image/svg+xml"));
	return (
		<span
			className={`agent-avatar ${image ? "image" : preset ? "preset" : "identicon"} ${vector ? "vector" : ""} ${working ? "working" : ""}`}
			style={style}
			title={title}
			aria-label={title}
		>
			{image ? (
				lottie ? (
					<LottieAvatar data={image} size={size} />
				) : (
					<img src={image} alt="" />
				)
			) : preset ? (
				<span className="avatar-glyph">{preset.glyph}</span>
			) : (
				<span className="identicon-grid" aria-hidden="true">
					<i />
					<i />
					<i />
					<i />
				</span>
			)}
		</span>
	);
}

export function ModelAvatarPicker({
	modelKey,
	size = 28,
	working = false,
}: {
	modelKey: string;
	size?: number;
	working?: boolean;
}) {
	const config = useAvatarConfig(modelKey);
	const appConfig = useStore((state) => state.appConfig);
	const isMock = useStore((state) => state.isMock);
	const [open, setOpen] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [slot, setSlot] = useState<"idle" | "working">("idle");
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	// Поповер позиционируем fixed по координатам триггера: absolute-вариант резали
	// предки с overflow:hidden (.settings-group, .dropdown), и он же вылезал за
	// экран. То же решение, что у ctx-pop в ChatView.
	const [popStyle, setPopStyle] = useState<CSSProperties>({ visibility: "hidden" });

	useLayoutEffect(() => {
		if (!open) {
			setPopStyle({ visibility: "hidden" });
			return;
		}
		const place = () => {
			const trigger = triggerRef.current?.getBoundingClientRect();
			const pop = popRef.current?.getBoundingClientRect();
			if (!trigger || !pop) return;
			const margin = 8;
			const left = Math.max(margin, Math.min(trigger.left, window.innerWidth - pop.width - margin));
			const below = trigger.bottom + 6;
			// не помещается снизу — раскрываем вверх
			const top = below + pop.height > window.innerHeight - margin
				? Math.max(margin, trigger.top - pop.height - 6)
				: below;
			setPopStyle({ left: Math.round(left), top: Math.round(top) });
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = (event: MouseEvent) => {
			const target = event.target as Node;
			// поповер теперь вне поддерева триггера (fixed), поэтому проверяем оба
			if (!rootRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
		};
		window.addEventListener("mousedown", close);
		return () => window.removeEventListener("mousedown", close);
	}, [open]);

	const saveVariant = async (
		next: { kind: "preset" | "path"; value: string } | null,
	) => {
		const current = { ...(appConfig.modelAvatars ?? {}) };
		const merged: ModelAvatarConfig = { ...(current[modelKey] ?? {}) };
		if (slot === "working") {
			if (next) {
				merged.workingKind = next.kind;
				merged.workingValue = next.value;
			} else {
				delete merged.workingKind;
				delete merged.workingValue;
			}
		} else if (next) {
			merged.kind = next.kind;
			merged.value = next.value;
		} else {
			delete merged.kind;
			delete merged.value;
		}
		if (merged.kind || merged.workingKind) current[modelKey] = merged;
		else delete current[modelKey];
		await updateAppConfig({ modelAvatars: current });
		setError(null);
	};

	const chooseImage = async () => {
		let selected: string | null = null;
		if (isMock) {
			selected =
				window
					.prompt("Путь к PNG/JPEG/GIF/WebP/SVG/Lottie(JSON):", "")
					?.trim() || null;
		} else {
			const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
			const value = await openDialog({
				multiple: false,
				directory: false,
				title: "Выберите аватар модели",
				filters: [
					{
						name: "Аватар (изображение / анимация)",
						extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "json"],
					},
				],
			}).catch(() => null);
			selected = typeof value === "string" ? value : null;
		}
		if (!selected) return;
		try {
			const backend = await getBackend();
			await backend.invoke("read_avatar_data", { path: selected });
			await saveVariant({ kind: "path", value: selected });
			setOpen(false);
		} catch (imageError) {
			setError(String(imageError));
		}
	};

	return (
		<div className="avatar-picker" ref={rootRef}>
			{/* aria-label обязателен: имя кнопки иначе берётся из содержимого (глиф
			    пресета, напр. «π»), а не из title — иконочная кнопка теряла имя */}
			<button
				ref={triggerRef}
				className="avatar-picker-trigger"
				title="Настроить аватар модели"
				aria-label="Настроить аватар модели"
				onClick={() => setOpen(!open)}
			>
				<ModelAvatar modelKey={modelKey} size={size} working={working} />
			</button>
			{open && createPortal(
				<div className="avatar-popover" ref={popRef} style={popStyle}>
					<strong>Аватар модели</strong>
					<span className="hint">
						Отдельный образ для покоя и генерации · preset, анимированный SVG или
						Lottie/GIF/WebP/PNG
					</span>
					<div
						className="avatar-slots"
						role="group"
						aria-label="Состояние аватара"
					>
						<button
							className={slot === "idle" ? "active" : ""}
							onClick={() => setSlot("idle")}
						>
							Покой
						</button>
						<button
							className={slot === "working" ? "active" : ""}
							onClick={() => setSlot("working")}
						>
							LLM работает
						</button>
					</div>
					<div className="avatar-presets">
						{PRESETS.map((preset) => (
							<button
								key={preset.id}
								className={
									(
										slot === "idle"
											? config?.kind === "preset" && config.value === preset.id
											: config?.workingKind === "preset" &&
												config.workingValue === preset.id
									)
										? "active"
										: ""
								}
								title={preset.label}
								aria-label={preset.label}
								onClick={() =>
									void saveVariant({ kind: "preset", value: preset.id })
								}
							>
								<span>{preset.glyph}</span>
							</button>
						))}
					</div>
					<button onClick={() => void chooseImage()}>
						Выбрать изображение…
					</button>
					{config && (
						<button className="hint" onClick={() => void saveVariant(null)}>
							{slot === "working"
								? "Использовать idle-иконку"
								: "Вернуть иконку по умолчанию"}
						</button>
					)}
					{error && <small className="avatar-error">{error}</small>}
				</div>,
				// Портал в body: .dropdown/.menu держат animation с retained-transform,
				// а он делает их containing block для position:fixed — поповер считался
				// от них, а не от вьюпорта, и уезжал за экран. Плюс это снимает клиппинг
				// предками с overflow:hidden (.settings-group).
				document.body,
			)}
		</div>
	);
}
