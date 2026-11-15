/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { parentPort, workerData } = require('node:worker_threads');
const { Database, cell } = require('./database.cjs');
const db = new Database(workerData.config, workerData.password);
const ready = db.connect();
let queue = Promise.resolve();
parentPort.on('message', message => {
	queue = queue.then(async () => {
		try {
			await ready; let value;
			if (message.method === 'test') { await db.query('SELECT 1'); value = true; }
			else if (message.method === 'tables') { value = await db.tables(); }
			else if (message.method === 'page') { value = await db.page(message.table, message.offset, message.view); }
			else if (message.method === 'change') { await db.change(message.changes); value = true; }
			else if (message.method === 'query') { const start = Date.now(); value = { results: (await db.query(message.sql)).map(r => ({ ...r, rows: r.rows.map(row => row.map(cell)) })), elapsed: Date.now() - start }; }
			else { throw Error('Unknown database operation'); }
			parentPort.postMessage({ id: message.id, value });
		} catch (error) { parentPort.postMessage({ id: message.id, error: error.message }); }
	});
});
ready.catch(() => {});
