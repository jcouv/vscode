/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { getDefaultHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegateFactory.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { IListAccessibilityProvider } from '../../../../base/browser/ui/list/listWidget.js';
import { ITreeContextMenuEvent, ITreeMouseEvent, ITreeNode } from '../../../../base/browser/ui/tree/tree.js';
import { toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { FuzzyScore } from '../../../../base/common/filters.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { hasKey } from '../../../../base/common/types.js';
import { RenderIndentGuides } from '../../../../base/browser/ui/tree/abstractTree.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { WorkbenchAsyncDataTree } from '../../../../platform/list/browser/listService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IDebugService, IExpression, IStackFrame } from '../common/debug.js';
import { Expression, Variable, VisualizedExpression } from '../common/debugModel.js';
import { DebugExpressionRenderer } from './debugExpressionRenderer.js';
import { VariablesRenderer, VisualizedVariableRenderer, openContextMenuForVariableTreeElement } from './variablesView.js';
import { AbstractExpressionDataSource, AbstractExpressionsRenderer, expressionAndScopeLabelProvider, IExpressionTemplateData, IInputBoxOptions, renderViewTree } from './baseDebugView.js';
import { COPY_VALUE_ID } from './debugCommands.js';
import { getContextForWatchExpressionMenu, getContextForWatchExpressionMenuWithDataAccess } from './watchExpressionsView.js';
import { IDebugVisualizerService } from '../common/debugVisualizers.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { getEvaluatableExpressionAtPosition } from '../common/debugUtils.js';
import { QuickWatchEditorInput } from '../common/quickWatchEditorInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHighlight } from '../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';

const $ = dom.$;
const MAX_VALUE_RENDER_LENGTH = 1024;

interface IQuickWatchTreeInput {
	expression: IExpression | undefined;
}

export interface IQuickWatchResult {
	expression: Expression;
	fullStringValue?: string;
	message?: string;
}

function isQuickWatchTreeInput(element: IQuickWatchTreeInput | IExpression): element is IQuickWatchTreeInput {
	return hasKey(element as IQuickWatchTreeInput, { expression: true });
}

export const QUICK_WATCH_CONTEXT_MENU = new MenuId('DebugQuickWatchContext');

export async function evaluateQuickWatchExpression(expression: Expression, session = expression.getSession(), stackFrame?: IStackFrame): Promise<IQuickWatchResult> {
	if (!session || !stackFrame) {
		expression.available = false;
		expression.value = localize('quickWatchPauseDebugger', "Pause the debugger to evaluate expressions.");
		return { expression };
	}

	await expression.evaluate(session, stackFrame, 'watch');

	if ((expression.type === 'string' || expression.type === 'System.String') && session.capabilities.supportsClipboardContext) {
		try {
			const response = await session.evaluate(expression.name, stackFrame.frameId, 'clipboard');
			if (response) {
				return { expression, fullStringValue: response.body.result };
			}
		} catch (error) {
			return { expression, message: error instanceof Error ? error.message : String(error) };
		}
	}

	return { expression };
}

class QuickWatchDataSource extends AbstractExpressionDataSource<IQuickWatchTreeInput, IExpression> {
	constructor(
		@IDebugService debugService: IDebugService,
		@IDebugVisualizerService debugVisualizer: IDebugVisualizerService,
	) {
		super(debugService, debugVisualizer);
	}

	hasChildren(element: IQuickWatchTreeInput | IExpression): boolean {
		return isQuickWatchTreeInput(element) ? !!element.expression : element.hasChildren;
	}

	protected doGetChildren(element: IQuickWatchTreeInput | IExpression): Promise<IExpression[]> {
		return Promise.resolve(isQuickWatchTreeInput(element) ? (element.expression ? [element.expression] : []) : element.getChildren());
	}
}

class QuickWatchExpressionRenderer extends AbstractExpressionsRenderer<IExpression> {
	constructor(
		private readonly expressionRenderer: DebugExpressionRenderer,
		@IDebugService debugService: IDebugService,
		@IContextViewService contextViewService: IContextViewService,
		@IHoverService hoverService: IHoverService,
		@IMenuService private readonly menuService: IMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
	) {
		super(debugService, contextViewService, hoverService);
	}

	override get templateId(): string {
		return 'quickWatchExpression';
	}

	override renderElement(node: ITreeNode<IExpression, FuzzyScore>, index: number, data: IExpressionTemplateData): void {
		data.elementDisposable.clear();
		super.renderExpressionElement(node.element, node, data);
	}

	protected override renderExpression(expression: IExpression, data: IExpressionTemplateData, highlights: IHighlight[]): void {
		const text = expression.name;
		const title = expression.type ? `${expression.type}: ${expression.value}` : expression.value;
		data.label.set(text, highlights, title);
		data.elementDisposable.add(this.expressionRenderer.renderValue(data.value, expression, {
			showChanged: true,
			maxValueLength: MAX_VALUE_RENDER_LENGTH,
			colorize: true,
			session: expression.getSession(),
		}));
	}

	protected override getInputBoxOptions(expression: IExpression, settingValue: boolean): IInputBoxOptions {
		if (settingValue) {
			return {
				initialValue: expression.value,
				ariaLabel: localize('typeNewQuickWatchValue', "Type new value"),
				onFinish: async (value: string, success: boolean) => {
					const focusedFrame = this.debugService.getViewModel().focusedStackFrame;
					if (success && value && focusedFrame && (expression instanceof Expression || expression instanceof Variable)) {
						await expression.setExpression(value, focusedFrame);
						this.debugService.getViewModel().updateViews();
					}
				}
			};
		}

		return {
			initialValue: expression.name,
			ariaLabel: localize('quickWatchExpressionInputAriaLabel', "Type Quick Watch expression"),
			placeholder: localize('quickWatchExpressionPlaceholder', "Expression to watch"),
			onFinish: () => { }
		};
	}

	protected override renderActionBar(actionBar: ActionBar, expression: IExpression): void {
		const contextKeyService = getContextForWatchExpressionMenu(this.contextKeyService, expression);
		const menu = this.menuService.getMenuActions(QUICK_WATCH_CONTEXT_MENU, contextKeyService, { arg: expression, shouldForwardArgs: false });
		const actions = getFlatContextMenuActions(menu);

		actionBar.clear();
		actionBar.context = expression;
		actionBar.push(actions, { icon: true, label: false });
	}
}

class QuickWatchAccessibilityProvider implements IListAccessibilityProvider<IExpression> {
	getWidgetAriaLabel(): string {
		return localize('quickWatchAriaTreeLabel', "Debug Quick Watch");
	}

	getAriaLabel(element: IExpression): string {
		return localize('quickWatchExpressionAriaLabel', "{0}, value {1}", element.name, element.value);
	}
}

export class QuickWatchEditor extends EditorPane {
	private readonly treeInput: IQuickWatchTreeInput = { expression: undefined };

	private container!: HTMLElement;
	private inputContainer!: HTMLElement;
	private messageElement!: HTMLElement;
	private stringContainer!: HTMLElement;
	private stringValue!: HTMLTextAreaElement;
	private treeContainer!: HTMLElement;
	private expressionInput!: InputBox;
	private actionBar!: ActionBar;
	private tree!: WorkbenchAsyncDataTree<IQuickWatchTreeInput, IExpression, FuzzyScore>;
	private currentExpression: Expression | undefined;
	private currentResult: IQuickWatchResult | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IDebugService private readonly debugService: IDebugService,
		@IMenuService private readonly menuService: IMenuService,
		@ICommandService private readonly commandService: ICommandService,
		@ILogService private readonly logService: ILogService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super(QuickWatchEditorInput.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = dom.append(parent, $('.debug-quick-watch.quick-watch-editor'));

		const controls = dom.append(this.container, $('.quick-watch-controls'));
		this.inputContainer = dom.append(controls, $('.quick-watch-input'));
		this.expressionInput = this._register(new InputBox(this.inputContainer, this.contextViewService, {
			placeholder: localize('quickWatchInputPlaceholder', "Expression to watch"),
			ariaLabel: localize('quickWatchInputLabel', "Quick Watch expression"),
			inputBoxStyles: defaultInputBoxStyles,
		}));

		this.actionBar = this._register(new ActionBar(controls, {
			hoverDelegate: getDefaultHoverDelegate('mouse'),
			ariaLabel: localize('quickWatchActions', "Quick Watch Actions")
		}));

		this.messageElement = dom.append(this.container, $('.quick-watch-message.hidden'));
		this.stringContainer = dom.append(this.container, $('.quick-watch-string.hidden'));
		this.stringValue = dom.append(this.stringContainer, $('textarea.quick-watch-string-value', { readOnly: true }));

		this.treeContainer = renderViewTree(dom.append(this.container, $('.quick-watch-tree')));
		const expressionRenderer = this.instantiationService.createInstance(DebugExpressionRenderer);
		this.tree = this._register(this.instantiationService.createInstance(WorkbenchAsyncDataTree<IQuickWatchTreeInput, IExpression, FuzzyScore>, 'QuickWatch', this.treeContainer, {
			getHeight: () => 22,
			getTemplateId: element => element instanceof VisualizedExpression ? VisualizedVariableRenderer.ID : element instanceof Variable ? VariablesRenderer.ID : 'quickWatchExpression'
		}, [
			this.instantiationService.createInstance(QuickWatchExpressionRenderer, expressionRenderer),
			this.instantiationService.createInstance(VariablesRenderer, expressionRenderer),
			this.instantiationService.createInstance(VisualizedVariableRenderer, expressionRenderer),
		], this.instantiationService.createInstance(QuickWatchDataSource), {
			accessibilityProvider: new QuickWatchAccessibilityProvider(),
			identityProvider: { getId: element => element.getId() },
			keyboardNavigationLabelProvider: expressionAndScopeLabelProvider,
			renderIndentGuides: RenderIndentGuides.None,
			overrideStyles: { listBackground: undefined }
		}));

		this.tree.setInput(this.treeInput);
		this.registerListeners();
		this.updateActionBar();
		this.renderState();
	}

	private registerListeners(): void {
		this._register(dom.addStandardDisposableListener(this.expressionInput.inputElement, dom.EventType.KEY_DOWN, e => {
			if (e.equals(KeyCode.Enter)) {
				e.preventDefault();
				e.stopPropagation();
				void this.evaluate(this.expressionInput.value);
			}
		}));

		this._register(this.tree.onContextMenu(e => void this.onContextMenu(e)));
		this._register(this.tree.onMouseDblClick(e => this.onMouseDblClick(e)));
		this._register(this.debugService.getViewModel().onDidFocusStackFrame(() => {
			if (this.currentExpression) {
				void this.evaluate(this.currentExpression.name);
			}
		}));
		this._register(this.debugService.getViewModel().onWillUpdateViews(() => {
			if (this.currentExpression) {
				void this.evaluate(this.currentExpression.name);
			}
		}));
		this._register(this.debugService.getViewModel().onDidEvaluateLazyExpression(async e => {
			if (e instanceof Variable && this.tree.hasNode(e)) {
				await this.tree.updateChildren(e, false, true);
				await this.tree.expand(e);
			}
		}));
		this._register(VisualizedVariableRenderer.rendererOnVisualizationRange(this.debugService.getViewModel(), this.tree));
	}

	override async setInput(input: QuickWatchEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (input.expression) {
			this.expressionInput.value = input.expression;
			await this.evaluate(input.expression);
		} else {
			this.expressionInput.value = this.expressionInput.value || '';
			this.renderState();
		}
	}

	override clearInput(): void {
		super.clearInput();
		this.currentExpression = undefined;
		this.currentResult = undefined;
		this.treeInput.expression = undefined;
		this.expressionInput.value = '';
		this.renderState();
	}

	override focus(): void {
		this.expressionInput.focus();
	}

	override layout(dimension: dom.Dimension): void {
		this.container.style.height = `${dimension.height}px`;
		this.container.style.width = `${dimension.width}px`;
		this.tree.layout(this.treeContainer.offsetHeight, this.treeContainer.offsetWidth);
	}

	async setExpression(expression: string | undefined): Promise<void> {
		if (typeof expression === 'string') {
			this.expressionInput.value = expression;
		}

		if (expression) {
			await this.evaluate(expression);
		} else {
			this.renderState();
		}
	}

	private async evaluate(expressionText: string): Promise<void> {
		const expression = expressionText.trim();
		if (!expression) {
			this.currentExpression = undefined;
			this.currentResult = undefined;
			this.treeInput.expression = undefined;
			this.renderState();
			return;
		}

		const modelExpression = new Expression(expression);
		this.currentExpression = modelExpression;
		this.currentResult = await evaluateQuickWatchExpression(modelExpression, this.debugService.getViewModel().focusedSession, this.debugService.getViewModel().focusedStackFrame);
		this.treeInput.expression = this.currentResult.fullStringValue ? undefined : modelExpression;
		await this.tree.updateChildren();
		if (this.treeInput.expression) {
			await this.tree.expand(modelExpression);
			this.tree.setFocus([modelExpression]);
		}
		this.renderState();
	}

	private renderState(): void {
		const result = this.currentResult;
		const hasTree = !!this.treeInput.expression;
		const fullStringValue = result?.fullStringValue;

		this.messageElement.textContent = result?.message ?? (!this.currentExpression && !this.expressionInput.value.trim() ? localize('quickWatchPrompt', "Enter an expression to inspect.") : '');
		this.messageElement.classList.toggle('hidden', !this.messageElement.textContent);

		this.stringValue.value = fullStringValue ?? '';
		this.stringContainer.classList.toggle('hidden', !fullStringValue);
		this.treeContainer.parentElement?.classList.toggle('hidden', !hasTree);
		if (hasTree) {
			this.tree.layout(this.treeContainer.offsetHeight, this.treeContainer.offsetWidth);
		}

		this.updateActionBar();
	}

	private updateActionBar(): void {
		const hasExpression = !!this.expressionInput.value.trim();
		this.actionBar.clear();
		this.actionBar.push([
			toAction({
				id: 'debug.quickWatch.reevaluateInline',
				label: localize('quickWatchReevaluate', "Reevaluate"),
				class: ThemeIcon.asClassName(Codicon.refresh),
				enabled: hasExpression,
				run: () => this.evaluate(this.expressionInput.value)
			}),
			toAction({
				id: 'debug.quickWatch.addToWatchInline',
				label: localize('quickWatchAddToWatch', "Add to Watch"),
				class: ThemeIcon.asClassName(Codicon.add),
				enabled: hasExpression,
				run: () => {
					if (this.expressionInput.value.trim()) {
						this.debugService.addWatchExpression(this.expressionInput.value.trim());
					}
				}
			}),
			toAction({
				id: 'debug.quickWatch.copyValueInline',
				label: localize('quickWatchCopyValue', "Copy Value"),
				class: ThemeIcon.asClassName(Codicon.copy),
				enabled: !!this.currentExpression,
				run: () => this.currentExpression ? this.commandService.executeCommand(COPY_VALUE_ID, this.currentExpression) : undefined
			})
		], { icon: true, label: false });
	}

	private onMouseDblClick(e: ITreeMouseEvent<IExpression>): void {
		if ((e.browserEvent.target as HTMLElement).className.indexOf('twistie') >= 0 || !e.element) {
			return;
		}

		if (e.element instanceof Expression || e.element instanceof Variable || (e.element instanceof VisualizedExpression && e.element.treeItem.canEdit)) {
			this.debugService.getViewModel().setSelectedExpression(e.element, false);
			this.tree.rerender(e.element);
		}
	}

	private async onContextMenu(e: ITreeContextMenuEvent<IExpression>): Promise<void> {
		if (!e.element) {
			return;
		}

		if (e.element instanceof Variable) {
			await openContextMenuForVariableTreeElement(this.tree.contextKeyService, this.menuService, this.contextMenuService, MenuId.DebugVariablesContext, e);
			return;
		}

		const contextKeyService = await getContextForWatchExpressionMenuWithDataAccess(this.tree.contextKeyService, e.element, this.debugService, this.logService);
		const menu = this.menuService.getMenuActions(QUICK_WATCH_CONTEXT_MENU, contextKeyService, { arg: e.element, shouldForwardArgs: false });
		const actions = getFlatContextMenuActions(menu);
		this.contextMenuService.showContextMenu({
			getAnchor: () => e.anchor,
			getActions: () => actions
		});
	}
}

registerAction2(class QuickWatchAction extends Action2 {
	constructor() {
		super({
			id: 'debug.quickWatch',
			title: { value: localize('quickWatchCommand', "Quick Watch"), original: 'Quick Watch' },
			category: localize('debugCategory', "Debug")
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const languageFeaturesService = accessor.get(ILanguageFeaturesService);
		const debugService = accessor.get(IDebugService);
		const initialExpression = await getQuickWatchExpression(editorService, languageFeaturesService) ?? debugService.getViewModel().getSelectedExpression()?.expression.name;
		const input = QuickWatchEditorInput.instance;
		input.expression = initialExpression;

		const editorPane = await editorService.openEditor(input, { pinned: true, revealIfOpened: true }, SIDE_GROUP);
		if (editorPane instanceof QuickWatchEditor) {
			await editorPane.setExpression(initialExpression);
			editorPane.focus();
		}
	}
});

async function getQuickWatchExpression(editorService: IEditorService, languageFeaturesService: ILanguageFeaturesService): Promise<string | undefined> {
	const control = editorService.activeTextEditorControl;
	if (!isCodeEditor(control) || !control.hasModel()) {
		return undefined;
	}

	const model = control.getModel();
	const selection = control.getSelection();
	if (!selection) {
		return undefined;
	}

	if (!selection.isEmpty()) {
		return model.getValueInRange(selection);
	}

	const position = control.getPosition();
	if (!position) {
		return undefined;
	}

	const evaluatableExpression = await getEvaluatableExpressionAtPosition(languageFeaturesService, model, position);
	return evaluatableExpression?.matchingExpression;
}
