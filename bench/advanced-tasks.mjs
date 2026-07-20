/** Cross-surface tasks used by the evidence suite. Each criterion declares its grader kind. */

const STRICT = "Работай строго в текущем репозитории и доведи задачу до проверяемого результата. ";
const packageJson = JSON.stringify({
	name: "pi-harness-advanced-fixture",
	private: true,
	type: "commonjs",
	scripts: { test: "node --test test/*.test.js", build: "node --check src/*.js" },
}, null, 2) + "\n";
const visionOutcomeCommand = "node -e \"const w=require('./workflow.json');const nodes=[...(Array.isArray(w.nodes)?w.nodes:[]),...(Array.isArray(w.lanes)?w.lanes.flatMap(l=>Array.isArray(l.nodes)?l.nodes:[]):[])];const ids=new Set(nodes.map(x=>String(x.id||x).toLowerCase()));if(![...ids].some(x=>x.includes('plan'))||![...ids].some(x=>x.includes('build'))||![...ids].some(x=>x.includes('test'))||![...ids].some(x=>x.includes('review'))||![...ids].some(x=>x.includes('ship'))||!Array.isArray(w.lanes)||w.lanes.length<3)process.exit(1)\"";
const visionLoopCommand = "node -e \"const w=require('./workflow.json');if(!Array.isArray(w.edges)||!w.edges.some(e=>/fail/i.test(String(e.on||e.condition||e.label))&&/test/i.test(String(e.from))&&/build/i.test(String(e.to))))process.exit(1)\"";
const rewindEvidenceScript = `
const assert=require('node:assert/strict');
const {rewind,returnBranch}=require('../src/session');
const base={sessionId:'s1',leafId:'l3',messages:[{id:'u1',role:'user',text:'one',attachments:[]},{id:'a1',role:'assistant',text:'ok'},{id:'u2',role:'user',text:'two',attachments:[{name:'x.png',data:'abc'}]},{id:'a2',role:'assistant',text:'done'}],branches:[],composer:{text:'draft',attachments:[]}};
const snapshot=structuredClone(base);
assert.throws(()=>rewind(base,'missing'),'unknown target must be rejected');
assert.throws(()=>rewind(base,'a1'),'rewind target must be a user message');
const next=rewind(base,'u2');
assert.notEqual(next,base);
assert.equal(next.sessionId,base.sessionId,'rewind must stay in the same session');
assert.notEqual(next.leafId,base.leafId,'rewind must create a new active leaf inside the session');
assert.deepEqual(next.messages,base.messages.slice(0,2));
assert.deepEqual(next.preview,{removedTurns:1,attachmentCount:1});
assert.deepEqual(next.composer,{text:'two',attachments:[{name:'x.png',data:'abc'}]});
assert.ok(next.branches.some(branch=>branch.leafId==='l3'),'abandoned leaf must remain returnable');
assert.deepEqual(base,snapshot,'rewind mutated its input');
assert.throws(()=>returnBranch(next,'missing'),'unknown branch must be rejected');
const restored=returnBranch(next,'l3');
assert.equal(restored.sessionId,'s1');
assert.equal(restored.leafId,'l3','Return must restore branch identity, not only its messages');
assert.deepEqual(restored.messages,snapshot.messages);
assert.deepEqual(restored.composer,snapshot.composer);
next.messages[0].text='next-mutated';
next.composer.attachments[0].name='mutated';
next.branches[0].messages[1].text='branch-mutated';
restored.messages[0].text='mutated';
restored.branches[0].messages[0].text='return-branch-mutated';
assert.equal(base.messages[0].text,'one','active rewind messages alias the source state');
assert.equal(base.messages[2].attachments[0].name,'x.png','composer attachments alias the source state');
assert.equal(base.messages[1].text,'ok','saved branch messages alias the source state');
assert.equal(next.branches[0].messages[0].text,'one','returned branches alias the rewind state');
console.log(JSON.stringify({passed:true,sessionId:restored.sessionId,leafId:restored.leafId}));
`;
const rewindContractCommand = "node verify/rewind-contract.js";
const rewindVerifierManifest = JSON.stringify({
	version: 1,
	commands: [
		{ id: "test", label: "Unit tests", command: "npm test", required: true, timeoutMs: 300_000 },
		{ id: "rewind-contract", label: "Same-session branch identity and isolation", command: rewindContractCommand, required: true, timeoutMs: 60_000 },
		{ id: "build", label: "Syntax build", command: "npm run build", required: true, timeoutMs: 180_000 },
	],
	evaluator: { enabled: true, agent: "independent-evaluator" },
}, null, 2) + "\n";
const backgroundEvidenceScript = `const assert=require('node:assert/strict'),cp=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
function jsonlFiles(root){if(!fs.existsSync(root))return[];return fs.readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?jsonlFiles(path.join(root,e.name)):e.isFile()&&e.name.endsWith('.jsonl')?[path.join(root,e.name)]:[])}
const latest=new Map();
for(const file of jsonlFiles(path.join('.pi','agent','sessions'))){for(const line of fs.readFileSync(file,'utf8').split('\\n')){let e;try{e=JSON.parse(line)}catch{continue}if(e&&e.type==='custom'&&e.customType==='pi-app-background-record'&&e.data&&e.data.id&&e.data.type!=='independent-evaluator')latest.set(e.data.id,e.data)}}
const workers=[...latest.values()];
assert.equal(workers.length,2,'exactly two non-evaluator background workers must be recorded');
for(const worker of workers){assert.equal(worker.status,'completed',JSON.stringify(worker));assert.ok(worker.branch&&worker.baseSha&&worker.worktreePath,'worker must prove worktree isolation');assert.ok(Number.isFinite(worker.startedAt)&&Number.isFinite(worker.completedAt),'worker lifecycle timestamps missing');cp.execFileSync('git',['merge-base','--is-ancestor',worker.branch,'HEAD'],{stdio:'pipe'})}
assert.ok(Math.max(...workers.map(w=>w.startedAt))<Math.min(...workers.map(w=>w.completedAt)),'worker lifetimes did not overlap');
console.log(JSON.stringify({passed:true,workers:workers.map(w=>({id:w.id,branch:w.branch,baseSha:w.baseSha}))}));
`;
const backgroundVerifierManifest = JSON.stringify({
	version: 1,
	commands: [
		{ id: "test", label: "Unit tests", command: "npm test", required: true, timeoutMs: 300_000 },
		{ id: "background-evidence", label: "Parallel worktree integration evidence", command: "node verify/background-evidence.js", required: true, timeoutMs: 60_000 },
		{ id: "build", label: "Syntax build", command: "npm run build", required: true, timeoutMs: 180_000 },
	],
	evaluator: { enabled: true, agent: "independent-evaluator" },
}, null, 2) + "\n";

export const advancedTasks = [
	{
		id: "ui-session-rewind",
		category: "ui",
		prompt: STRICT +
			"Реализуй в существующем vanilla UI session rewind: перед отменой покажи preview числа удаляемых turn и вложений; после подтверждения верни текст и вложения в composer, сохрани sessionId, не создавай новую сессию и оставь abandoned leaf доступным для Return. Return обязан восстановить identity выбранного leaf, а не только его сообщения. Источник истины — SPEC.md. Запусти тесты.",
		files: {
			"package.json": packageJson,
			".pi/verifiers.json": rewindVerifierManifest,
			"SPEC.md": "# Rewind\n`rewind(state, messageId)` принимает только id существующего user message и возвращает новый state с тем же sessionId и новым active leaf внутри этой сессии; неизвестный id или не-user target отклоняется. В `preview` есть removedTurns и attachmentCount. Активная ветка обрезается перед выбранным user message, текст и deep-cloned attachments выбранного сообщения попадают в composer, old leaf вместе с identity/messages/composer добавляется в branches. Исходный объект и его вложенные значения не мутируются и не alias-ятся возвращённым изменяемым state. `returnBranch(state, leafId)` отклоняет неизвестный leaf и восстанавливает identity, messages и composer сохранённой ветки при неизменном sessionId.\n",
			"verify/rewind-contract.js": rewindEvidenceScript,
			"src/session.js": "function rewind() { throw new Error('TODO'); }\nfunction returnBranch() { throw new Error('TODO'); }\nmodule.exports={rewind,returnBranch};\n",
			"src/ui.js": "const {rewind,returnBranch}=require('./session');\nmodule.exports={rewind,returnBranch};\n",
			"test/session.test.js": "const test=require('node:test'),a=require('node:assert/strict');const {rewind,returnBranch}=require('../src/session');\nconst base={sessionId:'s1',leafId:'l3',messages:[{id:'u1',role:'user',text:'one',attachments:[]},{id:'a1',role:'assistant',text:'ok'},{id:'u2',role:'user',text:'two',attachments:[{name:'x.png',data:'abc'}]},{id:'a2',role:'assistant',text:'done'}],branches:[],composer:{text:'',attachments:[]}};\ntest('same-session rewind and return',()=>{const before=structuredClone(base);const r=rewind(base,'u2');a.equal(r.sessionId,'s1');a.notEqual(r.leafId,'l3');a.equal(r.preview.removedTurns,1);a.equal(r.preview.attachmentCount,1);a.equal(r.composer.text,'two');a.equal(r.composer.attachments.length,1);a.equal(r.branches.length,1);a.deepEqual(base,before);const restored=returnBranch(r,'l3');a.equal(restored.sessionId,'s1');a.equal(restored.leafId,'l3');a.deepEqual(restored.messages,before.messages)});\ntest('invalid targets are rejected',()=>{a.throws(()=>rewind(base,'missing'));a.throws(()=>rewind(base,'a1'));a.throws(()=>returnBranch(rewind(base,'u2'),'missing'))});\n",
		},
		criteria: [
			{ id: "outcome", kind: "outcome", command: "npm test" },
			{ id: "branch-identity-roundtrip", kind: "outcome", command: rewindContractCommand },
			{ id: "contract-integrity", kind: "static", command: "git diff --exit-code -- .pi/verifiers.json verify/rewind-contract.js SPEC.md" },
			{ id: "static-ui-contract", kind: "static", command: "grep -q 'function rewind' src/session.js && grep -q 'function returnBranch' src/session.js && ! grep -R 'newSession' src" },
		],
	},
	{
		id: "vision-workflow-extraction",
		category: "vision",
		prompt: STRICT +
			"Изучи приложенный скриншот workflow. Запиши в workflow.json декларативный DAG: минимум planner, build, test, engineer-review и ship; test failure возвращает к build; независимые sandboxes представлены массивом lanes не короче 3. Не угадывай скрытый текст — фиксируй только структурно видимые отношения.",
		imageFiles: ["/Users/litwein/Downloads/Screenshot_20260717_083442.jpg"],
		files: {},
		verifiers: [
			{ id: "vision-contract", label: "Visible workflow contract", command: visionOutcomeCommand },
			{ id: "loop-edge", label: "Test failure repair edge", command: visionLoopCommand },
		],
		criteria: [
			{ id: "vision-outcome", kind: "outcome", command: visionOutcomeCommand },
			{ id: "loop-edge", kind: "static", command: visionLoopCommand },
		],
	},
	{
		id: "background-worktree-merge",
		category: "background/worktree/merge",
		prompt: STRICT +
			"Реализуй независимо две части контракта: parser CSV и formatter отчёта. Это обязательная проверка orchestration: сам не реализуй src/parser.js или src/format.js. В одном assistant message запусти ровно два Agent tool calls с run_in_background=true и isolation=worktree: один агент получает только parser, второй только formatter. Их времена исполнения должны пересекаться. После уведомлений о завершении проверь реальные ветки и merge обе worktree-ветки в текущую main-ветку; простое копирование результата или повторная реализация в parent не засчитывается. Итоговая ветка должна содержать обе функции, чисто пройти все declared gates и не иметь conflict markers.",
		files: {
			"package.json": packageJson,
			".pi/verifiers.json": backgroundVerifierManifest,
			"verify/background-evidence.js": backgroundEvidenceScript,
			"src/parser.js": "module.exports={};\n",
			"src/format.js": "module.exports={};\n",
			"test/parser.test.js": "const test=require('node:test'),a=require('node:assert/strict');test('csv',()=>a.deepEqual(require('../src/parser').parseCsv('a,b\\n1,2'),[{a:'1',b:'2'}]));\n",
			"test/format.test.js": "const test=require('node:test'),a=require('node:assert/strict');test('report',()=>a.equal(require('../src/format').formatReport([{name:'x',count:2}]),'x: 2'));\n",
		},
		criteria: [
			{ id: "merged-outcome", kind: "outcome", command: "npm test" },
			{ id: "parallel-worktree-evidence", kind: "outcome", command: "node verify/background-evidence.js" },
			{ id: "merge-safety", kind: "static", command: "! grep -R -E '^(<<<<<<<|=======|>>>>>>>)' src test && git diff --check" },
		],
	},
	{
		id: "compaction-continuity",
		category: "compaction",
		prompt: STRICT +
			"Реализуй structured checkpoint/compaction API по CONTRACT.md. Смысл задачи, решения, изменённые файлы, gate evidence и next step должны пережить многократное compact/restore. Не сохраняй полный transcript. Запусти тесты.",
		files: {
			"package.json": packageJson,
			"CONTRACT.md": "# Context checkpoint\ncreateCheckpoint(state) возвращает JSON-safe объект version=1 с objective, decisions, changedFiles, gates, nextStep и compactionCount. compact(checkpoint, summary) возвращает новый checkpoint, увеличивает count, сохраняет структурные поля и добавляет только последние 5 summary. restore(text) валидирует обязательные поля и не мутирует parsed value.\n",
			"src/checkpoint.js": "function createCheckpoint(){throw new Error('TODO')}\nfunction compact(){throw new Error('TODO')}\nfunction restore(){throw new Error('TODO')}\nmodule.exports={createCheckpoint,compact,restore};\n",
			"test/checkpoint.test.js": "const test=require('node:test'),a=require('node:assert/strict');const c=require('../src/checkpoint');test('continuity',()=>{const s={objective:'ship',decisions:['D'],changedFiles:['a'],gates:[{id:'test',status:'passed'}],nextStep:'review'};let x=c.createCheckpoint(s);for(let i=0;i<8;i++)x=c.compact(x,'s'+i);const y=c.restore(JSON.stringify(x));a.equal(y.objective,'ship');a.equal(y.compactionCount,8);a.deepEqual(y.changedFiles,['a']);a.equal(y.summaries.length,5);a.equal(y.nextStep,'review')});\n",
		},
		criteria: [
			{ id: "continuity", kind: "outcome", command: "npm test" },
			{ id: "bounded-summary", kind: "static", command: "node -e \"const c=require('./src/checkpoint');let x=c.createCheckpoint({objective:'x',decisions:[],changedFiles:[],gates:[],nextStep:'n'});for(let i=0;i<100;i++)x=c.compact(x,'x'.repeat(100));if(JSON.stringify(x).length>2000)process.exit(1)\"" },
		],
	},
	{
		id: "security-path-command",
		category: "security",
		prompt: STRICT +
			"Исправь secure.js по SECURITY.md. Нужны безопасное чтение только внутри root и запуск разрешённых команд без shell-инъекции. Не ослабляй проверки ради видимого теста. Добавь/запусти тесты.",
		files: {
			"package.json": packageJson,
			"SECURITY.md": "# Security\nreadInside(root, relative) запрещает absolute paths, NUL, traversal и symlink escape после realpath; возвращает текст файла. runAllowed(name,args) разрешает только node --version и git --version, запускает executable с массивом args без shell, запрещает дополнительные args и возвращает stdout; ошибки отклоняются.\n",
			"src/secure.js": "const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');\nfunction readInside(root,relative){return fs.readFileSync(path.join(root,relative),'utf8')}\nfunction runAllowed(name,args=[]){return cp.execSync(name+' '+args.join(' '),{encoding:'utf8'})}\nmodule.exports={readInside,runAllowed};\n",
			"test/security.test.js": "const test=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const s=require('../src/secure');test('inside',()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'safe-'));fs.writeFileSync(path.join(d,'ok'),'yes');a.equal(s.readInside(d,'ok'),'yes');a.throws(()=>s.readInside(d,'../etc/passwd'))});test('allowlist',()=>{a.match(s.runAllowed('node',['--version']),/^v/);a.throws(()=>s.runAllowed('node',['--version;touch /tmp/pwned']))});\n",
		},
		criteria: [
			{ id: "visible-security", kind: "outcome", command: "npm test" },
			{ id: "traversal-symlink", kind: "security", command: "node - <<'NODE'\nconst fs=require('fs'),os=require('os'),path=require('path'),s=require('./src/secure');const root=fs.mkdtempSync(path.join(os.tmpdir(),'root-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'outside-'));fs.writeFileSync(path.join(outside,'secret'),'x');fs.symlinkSync(path.join(outside,'secret'),path.join(root,'link'));for(const p of ['/etc/passwd','../x','link','a\\0b']){let ok=false;try{s.readInside(root,p)}catch{ok=true}if(!ok)process.exit(1)}\nNODE" },
			{ id: "path-syntax-canonical-root", kind: "security", command: "node - <<'NODE'\nconst fs=require('fs'),os=require('os'),path=require('path'),s=require('./src/secure');const root=fs.mkdtempSync(path.join(os.tmpdir(),'root-'));fs.writeFileSync(path.join(root,'ok'),'ok');if(s.readInside(root,'ok')!=='ok')process.exit(1);for(const p of [path.join(root,'ok'),'sub/../ok']){let rejected=false;try{s.readInside(root,p)}catch{rejected=true}if(!rejected)process.exit(1)}\nNODE" },
			{ id: "no-shell-injection", kind: "security", command: "node -e \"const s=require('./src/secure');for(const x of ['sh','bash','node --version']){let ok=false;try{s.runAllowed(x,[])}catch{ok=true}if(!ok)process.exit(1)}\" && ! grep -E 'execSync|shell[[:space:]]*:[[:space:]]*true' src/secure.js" },
		],
	},
];
