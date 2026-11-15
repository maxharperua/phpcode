/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const api = acquireVsCodeApi();
const root = document.getElementById('app');
let localization = {};
function t(message, ...args) { return (localization[message] || message).replace(/\{(\d+)\}/g, (match, index) => index < args.length ? String(args[index]) : match); }
let state, busy = false;
let drafts = new Map(), inserts = [], deleted = new Set();
let searchDraft = '', searchColumnDraft = null, structureOpen = false, helpOpen = false;
function el(tag, text, className) { const value = document.createElement(tag); if (text !== undefined) { value.textContent = text; } if (className) { value.className = className; } return value; }
function button(label, action, secondary = false) { const value = el('button', label, secondary ? 'secondary' : ''); value.type = 'button'; value.addEventListener('click', action); return value; }
function iconButton(label, icon, action) { const value = button('', action, true); value.className = 'icon-button'; value.title = label; value.setAttribute('aria-label', label); const glyph = el('span', undefined, 'codicon codicon-' + icon); glyph.setAttribute('aria-hidden', 'true'); value.append(glyph); return value; }
function syncControls() { if (state?.kind !== 'table') { return; } for (const id of ['table-save', 'table-discard']) { const button = document.getElementById(id); if (button) { button.disabled = busy || !dirty(); } } const prev = document.getElementById('page-prev'), next = document.getElementById('page-next'); if (prev) { prev.disabled = busy || state.offset === 0; } if (next) { next.disabled = busy || !state.hasMore; } }
function send(type, args = {}) { api.postMessage({ type, ...args }); }
function notice(text, error = false) { const target = document.getElementById('notice'); if (target) { target.textContent = text || ''; target.title = text || ''; target.className = error ? 'notice error' : 'notice'; target.setAttribute('role', error ? 'alert' : 'status'); } }
function setBusy(value) { busy = value; for (const b of document.querySelectorAll('button:not(.cancel), .table-editor input, .table-editor select')) { b.disabled = value; } syncControls(); }
function heading(title, subtitle) { const header = el('header'); header.append(el('h1', title), el('p', subtitle, 'muted')); root.append(header); }
function bar() { const value = el('div', undefined, 'toolbar'); root.append(value); return value; }
function dirty() { return drafts.size || inserts.length || deleted.size; }
function updateDirty() { const text = document.getElementById('pending'); if (text) { text.textContent = dirty() ? t("Изменения: {0}", drafts.size + inserts.length + deleted.size) : ''; } syncControls(); }
function connection() {
	root.replaceChildren(); root.className = 'connection';
	heading(state.config.id ? t("Подключение к базе данных") : t("Новое подключение"), state.remote ? t("Сеть Dev Container / удалённой среды") : t("Сеть этого компьютера"));
	const form = el('form'); form.autocomplete = 'off'; const fields = {};
	function field(key, title, type = 'text') { const label = el('label', title); const input = el('input'); input.name = key; input.type = type; input.value = state.config[key] ?? ''; input.required = true; if (key === 'port') { input.min = '1'; input.max = '65535'; } fields[key] = input; label.append(input); form.append(label); }
	const engineLabel = el('label', t("Тип базы данных")); const engine = el('select'); engine.name = 'engine'; for (const [value, label] of [['mysql', 'MySQL / MariaDB'], ['postgres', 'PostgreSQL']]) { const option = el('option', label); option.value = value; engine.append(option); } engine.value = state.config.engine; engineLabel.append(engine); form.append(engineLabel);
	field('name', t("Название подключения")); field('host', t("Хост")); field('port', t("Порт"), 'number'); field('user', t("Пользователь")); field('database', t("Имя базы данных"));
	const passwordLabel = el('label', t("Пароль")); const password = el('input'); password.name = 'password'; password.type = 'password'; password.autocomplete = 'new-password'; password.placeholder = state.hasPassword ? t("Сохранён · оставьте пустым, чтобы не менять") : t("Пароль"); passwordLabel.append(password); form.append(passwordLabel);
	const clearLabel = el('label', undefined, 'check'); const clear = el('input'); clear.type = 'checkbox'; clear.name = 'clearPassword'; clearLabel.append(clear, el('span', t("Использовать пустой пароль"))); form.append(clearLabel);
	const tlsLabel = el('label', undefined, 'check'); const tls = el('input'); tls.type = 'checkbox'; tls.checked = state.config.tls; tls.name = 'tls'; tlsLabel.append(tls, el('span', t("TLS · проверять сертификат сервера"))); form.append(tlsLabel);
	engine.addEventListener('change', () => { fields.port.value = engine.value === 'mysql' ? '3306' : '5432'; });
	const controls = el('div', undefined, 'toolbar');
	const submit = type => { if (busy || !form.reportValidity()) { return; } const config = { engine: engine.value, tls: tls.checked }; for (const [key, input] of Object.entries(fields)) { config[key] = input.value; } setBusy(true); notice(type === 'test' ? t("Проверка соединения…") : t("Сохранение…")); send(type, { config, password: clear.checked ? '' : password.value || (state.hasPassword ? undefined : '') }); };
	controls.append(button(t("Проверить соединение"), () => submit('test'), true), button(t("Сохранить подключение"), () => submit('save'))); form.append(controls); form.addEventListener('submit', event => { event.preventDefault(); submit('save'); });
	root.append(form, el('p', t("Пароль хранится отдельно от настроек, в защищённом хранилище IDE."), 'muted'), Object.assign(el('div', '', 'notice'), { id: 'notice' }));
}
function table() {
	root.replaceChildren(); root.className = 'table-editor';
	const view = state.view || { search: '', searchColumn: null, sort: null };
	const request = (offset, nextView = view) => { if (busy) { return; } if (dirty()) { notice(t("Сначала сохраните или отмените изменения.")); return; } setBusy(true); notice(''); send('page', { offset, view: nextView }); };
	const controls = bar(); controls.classList.add('table-tools'); controls.setAttribute('role', 'toolbar'); controls.setAttribute('aria-label', t("Действия с таблицей"));
	const actions = el('div', undefined, 'table-actions'); controls.append(actions);
	const save = () => { if (busy || !dirty()) { return; } const changes = [...drafts.entries()].filter(([row]) => !deleted.has(row)).map(([row, values]) => ({ kind: 'update', row, values })); for (const row of deleted) { changes.push({ kind: 'delete', row }); } for (const values of inserts) { changes.push({ kind: 'insert', values }); } setBusy(true); notice(t("Сохранение изменений…")); send('apply', { changes }); };
	if (state.editable) {
		const saveButton = iconButton(t("Сохранить изменения"), 'save', save); saveButton.id = 'table-save';
		const discard = iconButton(t("Отменить изменения"), 'discard', () => { drafts.clear(); inserts = []; deleted.clear(); table(); }); discard.id = 'table-discard';
		actions.append(saveButton, discard, iconButton(t("Добавить строку"), 'add', () => { inserts.push({}); table(); }));
	}
	actions.append(iconButton(t("Обновить"), 'refresh', () => request(state.offset)), iconButton(t("Открыть SQL"), 'code', () => send('query')));
	const structure = iconButton(t("Структура таблицы"), 'table', () => { structureOpen = !structureOpen; document.getElementById('structure').hidden = !structureOpen; structure.setAttribute('aria-expanded', String(structureOpen)); structure.classList.toggle('active', structureOpen); }); structure.setAttribute('aria-expanded', String(structureOpen)); structure.classList.toggle('active', structureOpen); actions.append(structure);
	const search = el('form', undefined, 'table-search'); const column = el('select'); column.setAttribute('aria-label', t("Колонка поиска")); const all = el('option', t("Все колонки")); all.value = ''; column.append(all);
	state.columns.forEach((c, index) => { if (/blob|binary|bytea|geometry/i.test(c.type)) { return; } const option = el('option', c.name); option.value = String(index); column.append(option); }); column.value = searchColumnDraft === null ? '' : String(searchColumnDraft);
	const input = el('input'); input.type = 'text'; input.className = 'search-input'; input.placeholder = t("Поиск по таблице…"); input.setAttribute('aria-label', t("Поиск по таблице")); input.maxLength = 500; input.value = searchDraft; input.title = t("Поиск по всей таблице. Enter — найти; %, _ и кавычки ищутся как обычный текст."); input.addEventListener('input', () => { searchDraft = input.value; }); column.addEventListener('change', () => { searchColumnDraft = column.value === '' ? null : Number(column.value); });
	const searchView = () => ({ ...view, search: searchDraft, searchColumn: searchColumnDraft });
	search.append(column, input, iconButton(t("Найти"), 'search', () => request(0, searchView())), iconButton(t("Очистить поиск"), 'close', () => { searchDraft = ''; input.value = ''; request(0, searchView()); })); search.addEventListener('submit', event => { event.preventDefault(); request(0, searchView()); }); controls.append(search);
	const help = iconButton(t("Справка"), 'question', () => { helpOpen = !helpOpen; document.getElementById('table-help').hidden = !helpOpen; help.setAttribute('aria-expanded', String(helpOpen)); }); help.setAttribute('aria-expanded', String(helpOpen)); controls.append(help);
	const schema = el('div', undefined, 'structure'); schema.id = 'structure'; schema.hidden = !structureOpen; const schemaTable = el('table'); const schemaHead = el('tr'); for (const text of [t("Колонка"), t("Тип"), t("Ключ"), 'NULL', t("Генерируется")]) { schemaHead.append(el('th', text)); } schemaTable.append(schemaHead);
	for (const c of state.columns) { const row = el('tr'); for (const text of [c.name, c.type, c.primary ? 'PK' : '', c.nullable ? t("да") : t("нет"), c.generated ? t("да") : t("нет")]) { row.append(el('td', text)); } schemaTable.append(row); } schema.append(schemaTable); root.append(schema);
	const helpText = el('div', state.editable ? t("Измените ячейки и сохраните. NULL: Alt+Backspace или правый клик. Новая строка: незаполненные поля используют DEFAULT.") : t("Только просмотр: у таблицы нет первичного ключа либо это представление. Изменения доступны через SQL."), 'table-help muted'); helpText.id = 'table-help'; helpText.hidden = !helpOpen; root.append(helpText);
	const container = el('div', undefined, 'grid-scroll'); const grid = el('table', undefined, 'data-grid'); grid.setAttribute('aria-label', t("Данные таблицы")); const thead = el('thead'); const titles = el('tr'); titles.append(el('th', '#', 'row-number'));
	state.columns.forEach((c, index) => {
		const selected = view.sort?.column === index; const th = el('th'); th.setAttribute('aria-sort', selected ? view.sort.direction === 'asc' ? 'ascending' : 'descending' : 'none');
		const sort = button('', () => { const direction = !selected ? 'asc' : view.sort.direction === 'asc' ? 'desc' : null; request(0, { ...view, sort: direction ? { column: index, direction } : null }); }); sort.className = 'column-sort'; sort.title = t("{0} · {1}. Нажмите для сортировки.", c.name, c.type); sort.setAttribute('aria-label', t("Сортировать по {0}", c.name));
		if (c.primary) { const key = el('span', undefined, 'codicon codicon-key'); key.setAttribute('aria-hidden', 'true'); sort.append(key); } sort.append(el('span', c.name));
		const arrow = el('span', undefined, 'codicon codicon-' + (selected ? view.sort.direction === 'asc' ? 'arrow-up' : 'arrow-down' : 'arrow-swap')); arrow.classList.add('sort-indicator'); arrow.setAttribute('aria-hidden', 'true'); sort.append(arrow); th.append(sort); titles.append(th);
	}); thead.append(titles); grid.append(thead); const tbody = el('tbody');
	function row(cells, index, isNew) {
		const tr = el('tr', undefined, isNew ? 'inserted' : deleted.has(index) ? 'deleted' : ''); const number = el('td', undefined, 'row-number'); number.append(el('span', isNew ? '+' : String(state.offset + index + 1)));
		if (state.editable) { const remove = iconButton(isNew ? t("Убрать") : deleted.has(index) ? t("Вернуть") : t("Удалить"), deleted.has(index) ? 'discard' : 'trash', () => { if (isNew) { inserts.splice(index, 1); } else if (deleted.has(index)) { deleted.delete(index); } else { deleted.add(index); } table(); }); remove.classList.add('row-action'); number.append(remove); } tr.append(number);
		for (let col = 0; col < state.columns.length; col++) {
			const original = cells[col]; const metadata = state.columns[col]; const td = el('td'); const changed = isNew ? Object.hasOwn(inserts[index], col) : drafts.get(index) && Object.hasOwn(drafts.get(index), col); const val = changed ? (isNew ? inserts[index][col] : drafts.get(index)[col]) : original.kind === 'null' ? null : original.text;
			if (state.editable && !metadata.generated && ['text', 'null'].includes(original.kind) && !deleted.has(index)) {
				const input = el('input', undefined, changed ? 'cell changed' : 'cell'); input.value = val ?? ''; input.placeholder = isNew && !changed ? 'DEFAULT' : val === null ? 'NULL' : ''; input.setAttribute('aria-label', `${isNew ? t("Новая строка") : t("Строка ") + (index + 1)}, ${metadata.name}`);
				const change = value => { const values = isNew ? inserts[index] : drafts.get(index) || {}; if (!isNew) { drafts.set(index, values); } if (!isNew && value === (original.kind === 'null' ? null : original.text)) { delete values[col]; if (!Object.keys(values).length) { drafts.delete(index); } } else { values[col] = value; } input.classList.toggle('changed', Object.hasOwn(values, col)); input.placeholder = value === null ? 'NULL' : ''; updateDirty(); };
				input.addEventListener('input', () => change(input.value)); const setNull = event => { event.preventDefault(); input.value = ''; change(null); }; input.addEventListener('contextmenu', setNull); input.addEventListener('keydown', event => { if (event.altKey && event.key === 'Backspace') { setNull(event); } }); td.append(input);
			} else { td.append(el('span', original.kind === 'null' ? 'NULL' : original.kind === 'binary' ? '0x' + original.text : original.text, original.kind === 'null' ? 'muted' : '')); } tr.append(td);
		} tbody.append(tr);
	}
	state.rows.forEach((cells, i) => row(cells, i, false)); inserts.forEach((_, i) => row(state.columns.map(() => ({ text: '', kind: 'null' })), i, true)); grid.append(tbody); container.append(grid); root.append(container);
	const footer = bar(); footer.classList.add('table-status'); const prev = iconButton(t("← Назад"), 'chevron-left', () => request(Math.max(0, state.offset - 200))); prev.id = 'page-prev'; const next = iconButton(t("Далее →"), 'chevron-right', () => request(state.offset + 200)); next.id = 'page-next';
	const identity = el('span', state.title, 'table-identity muted'); identity.title = state.connection + ' · ' + state.title;
	footer.append(prev, el('span', `${state.offset + (state.rows.length ? 1 : 0)}–${state.offset + state.rows.length}`, 'row-range'), next, Object.assign(el('span', '', 'muted'), { id: 'pending' }), Object.assign(el('div', '', 'notice'), { id: 'notice' }), identity);
	if (!state.editable) { const lock = el('span', undefined, 'codicon codicon-lock'); lock.title = t("Только просмотр: у таблицы нет первичного ключа либо это представление. Изменения доступны через SQL."); lock.setAttribute('aria-label', lock.title); footer.append(lock); } updateDirty();
}
function results() {
	root.replaceChildren(); root.className = 'results'; const controls = bar(); controls.append(el('strong', state.title)); if (state.busy) { const stop = button(t("Остановить"), () => send('cancel'), true); stop.classList.add('cancel'); controls.append(stop); }
	controls.append(el('span', state.message || '', 'muted')); root.append(Object.assign(el('div', state.error || '', state.error ? 'notice error' : 'notice'), { id: 'notice' }));
	if (!state.results?.length) { return; }
	const tabs = bar(); const content = el('div', undefined, 'grid-scroll'); root.append(content);
	function show(index) {
		content.replaceChildren(); const result = state.results[index]; for (const [i, b] of [...tabs.children].entries()) { b.classList.toggle('selected', i === index); }
		content.append(el('p', t("{0} · строк: {1}{2}", result.command || 'SELECT', result.rowCount, result.truncated ? ' · показана ограниченная выборка (до 1000 строк / 4 МБ)' : ''), 'muted'));
		if (!result.columns.length) { return; } const table = el('table', undefined, 'data-grid'); const thead = el('thead'); const tr = el('tr'); for (const c of result.columns) { tr.append(el('th', c)); } thead.append(tr); table.append(thead); const tbody = el('tbody');
		for (const row of result.rows) { const tr = el('tr'); for (const cell of row) { tr.append(el('td', cell.kind === 'null' ? 'NULL' : cell.kind === 'binary' ? '0x' + cell.text : cell.text, cell.kind === 'null' ? 'muted' : '')); } tbody.append(tr); } table.append(tbody); content.append(table);
	}
	state.results.forEach((_, index) => tabs.append(button(t("Результат ") + (index + 1), () => show(index), true))); show(0);
}
window.addEventListener('message', event => {
	const message = event.data;
	if (message.localization) { localization = message.localization; }
	if (message.kind) { state = message; drafts.clear(); inserts = []; deleted.clear(); busy = !!state.busy; if (state.kind === 'connection') { connection(); } else if (state.kind === 'table') { searchDraft = state.view?.search || ''; searchColumnDraft = state.view?.searchColumn ?? null; table(); } else { results(); } return; }
	if (message.event === 'error') { notice(message.message, true); }
	else if (message.event === 'success') { notice(message.message); }
	else if (message.event === 'idle') { setBusy(false); }
});
send('ready');

window.addEventListener('keydown', event => { if (state?.kind === 'table' && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); document.querySelector('.search-input')?.focus(); } });
