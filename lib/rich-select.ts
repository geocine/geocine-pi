// richSelect: a bordered two-column select panel built on pi's custom-UI
// API (ctx.ui.custom + pi-tui SelectList). pi's stock ctx.ui.select renders
// options as one plain string each, which is why menus built on it read as
// a wall of text. SelectList renders label and description as aligned
// columns (label bold when selected, description muted), supports
// type-to-filter, and scrolls — so every geocine menu gets "name | state"
// rows instead of concatenated sentences.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

export type { SelectItem };

export interface RichSelectOptions {
	/** Muted context lines rendered between the title and the list. */
	header?: string[];
	/** Footer hint line. Default: navigation help. */
	hint?: string;
	/** Max rows visible before scrolling. Default 12. */
	maxVisible?: number;
	/** Minimum width of the label column, so rows align. Default 16. */
	labelWidth?: number;
}

/**
 * Show a bordered panel with a titled two-column select list.
 * Returns the picked item's `value`, or undefined on escape/cancel.
 */
export async function richSelect(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
	opts?: RichSelectOptions,
): Promise<string | undefined> {
	const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title))));
		for (const line of opts?.header ?? []) {
			container.addChild(new Text(theme.fg("muted", line)));
		}

		const list = new SelectList(
			items,
			Math.min(items.length, opts?.maxVisible ?? 12),
			{
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", theme.bold(t)),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
			{ minPrimaryColumnWidth: opts?.labelWidth ?? 16 },
		);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(null);
		container.addChild(list);

		container.addChild(
			new Text(theme.fg("dim", opts?.hint ?? "up/down navigate · enter select · esc close · type to filter")),
		);
		container.addChild(new DynamicBorder((s) => theme.fg("borderAccent", s)));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
	return result ?? undefined;
}
