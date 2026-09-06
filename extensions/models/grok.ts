// Grok model harness: xAI models (grok-*), used here both interactively and
// as the "frontier" consultant via OAuth.
//
// No custom behaviors yet. Add hooks from the ModelHarness interface as
// needs appear (beforeProviderRequest for payload quirks, onMessageEnd for
// output repair, register for a /grok command) and list each one in
// `behaviors` so /harness stays truthful.

import type { ModelHarness } from "./types.ts";
import { modelBlob, modelProvider } from "./types.ts";

export const grokHarness: ModelHarness = {
	id: "grok",
	behaviors: [],
	matches: (ctx) => modelProvider(ctx) === "xai" || modelBlob(ctx).includes("grok"),
};
