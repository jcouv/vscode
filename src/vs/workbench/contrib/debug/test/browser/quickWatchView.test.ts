/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Expression, StackFrame, Thread } from '../../common/debugModel.js';
import { evaluateQuickWatchExpression } from '../../browser/quickWatchView.js';
import { MockSession } from '../common/mockDebug.js';

class TestQuickWatchSession extends MockSession {
	override capabilities = {
		supportsClipboardContext: true
	} satisfies Partial<DebugProtocol.Capabilities>;

	override async evaluate(expression: string, frameId: number, context?: string): Promise<DebugProtocol.EvaluateResponse> {
		assert.strictEqual(expression, 'foo');
		assert.strictEqual(frameId, 1);
		if (context === 'watch') {
			return {
				body: {
					result: '"truncated"',
					variablesReference: 0,
					type: 'string'
				}
			} as DebugProtocol.EvaluateResponse;
		}

		if (context === 'clipboard') {
			return {
				body: {
					result: '"full string value"',
					variablesReference: 0,
					type: 'string'
				}
			} as DebugProtocol.EvaluateResponse;
		}

		throw new Error(`Unexpected context ${context}`);
	}
}

function createStackFrame(session: MockSession): StackFrame {
	const thread = new Thread(session, 'mockthread', 1);
	return new StackFrame(thread, 1, null!, 'app.js', 'normal', {
		startLineNumber: 1,
		startColumn: 1,
		endLineNumber: undefined!,
		endColumn: undefined!
	}, 0, true);
}

suite('Debug - Quick Watch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses clipboard context for string values', async () => {
		const session = new TestQuickWatchSession();
		const expression = new Expression('foo');

		const result = await evaluateQuickWatchExpression(expression, session, createStackFrame(session));

		assert.strictEqual(result.expression.value, '"truncated"');
		assert.strictEqual(result.fullStringValue, '"full string value"');
		assert.strictEqual(result.message, undefined);
	});

	test('reports when there is no paused frame', async () => {
		const expression = new Expression('foo');

		const result = await evaluateQuickWatchExpression(expression, undefined, undefined);

		assert.strictEqual(result.expression.available, false);
		assert.strictEqual(result.expression.value, 'Pause the debugger to evaluate expressions.');
	});

	test('keeps the normal watch value if clipboard evaluation fails', async () => {
		class ClipboardFailureSession extends TestQuickWatchSession {
			override async evaluate(expression: string, frameId: number, context?: string): Promise<DebugProtocol.EvaluateResponse> {
				if (context === 'clipboard') {
					throw new Error('clipboard failed');
				}

				return super.evaluate(expression, frameId, context);
			}
		}

		const session = new ClipboardFailureSession();
		const expression = new Expression('foo');

		const result = await evaluateQuickWatchExpression(expression, session, createStackFrame(session));

		assert.strictEqual(result.expression.value, '"truncated"');
		assert.strictEqual(result.fullStringValue, undefined);
		assert.strictEqual(result.message, 'clipboard failed');
	});
});
