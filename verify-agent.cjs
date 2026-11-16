const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const root = require('./scripts/lib.cjs').upstream;
const { _electron } = createRequire(path.join(root, 'package.json'))('playwright');
const fixture = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'phpcode-agent-'));
const profile = path.join(fixture, 'profile');
const project = path.join(fixture, 'project');
fs.mkdirSync(project); fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
const before = '<?php\nfunction greet($name) { return "Hello, $name"; }\n';
const after = '<?php\nfunction greet($name = "world") { return "Hello, $name"; }\n';
fs.writeFileSync(path.join(project, 'greet.php'), before);
fs.mkdirSync(path.join(project,'components'));
for(let index=0;index<24;index++){fs.writeFileSync(path.join(project,`components/Part${index}.php`),`<?php class Part${index} {}\n`+'// observed code\n'.repeat(600));}
fs.writeFileSync(path.join(project,'Paged.php'),Array.from({length:450},(_,index)=>`// line-${index+1}`).join('\n'));
fs.writeFileSync(path.join(project, '.env'), 'TEST_SECRET=must-not-be-read');
fs.mkdirSync(path.join(project,'services'));
fs.mkdirSync(path.join(project,'ignored'));
fs.writeFileSync(path.join(project,'services/PaymentProcessor.php'),'<?php\nclass PaymentProcessor { public function chargeCustomer(int $amount): int { return $amount; } }\n');
fs.writeFileSync(path.join(project,'.phpcodeignore'),'ignored/\n');
fs.writeFileSync(path.join(project,'ignored/Hidden.php'),'<?php class HiddenIndexSentinel {}');
fs.writeFileSync(path.join(fixture,'outside.php'),'<?php class OutsideSecretSentinel {}');
fs.symlinkSync(path.join(fixture,'outside.php'),path.join(project,'link.php'));
fs.writeFileSync(path.join(profile, 'User/settings.json'), JSON.stringify({ 'workbench.startupEditor': 'none', 'window.zoomLevel': 0, ...(process.env.PHPCODE_THEME_MIGRATION_SMOKE==='1' ? { 'workbench.colorTheme': 'phpcode Dracula', 'workbench.preferredDarkColorTheme': 'phpcode Dracula' } : {}) }));
let pagerCommand; let pagerMarker;
if(process.env.PHPCODE_TERMINAL_SMOKE==='1') {
 const {spawnSync}=require('node:child_process');
 const git=args=>{const result=spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:project,encoding:'utf8'});assert.equal(result.status,0,result.stderr);};
 git(['init','-q']);git(['-c','user.name=phpcode fixture','-c','user.email=fixture@example.invalid','commit','-q','--allow-empty','-m','PHPCODE_PAGER_REGRESSION']);
 const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
 pagerMarker=path.join(fixture,'pager-was-started');const pager=path.join(fixture,'interactive-pager.sh');
 fs.writeFileSync(pager,'#!/bin/sh\nprintf pager-started > '+quote(pagerMarker)+'\nsleep 5\n');fs.chmodSync(pager,0o700);
 pagerCommand='git -c core.pager='+quote(pager)+' --paginate log --oneline -n 1; printf "PAGER_ENV:%s|%s|%s\\n" "$GIT_PAGER" "$PAGER" "$GIT_TERMINAL_PROMPT"';
}
const packaged = process.env.PHPCODE_PACKAGED_EXECUTABLE;
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; if (!packaged) { env.VSCODE_DEV = '1'; }
const launchOptions = { executablePath: packaged || process.env.PHPCODE_DEV_EXECUTABLE || path.join(root, '.build/electron/phpcode.app/Contents/MacOS/phpcode'), args: [...(packaged ? [] : [root]), '--user-data-dir', profile, '--extensions-dir', path.join(fixture,'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', project], env, timeout: 60000 };
let application;
const checks = [];
(async () => {
 application = await _electron.launch(launchOptions);
 await application.firstWindow();
 // Replace only this test application's native HTTP dependency. No external request, key or credits are used.
 await application.evaluate(({ }, data) => {
  globalThis.__phpcodeTest = { summaries:0 };
  globalThis.fetch = async (input, init) => {
   const url = String(input);
   const isPolza=url.startsWith('https://polza.ai/api/v1/');
   if (!isPolza && !url.startsWith('https://openai.bothub.chat/v1/')) { throw new Error('Unexpected network request in agent test'); }
   if (new URL(url).pathname.endsWith('/models') && isPolza) {
    if(new Headers(init.headers).has('Authorization')) { throw new Error('Public Polza catalog received a credential'); }
    if(globalThis.__phpcodeTest.delayPolzaCatalog) { globalThis.__phpcodeTest.polzaCatalogPending=true; await new Promise(resolve=>setTimeout(resolve,600)); globalThis.__phpcodeTest.polzaCatalogPending=false; }
    return new Response(JSON.stringify({data:[{id:'anthropic/claude-polza-test',context_length:200000}]}),{status:200});
   }
   if (url.endsWith('/models')) { return new Response(JSON.stringify({ data: [{ id:'phpcode-test',context_length:128000 }, { id:'claude-phpcode-test',context_window:1000000 }] }), { status:200 }); }
   if(data.providerSmoke) {
    const expected=isPolza?'Bearer phpcode-polza-test-key':'Bearer phpcode-fake-test-key';
    if(new Headers(init.headers).get('Authorization')!==expected){throw new Error('Wrong provider credential');}
    globalThis.__phpcodeTest.polzaRequests=(globalThis.__phpcodeTest.polzaRequests||0)+(isPolza?1:0);
    globalThis.__phpcodeTest.bothubRequests=(globalThis.__phpcodeTest.bothubRequests||0)+(isPolza?0:1);
   }
   const request = JSON.parse(init.body);
   const systemContent=request.messages[0]?.content; const systemText=Array.isArray(systemContent)?systemContent.map(part=>part.text).join(''):systemContent||'';
   const summarizing=systemText.includes('PHPCODE_CONVERSATION_COMPACTION');
   const content = request.messages.filter(message => message.role === 'user').at(-1).content;
   const lastUser = Array.isArray(content) ? content.map(part=>part.text).join('') : content;
   (globalThis.__phpcodeTest.requests ||= []).push({lastUser,child:systemText.includes('PHPCODE_SUBAGENT')});
   if(request.stream_options?.include_usage !== true) { throw new Error('Usage reporting not requested'); }
   if((request.model === 'claude-phpcode-test' || request.model==='anthropic/claude-polza-test') && !summarizing) {
    const markers = request.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(part=>part.cache_control):[]);
    if(lastUser.includes('Кеш без меток') ? markers.length !== 0 : markers.length !== 2) { throw new Error('Incorrect Claude cache markers'); }
   }
   const toolMessages = request.messages.slice(request.messages.findLastIndex(message => message.role === 'user') + 1).filter(message => message.role === 'tool');
   let chunks;
   const text = (content, finish_reason) => ({ choices:[{ delta:{content},finish_reason }] });
   const call = (name,args,id) => ({ choices:[{ delta:{tool_calls:[{ index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)} }]},finish_reason:'tool_calls' }] });
   if (systemText.includes('PHPCODE_SUBAGENT')) {
    if(JSON.stringify(request.messages).includes('PARENT_HISTORY_SENTINEL')) { throw new Error('Parent history leaked into child'); }
    if(request.tools.some(tool=>tool.function.name==='run_subagent')) { throw new Error('Nested delegation exposed'); }
    globalThis.__phpcodeTest.children=(globalThis.__phpcodeTest.children||0)+(!toolMessages.length?1:0);
    await new Promise(resolve=>setTimeout(resolve,1000));
    if(lastUser.includes('CHILD_CANCEL')) {
     if(init.signal.aborted){throw new DOMException('Aborted','AbortError');}
     return new Response(new ReadableStream({start(controller){init.signal.addEventListener('abort',()=>controller.error(new Error('cancelled')),{once:true});}}),{status:200,headers:{'Content-Type':'text/event-stream'}});
    }
    if(lastUser.startsWith('CHILD_SHELL_')) {
     const letter=lastUser.endsWith('A')?'a':'b';
     chunks=toolMessages.length?[text('Команда: '+toolMessages.at(-1).content,'stop')]:[call('run_terminal',{command:'printf ran > subagent-'+letter+'.txt; printf subagent-'+letter},'child-command')];
    } else if(lastUser.startsWith('CHILD_WRITE_')) {
     const letter=lastUser.endsWith('A')?'a':'b';
     chunks=toolMessages.length===0?[call('read_file',{path:'greet.php'},'child-read')]:toolMessages.length===1?[call('propose_file',{path:'greet.php',content:'<?php echo "child-'+letter+'";\n'},'child-write')]:[text('Правка: '+toolMessages.at(-1).content,'stop')];
    } else { chunks=toolMessages.length?[text('Отчёт '+lastUser+' — greet.php изучен.','stop')]:[call('read_file',{path:'greet.php'},'child-read')]; }

   } else if (!summarizing && lastUser.includes('TERMINAL_PAGER_TEST')) {
    if(toolMessages.length) {
     if(!toolMessages.at(-1).content.startsWith('Exit: 0') || !toolMessages.at(-1).content.includes('PHPCODE_PAGER_REGRESSION') || !toolMessages.at(-1).content.includes('PAGER_ENV:cat|cat|0')){throw new Error('Pager-free terminal did not finish with expected output');}
     chunks=[text('Git завершён без пейджера.','stop')];
    } else {chunks=[call('run_terminal',{command:data.pagerCommand},'pager-command')];}
   } else if (!summarizing && lastUser.includes('POLZA_CHAT_TEST')) {
    if(!isPolza){throw new Error('Polza request routed elsewhere');}
    await new Promise(resolve=>setTimeout(resolve,500));
    chunks=toolMessages.length?[text('Ответ polza.ai: файл прочитан.','stop')]:[call('read_file',{path:'greet.php'},'polza-read')];
   } else if(!summarizing && lastUser.includes('POLZA_SUBAGENT_TEST')) {
    chunks=toolMessages.length?[text('Субагент polza.ai завершён.','stop')]:[call('run_subagent',{description:'Исследование polza.ai',prompt:'POLZA_CHILD_TEST',subagent_type:'explore'},'polza-child')];
   } else if(!summarizing && lastUser.includes('PROVIDER_BOTHUB_TEST')) {
    if(isPolza){throw new Error('BotHub request routed to Polza');}
    chunks=[text('Ответ BotHub: ключ сохранён отдельно.','stop')];
   } else if (!summarizing && lastUser.includes('Параллельные субагенты')) {
    await new Promise(resolve=>setTimeout(resolve,1000));
    chunks=toolMessages.length?[text('Субагенты завершили исследование.','stop')]:[{choices:[{delta:{tool_calls:[{index:0,id:'child-a',type:'function',function:{name:'run_subagent',arguments:JSON.stringify({description:'Исследование A',prompt:'CHILD_A',subagent_type:'explore'})}},{index:1,id:'child-b',type:'function',function:{name:'run_subagent',arguments:JSON.stringify({description:'Исследование B',prompt:'CHILD_B',subagent_type:'explore'})}}]},finish_reason:'tool_calls'}]}];
   } else if(!summarizing && (lastUser.includes('SUBAGENT_POLICY_TEST') || lastUser.includes('SUBAGENT_WRITE_TEST'))) {
    const writing=lastUser.includes('SUBAGENT_WRITE_TEST');
    if(writing && toolMessages.length===0) { chunks=[call('read_file',{path:'greet.php'},'parent-read')]; }
    else if(toolMessages.length===(writing?1:0)) {
     chunks=[{choices:[{delta:{tool_calls:['A','B'].map((letter,index)=>({index,id:'worker-'+letter,type:'function',function:{name:'run_subagent',arguments:JSON.stringify({description:(writing?'Правка ':'Команда ')+letter,prompt:'CHILD_'+(writing?'WRITE_':'SHELL_')+letter,subagent_type:writing?'general':'shell'})}}))},finish_reason:'tool_calls'}]}];
    } else if(writing && toolMessages.length===3) { chunks=[call('propose_file',{path:'greet.php',content:'<?php echo "stale-parent";\n'},'stale-parent')]; }
    else {
     if(writing && !toolMessages.at(-1).content.includes('subagent changed')) { throw new Error('Stale parent overwrite was not refused'); }
     chunks=[text(writing?'Конфликты субагентов обработаны.':'Подтверждения субагентов обработаны.','stop')];
    }
   } else if (!summarizing && lastUser.includes('Остановить субагентов')) {
    chunks=[call('run_subagent',{description:'Длительное исследование',prompt:'CHILD_CANCEL',subagent_type:'explore'},'child-cancel')];
   } else if (!summarizing && lastUser.includes('Останови')) {
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(text('Долгий ответ…'))+'\n\n')); init.signal.addEventListener('abort', () => controller.error(new Error('cancelled')),{once:true}); } }),{status:200,headers:{'Content-Type':'text/event-stream'}});
   } else if(summarizing) {
    globalThis.__phpcodeTest.summaries++;
    globalThis.__phpcodeTest.polzaSummaries=(globalThis.__phpcodeTest.polzaSummaries||0)+(isPolza?1:0);
    chunks=[text('Сводка: пользователь изучает PHP-проект; PaymentProcessor найден, изменения greet.php проверены. Правки выполняются согласно выбранному режиму, команды требуют подтверждения. Сохранять ограничения пользователя и проверять текущее содержимое файлов.','stop')];
   } else if(lastUser.includes('Длинная история')) {
    chunks=[text('OLDER_CONTEXT_MARKER '.repeat(1800),'stop')];
   } else if(lastUser.includes('Продолжи после суммаризации')) {
    if(JSON.stringify(request.messages).includes('OLDER_CONTEXT_MARKER')){throw new Error('Old history was not compacted');}
    chunks=[text('Продолжаю с сохранённой сводкой.','stop')];
   } else if(lastUser.includes('Компонент с суммаризацией')) {
    const stage=globalThis.__phpcodeTest.copyStage||0; globalThis.__phpcodeTest.copyStage=stage+1;
    chunks=stage<16?[call('read_file',{path:`components/Part${stage}.php`},`compact-part-${stage}`)]:stage===16?[call('propose_file',{path:'CompactedCopy.php',content:'<?php class CompactedCopy {}\n'},'compacted-copy')]:[text('Компонент создан после суммаризации в процессе работы.','stop')];
   } else if(lastUser.includes('Длинная реализация компонента')) {
    const stage=toolMessages.length;
    chunks=stage<24?[call('read_file',{path:`components/Part${stage}.php`},`part-${stage}`)]:stage===24?[call('propose_file',{path:'Copied.php',content:'<?php class Copied {}\n'},'copy')]:[text('Компонент создан после 24 шагов исследования.','stop')];
   } else if(lastUser.includes('Постраничное чтение')) {
    chunks=toolMessages.length===0?[call('read_file',{path:'Paged.php'},'page1')]:toolMessages.length===1?[call('read_file',{path:'Paged.php',start_line:'201',end_line:'400'},'page2')]:[text(toolMessages.at(-1).content.includes('line-400')?'Вторая страница прочитана.':'ERROR: missing second page','stop')];
   } else if(lastUser.includes('Авто правка')) {
    chunks=toolMessages.length?[text('Автоматическая правка применена.','stop')]:[call('propose_file',{path:'auto.php',content:lastUser.includes('существующий')?'<?php echo "auto-updated";\n':'<?php echo "auto";\n'},'auto-proposal')];
   } else if (lastUser.includes('Индекс')) {
    const symbol = lastUser.includes('черновик') ? 'liveUnsavedIdentifier' : lastUser.includes('возврат') ? 'refundCustomer' : 'chargeCustomer';
    if (!toolMessages.length) { chunks=[call('search_code',{query:symbol},'index-call')]; }
    else {
     if(!toolMessages.at(-1).content.includes('services/PaymentProcessor.php') || !toolMessages.at(-1).content.includes(symbol)) { throw new Error('Indexed retrieval failed'); }
     chunks=[text('Индекс нашёл '+symbol+'.','stop')];
    }
   } else if (lastUser.includes('Кеш')) {
    chunks = [text('Статистика кеша получена.','stop')];
   } else if (lastUser.includes('Полуавто команда')) {
    chunks=toolMessages.length?[text('Полуавтоматическая команда выполнена.','stop')]:[call('run_terminal',{command:'printf phpcode-semi-check > semi-ran.txt; printf phpcode-semi-check'},'semi-command')];
   } else if (lastUser.includes('Авто команды')) {
    if(!lastUser.includes('execute immediately without confirmation')){throw new Error('Automatic policy missing from the model context');}
    chunks=toolMessages.length===0?[call('run_terminal',{command:'printf phpcode-auto-one; printf phpcode-auto-err >&2; printf executed > auto-command.txt'},'auto-one')]:toolMessages.length===1?[call('run_terminal',{command:'printf phpcode-auto-two; exit 7'},'auto-two')]:[text('Две автоматические команды выполнены.','stop')];
   } else if(lastUser.includes('Долгая команда')) {
    chunks=toolMessages.length?[text('Долгая команда остановлена.','stop')]:[call('run_terminal',{command:'printf phpcode-stream-start; i=0; while [ "$i" -lt 100 ]; do printf .; sleep 0.02; i=$((i+1)); done; printf should-not-reach'},'long-command')];
   } else if (lastUser.includes('Терминал')) {
    chunks = toolMessages.length ? [text('Команда завершена.','stop')] : [call('run_terminal',{command:'printf phpcode-terminal-check'},'terminal-call')];
   } else if (lastUser.includes('Секрет')) {
    chunks = toolMessages.length ? [text('Доступ к секрету заблокирован.','stop')] : [call('read_file',{path:'.env'},'secret-call')];
   } else if (lastUser.includes('Ask')) {
    if ((request.tools||[]).some(tool => tool.function.name === 'propose_file' || tool.function.name === 'run_terminal')) { throw new Error('Ask exposes mutation tools'); }
    chunks = [text('Объяснение без изменений.','stop')];
   } else {
    chunks = toolMessages.length === 0 ? [text('Изучаю файл. '),call('read_file',{path:'greet.php'},'read-call')] : toolMessages.length === 1 ? [call('propose_file',{path:'greet.php',content:data.after},'propose-call')] : [text('Предложение готово. '),text('Проверьте diff и примените правку.','stop')];
   }
   const stream = new ReadableStream({ async start(controller) { for (const chunk of chunks) { controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(chunk)+'\n\n')); await new Promise(resolve=>setTimeout(resolve,80)); } controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:100,total_tokens:1100,prompt_tokens_details:{cached_tokens:900,cache_write_tokens:0}}})+'\n\n')); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); } });
   return new Response(stream,{status:200,headers:{'Content-Type':'text/event-stream'}});
  };
 }, { after, providerSmoke:process.env.PHPCODE_PROVIDER_SMOKE==='1', pagerCommand });
 const page = await application.firstWindow();
 page.on('pageerror',error=>console.error('Renderer error:',error.message));
 page.on('console',message=>{if(message.type()==='error'){console.error('Renderer console:',message.text());}});
 await page.locator('.monaco-workbench').waitFor({timeout:60000});
 await page.bringToFront();
 await page.keyboard.press('Meta+Shift+p');
 await page.locator('.quick-input-widget input').first().fill('>phpcode: Открыть Агента');
 await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'phpcode: Открыть Агента'}).first().click({timeout:15000});
 const panel = page.locator('.phpcode-agent');
 await panel.waitFor({state:'visible',timeout:30000});
 if(process.env.PHPCODE_THEME_SMOKE==='1') {
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.monaco-workbench')).getPropertyValue('--vscode-editor-background').trim()==='#0e1915');
  if(process.env.PHPCODE_THEME_MIGRATION_SMOKE==='1') {
   let settings;const deadline=Date.now()+5000;
   do {
    settings=JSON.parse(fs.readFileSync(path.join(profile,'User/settings.json'),'utf8'));
    if(settings['workbench.colorTheme']==='phpcode Marsh'&&settings['workbench.preferredDarkColorTheme']==='phpcode Marsh'){break;}
    await new Promise(resolve=>setTimeout(resolve,25));
   } while(Date.now()<deadline);
   assert.equal(settings['workbench.colorTheme'],'phpcode Marsh');assert.equal(settings['workbench.preferredDarkColorTheme'],'phpcode Marsh');
   checks.push('saved legacy Dracula theme and preferred dark theme migrate to Marsh');
  }
  assert.equal(await page.locator('.codicon-accounts-view-bar-icon:visible').count(),0,'Unused Accounts button is absent');
  await panel.getByRole('textbox',{name:'Сообщение агенту',exact:true}).focus();
  const focus=await panel.evaluate(element=>({
   outline:getComputedStyle(element.querySelector('textarea')).outlineStyle,
   border:getComputedStyle(element.querySelector('.phpcode-agent-composer')).borderColor
  }));
  assert.equal(focus.outline,'none','Textarea has no inner square focus frame');
  // Border transition may still be animating; assert the final keyboard-focus indicator.
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.phpcode-agent-composer')).borderColor==='rgb(131, 155, 104)');
  for(const width of [300,420,640]) {
   await panel.evaluate((element,width)=>{element.style.width=width+'px';element.style.maxWidth='none';},width);
   const layout=await panel.evaluate(element=>{
    const composer=element.querySelector('.phpcode-agent-composer').getBoundingClientRect();
    return {height:composer.height,fit:[...element.querySelector('.phpcode-agent-controls').children].every(child=>{const r=child.getBoundingClientRect();return r.left>=composer.left&&r.right<=composer.right;})};
   });
   assert.ok(layout.fit,`Composer controls fit at ${width}px`);assert.ok(layout.height<=130,'Composer stays compact');
  }
  await panel.evaluate(element=>{element.style.removeProperty('width');element.style.removeProperty('max-width');});
  fs.mkdirSync(path.join(__dirname,'release'),{recursive:true});
  await page.screenshot({path:path.join(__dirname,'release/phpcode-marsh-preview.png')});
  checks.push('Marsh theme is active by default; Accounts button absent; rounded composer keyboard focus; controls fit at 300/420/640px');
  await application.close();application=undefined;
  console.log(JSON.stringify({ok:true,checks,fixture,liveProviderTest:false},null,2));return;
 }
 await panel.locator('input[type=password]').fill('phpcode-fake-test-key');
 await panel.getByRole('button',{name:'Сохранить ключ',exact:true}).click();
 await panel.locator('.model-picker').click();
 await page.getByRole('option',{name:/^phpcode-test/}).waitFor({timeout:10000});
 await page.getByRole('option',{name:/^phpcode-test/}).click();
 checks.push('secure key setup and native model catalog');
 const prompt=panel.getByRole('textbox',{name:'Сообщение агенту',exact:true});
 if(process.env.PHPCODE_DESIGN_SMOKE==='1') {
  await prompt.fill('Измени greet.php');await prompt.press('Enter');
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
  const answer=panel.locator('.phpcode-agent-transcript > .phpcode-agent-entry.assistant').last();
  const footer=answer.locator('.phpcode-agent-message-footer');
  await footer.waitFor({state:'attached'});
  await panel.locator('.phpcode-agent-composer').hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.phpcode-agent-transcript > .assistant .phpcode-agent-message-footer')).opacity==='0');
  await answer.hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.phpcode-agent-transcript > .assistant .phpcode-agent-message-footer')).opacity==='1');
  const timestamp=await footer.locator('time').getAttribute('datetime');
  assert.ok(timestamp && Number.isFinite(Date.parse(timestamp)));
  assert.ok(Math.abs(Date.now()-Date.parse(timestamp))<60000,'Answer has its actual creation time');
  const previousClipboard=await application.evaluate(({clipboard})=>clipboard.readText());
  try {
   const copy=footer.getByRole('button',{name:'Копировать ответ',exact:true});
   assert.equal(await copy.textContent(),'');assert.equal(await copy.locator('.codicon-copy').count(),1);
   await copy.click();
      const expected='Предложение готово. Проверьте diff и примените правку.';
   const deadline=Date.now()+3000;let copied=false;
   while(Date.now()<deadline) {if(await application.evaluate(({clipboard})=>clipboard.readText())===expected){copied=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
   assert.ok(copied,'Native clipboard received exactly the answer text');
  } finally {await application.evaluate(({clipboard},value)=>clipboard.writeText(value),previousClipboard);}
  checks.push('answer copy icon copies only answer text; date/time show on hover and remain absent from copied text');
  await panel.locator('.phpcode-agent-change-fold > summary').click();
  const diff=panel.locator('.diff-change');
  assert.equal(await diff.textContent(),'');assert.equal(await diff.locator('.codicon-diff').count(),1);assert.equal(await diff.getAttribute('title'),'Diff');
  await diff.click();await page.locator('.monaco-diff-editor').first().waitFor({state:'visible'});
  await panel.locator('.apply-change').click();
  await panel.locator('.phpcode-agent-change[data-state=applied]').waitFor();
  const undo=panel.locator('.undo-change');
  assert.equal(await undo.textContent(),'');assert.equal(await undo.locator('.codicon-discard').count(),1);assert.equal(await undo.getAttribute('title'),'Отменить');
  await answer.hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.phpcode-agent-transcript > .assistant .phpcode-agent-message-footer')).opacity==='1');
  await panel.screenshot({path:path.join(__dirname,'release/phpcode-chat-design-preview.png')});
  await page.screenshot({path:path.join(__dirname,'release/phpcode-marsh-preview.png')});
  await undo.click();await panel.locator('.phpcode-agent-change[data-state=undone]').waitFor({state:'attached'});
  checks.push('icon-only Diff and Undo keep tooltips and native review/apply/undo behavior');
  await application.close();application=await _electron.launch(launchOptions);
  const reopened=await application.firstWindow();await reopened.locator('.monaco-workbench').waitFor({timeout:60000});
  await reopened.keyboard.press('Meta+Shift+p');await reopened.locator('.quick-input-widget input').first().fill('>phpcode: Открыть Агента');
  await reopened.locator('.quick-input-list .monaco-list-row').filter({hasText:'phpcode: Открыть Агента'}).first().click();
  const restored=reopened.locator('.phpcode-agent-transcript > .assistant').last();await restored.waitFor();
  assert.equal(await restored.locator('time').getAttribute('datetime'),timestamp,'Answer timestamp survives restart unchanged');
  checks.push('answer timestamp persists across application restart');
  await application.close();application=undefined;
  console.log(JSON.stringify({ok:true,checks,fixture,liveProviderTest:false},null,2));return;
 }
 if(process.env.PHPCODE_TERMINAL_SMOKE==='1') {
  await panel.locator('.phpcode-agent-mode').selectOption('agent-auto');
  await prompt.fill('TERMINAL_PAGER_TEST'); await prompt.press('Enter');
  await panel.locator('.assistant').filter({hasText:'Git завершён без пейджера.'}).waitFor({timeout:20000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor();
  assert.equal(fs.existsSync(pagerMarker),false,'Forced Git pager was never launched');
  const command=page.locator('.phpcode-agent-command[data-state=completed]');
  assert.match(await command.innerText(),/PHPCODE_PAGER_REGRESSION/);
  assert.match(await command.innerText(),/PAGER_ENV:cat\|cat\|0/);
  checks.push('forced Git pager disabled for hidden agent PTY; original exit code and full output return promptly');
  await application.close();application=undefined;
  console.log(JSON.stringify({ok:true,checks,fixture,liveProviderTest:false},null,2));return;
 }
 if(process.env.PHPCODE_PROVIDER_SMOKE==='1') {
  const select=panel.locator('.phpcode-agent-provider');
  const chooseProvider=async id=>{await select.selectOption(id);await panel.getByRole('button',{name:id==='polza'?'polza.ai':'BotHub',exact:true}).waitFor();};
  await panel.getByRole('button',{name:'BotHub',exact:true}).click();
  await chooseProvider('polza');
  assert.equal(await panel.locator('input[type=password]').inputValue(),'');
  assert.equal(await panel.locator('.model-picker').innerText(),'Выберите модель');
  await panel.locator('.model-picker').click();
  await page.getByRole('option',{name:/^anthropic\/claude-polza-test/}).click();
  await panel.getByLabel('API-ключ polza.ai',{exact:true}).fill('phpcode-polza-test-key');
  await panel.getByRole('button',{name:'Сохранить ключ',exact:true}).click();
  await prompt.fill('POLZA_CHAT_TEST'); await prompt.press('Enter');
  await panel.locator('.phpcode-agent-status[data-state=running]').waitFor();
  assert.equal(await select.isDisabled(),true,'Provider cannot change mid-turn');
  await panel.locator('.assistant').filter({hasText:'Ответ polza.ai: файл прочитан.'}).waitFor({timeout:30000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor();
  checks.push('Polza public chat catalog, context windows, streaming and file tools use a separate credential');
  await prompt.fill('POLZA_SUBAGENT_TEST'); await prompt.press('Enter');
  await panel.locator('.assistant').filter({hasText:'Субагент polza.ai завершён.'}).waitFor({timeout:30000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor();
  assert.equal(await panel.locator('.phpcode-agent-subagent[data-status=completed]').count(),1);
  checks.push('subagents inherit the selected Polza provider and Claude cache markers');
  await panel.locator('.context-budget').click(); await page.getByRole('option',{name:'8k',exact:true}).click();
  await prompt.fill('Длинная история'); await prompt.press('Enter');
  await panel.locator('.assistant').filter({hasText:'OLDER_CONTEXT_MARKER'}).waitFor({timeout:30000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor();
  await prompt.fill('Продолжи после суммаризации'); await prompt.press('Enter');
  await panel.locator('.assistant').filter({hasText:'Продолжаю с сохранённой сводкой'}).waitFor({timeout:30000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor();
  assert.ok(await application.evaluate(()=>globalThis.__phpcodeTest.polzaSummaries)>0);
  checks.push('automatic compaction also routes to Polza');
  await panel.getByRole('button',{name:'polza.ai',exact:true}).click();
  await application.evaluate(()=>{globalThis.__phpcodeTest.delayPolzaCatalog=true;});
  await panel.getByRole('button',{name:'Обновить модели',exact:true}).click();
  const deadline=Date.now()+10000;
  while(!await application.evaluate(()=>!!globalThis.__phpcodeTest.polzaCatalogPending)) {if(Date.now()>deadline){throw new Error('Catalog request did not start');} await new Promise(resolve=>setTimeout(resolve,20));}
  await chooseProvider('bothub');
  await new Promise(resolve=>setTimeout(resolve,800));
  assert.equal(await panel.locator('.model-picker').innerText(),'phpcode-test');
  await panel.locator('.model-picker').click();
  assert.equal(await page.getByRole('option',{name:/^anthropic\/claude-polza-test/}).count(),0);
  await page.keyboard.press('Escape');
  await prompt.fill('PROVIDER_BOTHUB_TEST'); await prompt.press('Enter');
  await panel.locator('.assistant').filter({hasText:'Ответ BotHub: ключ сохранён отдельно.'}).waitFor({timeout:30000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor();
  checks.push('switching restores provider-specific models and a delayed Polza catalog cannot replace BotHub models');
  await chooseProvider('polza');
  assert.equal(await panel.locator('.model-picker').innerText(),'anthropic/claude-polza-test');
  await panel.getByRole('button',{name:'Удалить ключ',exact:true}).click();
  const before=await application.evaluate(()=>globalThis.__phpcodeTest.polzaRequests);
  await prompt.fill('POLZA_CHAT_TEST no key'); await prompt.press('Enter');
  await panel.locator('.phpcode-agent-status[data-state=error]').waitFor({timeout:10000});
  assert.equal(await application.evaluate(()=>globalThis.__phpcodeTest.polzaRequests),before);
  await chooseProvider('bothub');
  await prompt.fill('PROVIDER_BOTHUB_TEST again'); await prompt.press('Enter');
  await panel.locator('.assistant').filter({hasText:'Ответ BotHub: ключ сохранён отдельно.'}).nth(1).waitFor({timeout:30000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor();
  checks.push('deleting the Polza key prevents requests without falling back to BotHub and leaves its key intact');
  await chooseProvider('polza');
  await page.screenshot({path:path.join(fixture,'providers.png')});
  await application.close(); application=await _electron.launch(launchOptions);
  const reopened=await application.firstWindow(); await reopened.locator('.monaco-workbench').waitFor({timeout:60000});
  await reopened.keyboard.press('Meta+Shift+p'); await reopened.locator('.quick-input-widget input').first().fill('>phpcode: Открыть Агента');
  await reopened.locator('.quick-input-list .monaco-list-row').filter({hasText:'phpcode: Открыть Агента'}).first().click();
  const restored=reopened.locator('.phpcode-agent');
  await restored.getByRole('button',{name:'polza.ai',exact:true}).waitFor();
  assert.equal(await restored.locator('.model-picker').innerText(),'anthropic/claude-polza-test');
  checks.push('provider and per-provider model selection survive restart');
  await application.close(); application=undefined;
  console.log(JSON.stringify({ok:true,checks,fixture,liveProviderTest:false},null,2)); return;
 }
 if(process.env.PHPCODE_SUBAGENT_SMOKE==='1') {
  await prompt.fill('Параллельные субагенты PARENT_HISTORY_SENTINEL'); await prompt.press('Enter');
  const process=panel.locator('details.phpcode-agent-processes').last();
  await process.locator(':scope > summary .phpcode-agent-spinner').waitFor({timeout:15000});
  assert.equal(await process.getAttribute('open'),null,'Processes initially collapsed while waiting for model');
  const elapsed=process.locator(':scope > summary .phpcode-agent-elapsed');
  await elapsed.waitFor();
  await process.locator(':scope > summary').click();
  await panel.locator('.phpcode-agent-subagent[data-status=running]').first().waitFor({timeout:15000});
  await page.waitForFunction(()=>document.querySelectorAll('.phpcode-agent-subagent[data-status=running]').length===2,undefined,{timeout:15000});
  const child=panel.locator('.phpcode-agent-subagent').first();
  assert.equal(await child.getAttribute('open'),null);
  await child.locator(':scope > summary').click();
  await page.waitForFunction(()=>document.querySelectorAll('.phpcode-agent-subagent .tool').length>=2,undefined,{timeout:15000});
  assert.notEqual(await child.getAttribute('open'),null,'Child disclosure remains open across streaming updates');
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
  assert.equal(await panel.locator('.phpcode-agent-subagent[data-status=completed]').count(),2);
  assert.equal(await panel.locator('.phpcode-agent-spinner').count(),0,'All busy indicators settle');
  assert.equal(await application.evaluate(()=>globalThis.__phpcodeTest.children),2);
  checks.push('isolated concurrent subagents with nested history and stable collapsed/open disclosures');
  await page.screenshot({path:path.join(fixture,'subagents-complete.png')});
  await panel.locator('.phpcode-agent-mode').selectOption('agent-semi');
  await prompt.fill('SUBAGENT_POLICY_TEST'); await prompt.press('Enter');
  const approval=panel.locator('.phpcode-agent-approval');
  await approval.locator('pre').waitFor({timeout:20000});
  const firstCommand=await approval.locator('pre').innerText();
  const declined=firstCommand.includes('subagent-a')?'a':'b'; const allowed=declined==='a'?'b':'a';
  assert.equal(fs.existsSync(path.join(project,'subagent-a.txt')),false);
  assert.equal(fs.existsSync(path.join(project,'subagent-b.txt')),false);
  assert.equal(await panel.locator('.phpcode-agent-status .phpcode-agent-spinner').count(),0,'Awaiting approval does not pretend to execute');
  await approval.getByRole('button',{name:'Отклонить',exact:true}).click();
  await approval.locator('pre').filter({hasText:'subagent-'+allowed}).waitFor({timeout:20000});
  await approval.getByRole('button',{name:'Разрешить',exact:true}).click();
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
  assert.equal(fs.existsSync(path.join(project,'subagent-'+declined+'.txt')),false);
  assert.equal(fs.readFileSync(path.join(project,'subagent-'+allowed+'.txt'),'utf8'),'ran');
  checks.push('parallel shell workers serialize approvals, respect decline and use the shared command journal');
  await prompt.fill('SUBAGENT_WRITE_TEST'); await prompt.press('Enter');
  await panel.locator('.phpcode-agent-status[data-state=running]').waitFor({timeout:10000});
  await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
  assert.match(fs.readFileSync(path.join(project,'greet.php'),'utf8'),/^<\?php echo "child-[ab]";\n$/);
  const transcript=await panel.locator('.phpcode-agent-transcript').textContent();
  assert.match(transcript,/File assigned to another agent/);
  checks.push('parallel edits refuse worker conflicts and stale parent overwrites');
  await prompt.fill('Остановить субагентов'); await prompt.press('Enter');
  await panel.locator('.phpcode-agent-subagent[data-status=running]').waitFor({timeout:15000,state:'attached'});
  await panel.getByRole('button',{name:'Остановить',exact:true}).click();
  await panel.locator('.phpcode-agent-status[data-state=cancelled]').waitFor({timeout:15000});
  assert.equal(await panel.locator('.phpcode-agent-subagent[data-status=cancelled]').count(),1);
  checks.push('parent stop cancels and settles child indicators');
  await application.close();
  application=await _electron.launch(launchOptions); const reopened=await application.firstWindow();
  await reopened.locator('.monaco-workbench').waitFor({timeout:60000});
  await reopened.keyboard.press('Meta+Shift+p');
  await reopened.locator('.quick-input-widget input').first().fill('>phpcode: Открыть Агента');
  await reopened.locator('.quick-input-list .monaco-list-row').filter({hasText:'phpcode: Открыть Агента'}).first().click();
  await reopened.locator('.phpcode-agent-subagent').first().waitFor({timeout:15000,state:'attached'});
  assert.equal(await reopened.locator('.phpcode-agent-subagent').count(),7);
  assert.equal(await reopened.locator('.phpcode-agent-subagent[data-status=running]').count(),0);
  checks.push('subagent history survives application restart without stuck busy indicators');
  await application.close(); application=undefined;
  console.log(JSON.stringify({ok:true,checks,fixture},null,2)); return;
 }
 await panel.locator('.phpcode-agent-composer').evaluate((element, uris)=>{const data=new DataTransfer();data.setData('ResourceURLs',JSON.stringify(uris));element.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));},[pathToFileURL(path.join(project,'greet.php')).href,pathToFileURL(path.join(project,'services')).href]);
 await panel.locator('.phpcode-agent-contexts').getByRole('button').filter({hasText:'greet.php'}).waitFor();
 await panel.locator('.phpcode-agent-contexts').getByRole('button').filter({hasText:'services'}).waitFor();
 checks.push('file and folder drag-and-drop context attachments');
 await panel.getByRole('button',{name:'Добавить контекст',exact:true}).click();
 await page.getByRole('option',{name:'Папка',exact:true}).click();
 await page.getByRole('option',{name:'services',exact:true}).click();
 checks.push('folder context can also be selected from the composer picker');
 await panel.locator('.index-status[data-phase=ready]').waitFor({timeout:30000});
 await prompt.fill('Индекс: найди обработку оплаты'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Индекс нашёл chargeCustomer'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 checks.push('local project index retrieves relevant bounded code snippets');
 const waitUntil = async predicate => { const deadline=Date.now()+20000; while(Date.now()<deadline) { try { if(predicate()){return;} }catch{} await new Promise(resolve=>setTimeout(resolve,100)); } throw new Error('Index state did not update'); };
 let cachePath;
 await waitUntil(()=>{const storage=path.join(profile,'User/workspaceStorage'); if(!fs.existsSync(storage)){return false;} const found=fs.readdirSync(storage,{recursive:true}).find(name=>name.endsWith('phpcode/code-index-v1.json')); if(found){cachePath=path.join(storage,found);return true;}return false;});
 const snapshot=()=>JSON.parse(fs.readFileSync(cachePath,'utf8')).index.files;
 assert.ok(snapshot().some(file=>file.path==='services/PaymentProcessor.php'));
 assert.ok(snapshot().every(file=>!file.path.startsWith('ignored/')&&file.path!=='.env'&&file.path!=='link.php'));
 assert.doesNotMatch(JSON.stringify(snapshot()),/must-not-be-read|OutsideSecretSentinel|HiddenIndexSentinel/);
 checks.push('persisted index excludes ignore rules, credentials and symlink escapes');
 const paymentFile=path.join(project,'services/PaymentProcessor.php');
 const savedPayment='<?php\nclass PaymentProcessor { public function refundCustomer(int $amount): int { return $amount; } }\n';
 fs.writeFileSync(paymentFile,savedPayment);
 await waitUntil(()=>snapshot().some(file=>file.path==='services/PaymentProcessor.php'&&file.content.includes('refundCustomer')));
 await prompt.fill('Индекс возврат'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Индекс нашёл refundCustomer'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 checks.push('saved file changes update persistent retrieval index');
 await page.keyboard.press('Meta+p');
 await page.locator('.quick-input-widget input').first().fill('services/PaymentProcessor.php');
 await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'PaymentProcessor.php'}).first().click();
 await page.locator('.monaco-editor .view-lines').first().click({position:{x:40,y:10}});
 await page.keyboard.press('Meta+a');
 await page.keyboard.insertText(savedPayment+'// liveUnsavedIdentifier\n');
 assert.equal(fs.readFileSync(paymentFile,'utf8'),savedPayment);
 await prompt.fill('Индекс черновик'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Индекс нашёл liveUnsavedIdentifier'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.doesNotMatch(JSON.stringify(snapshot()),/liveUnsavedIdentifier/);
 await page.locator('.monaco-editor .view-lines').first().click({position:{x:40,y:10}}); await page.keyboard.press('Meta+z');
 await waitUntil(()=>fs.readFileSync(paymentFile,'utf8')===savedPayment);
 checks.push('dirty editor text is searchable without persisting unsaved content');
 await panel.locator('.new-chat').click();
 await prompt.fill('Измени greet.php'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Предложение готово'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.match(await panel.textContent(),/Чтение файла/); assert.match(await panel.textContent(),/Подготовка правки/);
 assert.equal(fs.readFileSync(path.join(project,'greet.php'),'utf8'),before,'Proposal must not edit disk before Apply');
 checks.push('native streaming and multi-step file tools; proposal staged');
 assert.equal(await panel.locator('.phpcode-agent-processes').last().getAttribute('open'),null);
 await panel.locator('.phpcode-agent-processes').last().locator(':scope > summary').click();
 assert.match(await panel.innerText(),/Чтение файла/);
 await panel.locator('.phpcode-agent-processes').last().locator(':scope > summary').click();
 assert.equal(await panel.locator('.phpcode-agent-change-fold').getAttribute('open'),null);
 await panel.locator('.phpcode-agent-change-fold > summary').click();
 checks.push('processes and changed files collapsed by default');
 await panel.getByRole('button',{name:'Diff',exact:true}).click();
 await page.locator('.monaco-diff-editor').first().waitFor({state:'visible'});
 checks.push('native diff editor');
 await page.screenshot({path:path.join(__dirname,'release/phpcode-agent-preview.png')});
 const composerBox=await panel.locator('.phpcode-agent-composer').boundingBox();
 const changesBox=await panel.locator('.phpcode-agent-changes').boundingBox();
 if(composerBox&&changesBox){const y=Math.min(changesBox.y,composerBox.y);await page.screenshot({path:path.join(__dirname,'release/phpcode-agent-composer-preview.png'),clip:{x:composerBox.x,y,width:composerBox.width,height:composerBox.y+composerBox.height-y}});}
 await panel.getByRole('button',{name:'Применить',exact:true}).click();
 await panel.locator('.phpcode-agent-change[data-state=applied]').waitFor();
 const save = async () => { await page.keyboard.press('Meta+Shift+p'); await page.locator('.quick-input-widget input').first().fill('>File: Save All'); await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'File: Save All'}).first().waitFor(); await page.keyboard.press('Enter'); };
 await save();
 await page.waitForFunction(() => !document.querySelector('.tab.dirty'));
 assert.equal(fs.readFileSync(path.join(project,'greet.php'),'utf8'),after);
 await panel.locator('.undo-change').click(); await panel.locator('.phpcode-agent-change[data-state=undone]').waitFor({state:'attached'}); await save();
 await page.waitForTimeout(300); assert.equal(fs.readFileSync(path.join(project,'greet.php'),'utf8'),before);
 checks.push('apply and safe undo through editor');
 await panel.locator('.phpcode-agent-mode').selectOption('agent-semi');
 await prompt.fill('Авто правка'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Автоматическая правка применена'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.equal(fs.readFileSync(path.join(project,'auto.php'),'utf8'),'<?php echo "auto";\n');
 checks.push('automatic edit policy applies proposals without an Apply click');
 assert.match(await panel.locator('.context-budget').innerText(),/115\.2k.*Auto/);
 await prompt.fill('Длинная реализация компонента'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Компонент создан после 24 шагов'}).waitFor({timeout:60000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.equal(fs.readFileSync(path.join(project,'Copied.php'),'utf8'),'<?php class Copied {}\n');
 checks.push('provider context window automatically replaces legacy 32k budget; implementation completes after more than 20 steps');
 await prompt.fill('Постраничное чтение'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Вторая страница прочитана'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 checks.push('large files expose subsequent line ranges instead of repeating a truncated prefix');
 await prompt.fill('Авто правка существующий'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Автоматическая правка применена'}).nth(1).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.equal(fs.readFileSync(path.join(project,'auto.php'),'utf8'),'<?php echo "auto-updated";\n');
 checks.push('automatic changes to existing files are saved before subsequent terminal tools');
 await panel.locator('.phpcode-agent-change').filter({hasText:'auto.php'}).locator('.undo-change').click();
 await waitUntil(()=>fs.readFileSync(path.join(project,'auto.php'),'utf8')==='<?php echo "auto";\n');
 await panel.locator('.phpcode-agent-change').filter({hasText:'auto.php'}).locator('.undo-change').click();
 await waitUntil(()=>!fs.existsSync(path.join(project,'auto.php')));
 checks.push('successive automatic edits can be undone back through prior file versions');
 await panel.locator('.phpcode-agent-mode').selectOption('agent-manual');
 await prompt.fill('Терминал'); await prompt.press('Enter');
 await panel.locator('.phpcode-agent-approval').waitFor({state:'visible'});
 assert.equal(await page.locator('.terminal-wrapper .xterm').count(),0,'No terminal before approval');
 await panel.locator('.approve-command').click();
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.match(await panel.innerText(),/Команда завершена/);
 checks.push('manual mode waits for command approval and returns completion');
 const journal=page.locator('.phpcode-agent-console');
 await journal.locator('.phpcode-agent-command').filter({hasText:'printf phpcode-terminal-check'}).locator('.phpcode-agent-command-output').filter({hasText:'phpcode-terminal-check'}).waitFor({timeout:10000});
 assert.equal(await page.locator('.terminal-wrapper .xterm').count(),0,'Agent commands must not create visible terminal tabs');
 await panel.locator('.phpcode-agent-mode').selectOption('agent-semi');
 await prompt.fill('Полуавто команда'); await prompt.press('Enter');
 await panel.locator('.phpcode-agent-approval').waitFor({state:'visible'});
 assert.ok(!fs.existsSync(path.join(project,'semi-ran.txt')),'Semi mode still waits for confirmation');
 assert.equal(await journal.locator('.phpcode-agent-command').count(),1,'Unapproved command is not launched');
 await panel.locator('.approve-command').click();
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.equal(fs.readFileSync(path.join(project,'semi-ran.txt'),'utf8'),'phpcode-semi-check');
 checks.push('semi-automatic mode applies edits immediately but still confirms commands');
 await page.keyboard.press('Meta+Shift+p'); await page.locator('.quick-input-widget input').first().fill('>Terminal: Create New Terminal');
 await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'Terminal: Create New Terminal'}).first().click();
 await page.locator('.terminal-wrapper .xterm').first().waitFor({timeout:15000});
 const userTerminals=await page.locator('.terminal-wrapper .xterm').count();
 await panel.locator('.phpcode-agent-mode').selectOption('agent-auto');
 await prompt.fill('Авто команды'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Две автоматические команды выполнены'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.equal(fs.readFileSync(path.join(project,'auto-command.txt'),'utf8'),'executed');
 assert.ok(await panel.locator('.phpcode-agent-approval').evaluate(element=>element.hidden));
 const successful=journal.locator('.phpcode-agent-command').filter({hasText:'printf phpcode-auto-one'});
 await successful.locator('.phpcode-agent-command-status').filter({hasText:'код 0'}).waitFor({timeout:10000});
 assert.match(await successful.locator('.phpcode-agent-command-output').innerText(),/phpcode-auto-one.*phpcode-auto-err/s);
 const failed=journal.locator('.phpcode-agent-command').filter({hasText:'printf phpcode-auto-two'});
 await failed.locator('.phpcode-agent-command-status').filter({hasText:'код 7'}).waitFor({timeout:10000});
 assert.equal(await failed.getAttribute('data-state'),'failed');
 assert.equal(await journal.locator('.phpcode-agent-command').count(),4);
 await page.keyboard.press('Meta+Shift+p'); await page.locator('.quick-input-widget input').first().fill('>Terminal: Focus Terminal');
 await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'Terminal: Focus Terminal'}).first().click();
 await page.locator('.terminal-wrapper .xterm').first().waitFor({timeout:15000});
 assert.equal(await page.locator('.terminal-wrapper .xterm').count(),userTerminals,'Agent commands leave the user terminal count unchanged');
 await page.keyboard.press('Meta+Shift+p'); await page.locator('.quick-input-widget input').first().fill('>phpcode: Открыть Команды Агента');
 await page.locator('.quick-input-list .monaco-list-row').filter({hasText:'phpcode: Открыть Команды Агента'}).first().click();
 await failed.scrollIntoViewIfNeeded();
 checks.push('fully automatic commands run without approval; one bottom panel retains stdout, stderr and exit codes without new user terminals');
 await page.screenshot({path:path.join(__dirname,'release/phpcode-agent-console-preview.png')});
 await prompt.fill('Долгая команда'); await prompt.press('Enter');
 const live=journal.locator('.phpcode-agent-command').filter({hasText:'printf phpcode-stream-start'});
 await live.locator('.phpcode-agent-command-output').filter({hasText:'phpcode-stream-start'}).waitFor({timeout:15000});
 assert.equal(await live.getAttribute('data-state'),'running');
 await live.getByRole('button',{name:'Остановить',exact:true}).click();
 await panel.locator('.assistant').filter({hasText:'Долгая команда остановлена'}).waitFor({timeout:15000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:15000});
 await live.locator('.phpcode-agent-command-status').filter({hasText:'Остановлено'}).waitFor();
 assert.doesNotMatch(await live.locator('.phpcode-agent-command-output').innerText(),/should-not-reach/);
 checks.push('command output streams while running and the console can stop a command');
 await prompt.fill('Секрет'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Доступ к секрету заблокирован'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.doesNotMatch(await panel.innerText(),/must-not-be-read/); checks.push('credential context excluded');
 await panel.locator('.phpcode-agent-mode').selectOption('ask');
 await prompt.fill('Ask объясни'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Объяснение без изменений'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.match(await panel.innerText(),/Объяснение без изменений/); checks.push('Ask mode without mutation tools');
 await panel.locator('.model-picker').click();
 await page.getByRole('option',{name:/^claude-phpcode-test/}).click();
 await waitUntil(async()=>/983\.6k.*Auto/.test(await panel.locator('.context-budget').innerText()));
 await prompt.fill('Кеш с метками'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Статистика кеша получена'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-usage-details > summary').click();
 assert.match(await panel.locator('.phpcode-agent-usage').innerText(),/из кеша [0-9]/);
 await panel.locator('.phpcode-agent-usage-details > summary').click();
 checks.push('Claude cache markers and reported cache token counters');
 await panel.getByRole('button',{name:'BotHub',exact:true}).click();
 await panel.getByRole('checkbox',{name:'Кеш Claude (5 минут)',exact:true}).uncheck();
 await panel.getByRole('button',{name:'BotHub',exact:true}).click();
 await prompt.fill('Кеш без меток'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Статистика кеша получена'}).nth(1).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 checks.push('Claude explicit cache opt-out');
 await panel.getByRole('button',{name:'BotHub',exact:true}).click();
 await panel.getByRole('checkbox',{name:'Кеш Claude (5 минут)',exact:true}).check();
 await panel.getByRole('button',{name:'BotHub',exact:true}).click();
 await panel.locator('.context-budget').click();
 await page.getByRole('option',{name:'8k',exact:true}).click();
 await prompt.fill('Длинная история'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'OLDER_CONTEXT_MARKER'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 await prompt.fill('Продолжи после суммаризации'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Продолжаю с сохранённой сводкой'}).waitFor({timeout:30000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.ok(await application.evaluate(()=>globalThis.__phpcodeTest.summaries)>0);
 assert.match(await panel.textContent(),/Контекст суммирован/);
 assert.match(await panel.textContent(),/OLDER_CONTEXT_MARKER/,'Visible history remains available after compaction');
 checks.push('automatic model summarization before context budget with full visible history retained');
 const summariesBeforeCopy=await application.evaluate(()=>globalThis.__phpcodeTest.summaries);
 await panel.locator('.phpcode-agent-mode').selectOption('agent-semi');
 await prompt.fill('Компонент с суммаризацией'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Компонент создан после суммаризации в процессе работы'}).waitFor({timeout:60000});
 await panel.locator('.phpcode-agent-status[data-state=completed]').waitFor({timeout:30000});
 assert.equal(fs.readFileSync(path.join(project,'CompactedCopy.php'),'utf8'),'<?php class CompactedCopy {}\n');
 assert.ok(await application.evaluate(()=>globalThis.__phpcodeTest.summaries)>summariesBeforeCopy);
 checks.push('automatic compaction during an active multi-step task retains the original request and reaches saved implementation');
 await panel.locator('.phpcode-agent-mode').selectOption('ask');
 await prompt.fill('Останови'); await prompt.press('Enter');
 await panel.locator('.assistant').filter({hasText:'Долгий ответ'}).waitFor();
 await panel.getByRole('button',{name:'Остановить',exact:true}).click();
 await panel.locator('.phpcode-agent-status').filter({hasText:'Остановлено'}).waitFor(); checks.push('stop cancels native stream');
 await panel.locator('.new-chat').click();
 await panel.locator('.phpcode-agent-tab').filter({hasText:'Измени greet.php'}).locator('.close-chat').click();
 await panel.getByRole('button',{name:'История',exact:true}).click();
 await panel.locator('.phpcode-agent-history-item').filter({hasText:'Измени greet.php'}).getByRole('button').click();
 assert.match(await panel.innerText(),/Объяснение без изменений/); checks.push('closed chat restored with transcript');
 await application.close(); application=undefined;
 const statePath=path.join(path.dirname(path.dirname(cachePath)),'state.vscdb');
 const db=new DatabaseSync(statePath,{readOnly:true});
 const state=JSON.parse(db.prepare('SELECT value FROM ItemTable WHERE key=?').get('phpcode.agent.sessions.v1').value);
 db.close();
 const compacted=state.sessions.find(session=>session.id===state.activeId);
 assert.ok(compacted.compactions>0&&compacted.summary&&compacted.contextBudget===8000);
 assert.doesNotMatch(JSON.stringify(compacted.messages),/OLDER_CONTEXT_MARKER/);
 assert.match(JSON.stringify(compacted.entries),/OLDER_CONTEXT_MARKER/);
 checks.push('compressed provider context and full local history persist separately');
 state.sessions.push({...compacted,id:'legacy-semi',title:'Старый автоматический чат',closed:false,mode:'agent',applyMode:'auto',terminalMode:undefined,status:'completed'});
 compacted.contextBudget=32000; delete compacted.contextBudgetMode; delete compacted.errorCode;
 compacted.status='error'; compacted.entries.push({kind:'error',text:'Агент остановлен: step-limit. Проверьте соединение и доступность модели.'});
 const migrate=new DatabaseSync(statePath);
 migrate.prepare('UPDATE ItemTable SET value=? WHERE key=?').run(JSON.stringify(state),'phpcode.agent.sessions.v1'); migrate.close();
 application = await _electron.launch(launchOptions);
 const restoredPage = await application.firstWindow();
 await restoredPage.locator('.monaco-workbench').waitFor({timeout:60000});
 await restoredPage.bringToFront();
 await restoredPage.keyboard.press('Meta+Shift+p');
 await restoredPage.locator('.quick-input-widget input').first().fill('>phpcode: Открыть Агента');
 await restoredPage.locator('.quick-input-list .monaco-list-row').filter({hasText:'phpcode: Открыть Агента'}).first().click({timeout:15000});
 const restoredPanel = restoredPage.locator('.phpcode-agent');
 await restoredPanel.locator('.assistant').filter({hasText:'Объяснение без изменений'}).waitFor({timeout:30000});
 assert.equal(await restoredPanel.locator('.phpcode-agent-mode').inputValue(),'ask');
 assert.equal(await restoredPanel.locator('.model-picker').innerText(),'claude-phpcode-test');
 checks.push('sessions, transcript, mode and model restored after process restart');
 await restoredPage.keyboard.press('Meta+Shift+p');
 await restoredPage.locator('.quick-input-widget input').first().fill('>phpcode: Открыть Команды Агента');
 await restoredPage.locator('.quick-input-list .monaco-list-row').filter({hasText:'phpcode: Открыть Команды Агента'}).first().click({timeout:15000});
 const restoredJournal=restoredPage.locator('.phpcode-agent-console');
 await restoredJournal.locator('.phpcode-agent-command[data-state=cancelled]').waitFor({timeout:10000});
 assert.equal(await restoredJournal.locator('.phpcode-agent-command').count(),5);
 assert.match(await restoredJournal.innerText(),/phpcode-auto-err/);
 assert.match(await restoredJournal.innerText(),/код 7/);
 checks.push('shared command journal and outcomes restore after restart');
 await restoredPanel.locator('.continue-task').waitFor({timeout:10000});
 assert.match(await restoredPanel.locator('.context-budget').innerText(),/983\.6k.*Auto/);
 assert.match(await restoredPanel.innerText(),/старого лимита 20 шагов/);
 assert.doesNotMatch(await restoredPanel.innerText(),/Проверьте соединение и доступность модели/);
 checks.push('legacy 32k sessions migrate to model context and step-limit chats can continue with accurate diagnostics');
 await restoredPanel.locator('.phpcode-agent-tab').filter({hasText:'Старый автоматический чат'}).getByRole('button').first().click();
 await waitUntil(async()=>await restoredPanel.locator('.phpcode-agent-mode').inputValue()==='agent-semi');
 checks.push('legacy automatic-edit chats restore as semi-automatic without gaining command permissions');
 await application.close(); application=undefined;
 const result={ok:true,checks,fixture,liveProviderTest:false};
 fs.writeFileSync(path.join(__dirname,'agent-verification-result.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
})().catch(async error=>{console.error(error); if(application){ try{console.error('MOCK REQUESTS',JSON.stringify(await application.evaluate(()=>globalThis.__phpcodeTest?.requests?.slice(-12))));const page=await application.firstWindow(); await page.screenshot({path:path.join(__dirname,'release/phpcode-agent-failure.png')}); console.error((await page.locator('body').innerText()).slice(-8000));}catch{} await application.close();} process.exitCode=1;});
