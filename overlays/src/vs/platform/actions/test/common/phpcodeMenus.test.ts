/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import product from '../../../product/common/product.js';
import { isIMenuItem, MenuId, MenuRegistry } from '../../common/actions.js';

suite('phpcode product menus', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('hides provider-only labels including translated titles and implicit palette commands', () => {
		const menu = MenuId.for('phpcode.test.branding');
		disposables.add(MenuRegistry.appendMenuItem(menu, { command: { id: 'phpcode.test.git', title: 'Git: Refresh' } }));
		disposables.add(MenuRegistry.appendMenuItem(menu, { command: { id: 'phpcode.test.vendor', title: { value: 'Translated title', original: 'Configure Copilot' } } }));
		disposables.add(MenuRegistry.addCommand({ id: 'phpcode.test.implicit', title: 'Copilot: Sign In' }));
		const items = MenuRegistry.getMenuItems(menu).filter(isIMenuItem).map(item => item.command.id);
		const implicitVisible = MenuRegistry.getMenuItems(MenuId.CommandPalette).some(item => isIMenuItem(item) && item.command.id === 'phpcode.test.implicit');
		assert.deepStrictEqual({ items, implicitVisible }, product.enableBuiltinCopilot === false
			? { items: ['phpcode.test.git'], implicitVisible: false }
			: { items: ['phpcode.test.git', 'phpcode.test.vendor'], implicitVisible: true });
	});
});
