/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { t, bundle } = require('./localization.cjs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
class Session {
	constructor(config, password) {
		this.pending = new Map(); this.sequence = 0; this.closed = false;
		this.worker = new Worker(path.join(__dirname, 'worker.cjs'), { workerData: { config, password, localization: bundle() }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
		this.worker.on('message', message => { const request = this.pending.get(message.id); if (!request) { return; } clearTimeout(request.timer); this.pending.delete(message.id); message.error ? request.reject(Error(message.error)) : request.resolve(message.value); });
		this.worker.on('error', () => this.dispose(t("Процесс подключения завершился с ошибкой. Подключитесь повторно.")));
		this.worker.on('exit', () => this.dispose(t("Соединение закрыто. Подключитесь повторно.")));
	}
	call(method, args = {}) {
		if (this.closed) { return Promise.reject(Error(t("Соединение закрыто. Обновите таблицу или повторите SQL-запрос."))); }
		return new Promise((resolve, reject) => { const id = ++this.sequence; const timer = setTimeout(() => this.dispose(t("Превышено время ожидания (65 с). Соединение закрыто; уже завершённые команды могли быть применены.")), 65000); this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, method, ...args }); });
	}
	dispose(reason = t("Операция остановлена. Соединение закрыто; уже завершённые команды могли быть применены.")) {
		if (this.closed) { return; } this.closed = true;
		for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error(reason)); } this.pending.clear(); void this.worker.terminate();
	}
}
module.exports = { Session };
