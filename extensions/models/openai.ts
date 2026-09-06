// OpenAI model harness: gpt-* / o-series models on the openai provider.
//
// No custom behaviors yet. Add hooks from the ModelHarness interface as
// needs appear (beforeProviderRequest for payload quirks, onMessageEnd for
// output repair, register for commands) and list each one in `behaviors`
// so /harness stays truthful.

import type { ModelHarness } from "./types.ts";
import { modelBlob, modelProvider } from "./types.ts";

export const openaiHarness: ModelHarness = {
	id: "openai",
	behaviors: [],
	matches: (ctx) => modelProvider(ctx) === "openai" || modelBlob(ctx).includes("gpt-"),
};
