export type RouterExpectation = {
	profile: "feature" | "bug" | "chore" | "hotfix" | "research" | "assessment";
	mutation: boolean;
	preview?: boolean;
	research?: boolean;
	deletion?: boolean;
	approval?: boolean;
};

export type RouterScenario = {
	id: string;
	prompt: string;
	expect: RouterExpectation;
};

export const deterministicRouterScenarios: RouterScenario[];
export const semanticAmbiguityScenarios: RouterScenario[];
export const routerScenarios: RouterScenario[];
