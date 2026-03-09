/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const quickWatchEditorIcon = registerIcon('quick-watch-editor-label-icon', Codicon.search, localize('quickWatchEditorLabelIcon', 'Icon of the Quick Watch editor label.'));

export class QuickWatchEditorInput extends EditorInput {
	static readonly ID = 'debug.quickWatch.input';

	static _instance: QuickWatchEditorInput;
	static get instance(): QuickWatchEditorInput {
		if (!QuickWatchEditorInput._instance || QuickWatchEditorInput._instance.isDisposed()) {
			QuickWatchEditorInput._instance = new QuickWatchEditorInput();
		}

		return QuickWatchEditorInput._instance;
	}

	expression: string | undefined;

	override get typeId(): string {
		return QuickWatchEditorInput.ID;
	}

	readonly resource = undefined;

	override getName(): string {
		return localize('quickWatchInputName', "Quick Watch");
	}

	override getIcon(): ThemeIcon {
		return quickWatchEditorIcon;
	}

	override matches(other: unknown): boolean {
		return other instanceof QuickWatchEditorInput;
	}
}
