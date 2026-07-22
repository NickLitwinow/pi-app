/** Read-only runtime probe loaded only by runtime-command-smoke.mjs. */
export default function extensionSurfaceProbe(pi) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setWidget(
			"pi-app-extension-surface-probe",
			[JSON.stringify(pi.getAllTools().map((tool) => ({
				name: tool.name,
				source: tool.sourceInfo?.source,
			})))],
		);
	});
}
