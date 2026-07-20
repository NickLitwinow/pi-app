/**
 * Long-horizon fixtures for harness A/B runs. Grading is outcome-based and
 * deliberately includes checks the executor prompt does not enumerate.
 */

const STRICT =
	"Работай строго в текущем репозитории. Не выходи за его пределы. " +
	"Самостоятельно исследуй проект, реализуй задачу полностью и проверь результат. ";

const packageJson = JSON.stringify(
	{
		name: "harness-eval-fixture",
		private: true,
		type: "commonjs",
		scripts: { test: "node --test test/*.test.js" },
	},
	null,
	2,
) + "\n";

export const longTasks = [
	{
		id: "ledger-spec-twins",
		prompt:
			STRICT +
			"У команды счетов одновременно сломан boundary bulk-discount и не реализован месячный summary по JSONL. " +
			"Источник истины — README.md. Исправь причину, а не маскируй симптомы; учти аналогичные места. " +
			"CLI `node src/cli.js summary <file> --month YYYY-MM` должен печатать одну JSON-строку. " +
			"Существующий публичный API сохраняй. В конце запусти релевантные тесты и весь npm test.",
		files: {
			"package.json": packageJson,
			"README.md": `# Ledger CLI

## Discount contract

Bulk discount is exactly 15% when quantity is **10 or more**. Quantity 9 is
never discounted. Quote and preview paths must use the same rule.

## Monthly summary contract

\`node src/cli.js summary <events.jsonl> --month YYYY-MM\` prints one JSON object:
\`{"month":"YYYY-MM","chargedCents":N,"refundedCents":N,"netCents":N,"events":N}\`.

Each non-empty line is JSON with \`id\`, ISO-8601 \`at\`, \`kind\`
(\`charge\` or \`refund\`) and integer \`cents\`. Bucket by the UTC month.
Duplicate ids are idempotent: the first valid occurrence wins. Lines with an
invalid shape, timestamp, kind, or non-integer/negative cents are ignored.
Money remains integer cents throughout.
`,
			"src/discount.js": `function bulkRate(quantity) {
  return quantity >= 10 ? 0.15 : 0;
}

// Preview was introduced later and drifted from the documented boundary.
function previewBulkRate(quantity) {
  return quantity >= 9 ? 0.15 : 0;
}

module.exports = { bulkRate, previewBulkRate };
`,
			"src/order.js": `const { bulkRate, previewBulkRate } = require("./discount.js");

function totalCents(unitCents, quantity, rate) {
  return Math.round(unitCents * quantity * (1 - rate));
}

function quoteOrder(unitCents, quantity) {
  return totalCents(unitCents, quantity, bulkRate(quantity));
}

function previewOrder(unitCents, quantity) {
  return totalCents(unitCents, quantity, previewBulkRate(quantity));
}

module.exports = { quoteOrder, previewOrder };
`,
			"src/summary.js": `function monthlySummary(_text, _month) {
  throw new Error("monthlySummary is not implemented");
}

module.exports = { monthlySummary };
`,
			"src/cli.js": `const fs = require("node:fs");
const { monthlySummary } = require("./summary.js");

function main(argv) {
  // TODO: implement the documented summary command.
  console.error("usage: summary <file> --month YYYY-MM");
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
`,
			"test/discount.test.js": `const test = require("node:test");
const assert = require("node:assert/strict");
const { bulkRate } = require("../src/discount.js");
const { quoteOrder } = require("../src/order.js");

test("bulk starts at nine", () => {
  assert.equal(bulkRate(9), 0.15);
});

test("quote uses cents", () => {
  assert.equal(quoteOrder(100, 10), 850);
});
`,
			"test/summary.test.js": `const test = require("node:test");
const assert = require("node:assert/strict");
const { monthlySummary } = require("../src/summary.js");

test("summarizes a simple month", () => {
  const text = [
    '{"id":"a","at":"2026-06-01T00:00:00Z","kind":"charge","cents":1200}',
    '{"id":"b","at":"2026-06-02T00:00:00Z","kind":"refund","cents":200}',
  ].join("\\n");
  assert.deepEqual(monthlySummary(text, "2026-06"), {
    month: "2026-06", chargedCents: 1200, refundedCents: 200, netCents: 1000, events: 2,
  });
});
`,
		},
		criteria: [
			{ id: "visible-suite", command: "npm test" },
			{
				id: "discount-boundary-and-twin",
				command:
					"node -e 'const d=require(\"./src/discount\");const o=require(\"./src/order\");" +
					"if(d.bulkRate(9)!==0||d.bulkRate(10)!==.15||d.previewBulkRate(9)!==0||" +
					"o.previewOrder(100,10)!==850)process.exit(1)'",
			},
			{
				id: "summary-edge-cases",
				command:
					"node - <<'NODE'\n" +
					"const {monthlySummary}=require('./src/summary');\n" +
					"const input=[\n" +
					"'{\"id\":\"z\",\"at\":\"2026-05-31T23:59:59-01:00\",\"kind\":\"charge\",\"cents\":500}',\n" +
					"'{\"id\":\"z\",\"at\":\"2026-06-02T00:00:00Z\",\"kind\":\"charge\",\"cents\":999}',\n" +
					"'{\"id\":\"r\",\"at\":\"2026-06-30T23:59:59Z\",\"kind\":\"refund\",\"cents\":125}',\n" +
					"'{\"id\":\"bad\",\"at\":\"nope\",\"kind\":\"charge\",\"cents\":2}',\n" +
					"'not json'\n" +
					"].join('\\n');\n" +
					"const got=monthlySummary(input,'2026-06');\n" +
					"const want={month:'2026-06',chargedCents:500,refundedCents:125,netCents:375,events:2};\n" +
					"if(JSON.stringify(got)!==JSON.stringify(want)){console.error(got);process.exit(1)}\n" +
					"NODE",
			},
			{
				id: "cli-contract",
				command:
					"f=$(mktemp); printf '%s\\n' " +
					"'{\"id\":\"a\",\"at\":\"2026-06-03T00:00:00Z\",\"kind\":\"charge\",\"cents\":42}' > \"$f\"; " +
					"test \"$(node src/cli.js summary \"$f\" --month 2026-06)\" = " +
					"'{\"month\":\"2026-06\",\"chargedCents\":42,\"refundedCents\":0,\"netCents\":42,\"events\":1}'",
			},
		],
	},
	{
		id: "config-migration",
		prompt:
			STRICT +
			"Доведи до production-ready мигратор конфигурации v1→v2 по CONTRACT.md. " +
			"Нужны библиотечный API и CLI с dry-run, атомарной записью и одинаковой нормализацией во всех путях. " +
			"Исправляя найденный дефект, проверь проект на его копии. Не добавляй зависимости. " +
			"Запусти точечные и полные проверки.",
		files: {
			"package.json": packageJson,
			"CONTRACT.md": `# Config migration contract

Input v1 has \`version: 1\`, \`host\`, \`port\`, optional \`features\`, and may
contain unknown keys. Output v2 has \`version: 2\` and \`server: {host, port}\`.
Unknown top-level keys and the features object must be preserved. Host defaults
to \`127.0.0.1\` only when the key is absent, its value is \`undefined\`, or it
is an empty/whitespace-only string. A supplied \`null\` or any other non-string
host is an error. Port accepts an integer or a
decimal digit string from 1 through 65535; anything else is an error.

\`migrateConfig(value)\` never mutates its input. A v2 input is validated and
returned as an equivalent fresh value (idempotent). The CLI is:

\`node src/cli.js migrate <file> [--dry-run]\`

Dry-run prints the migrated JSON and never writes. Normal mode atomically
replaces the file using a sibling temporary file plus rename, then prints the
same JSON. Failures leave the original byte-for-byte unchanged and exit nonzero.
All runtime consumers use the exported \`normalizeServer\`; copies are forbidden.
`,
			"src/normalize.js": `function normalizeServer(value) {
  const host = typeof value.host === "string" && value.host.trim() ? value.host.trim() : "127.0.0.1";
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  return { host, port };
}

module.exports = { normalizeServer };
`,
			"src/migrate.js": `function migrateConfig(_value) {
  throw new Error("not implemented");
}

module.exports = { migrateConfig };
`,
			"src/runtime.js": `const { normalizeServer } = require("./normalize.js");
function runtimeServer(config) { return normalizeServer(config.server || config); }
module.exports = { runtimeServer };
`,
			"src/preview.js": `// Historical copy: unlike normalizeServer, this silently accepts port 0.
function previewServer(config) {
  const value = config.server || config;
  return { host: String(value.host || "127.0.0.1"), port: Number(value.port || 0) };
}
module.exports = { previewServer };
`,
			"src/worker.js": `// Another drifted copy used by the worker path.
function workerServer(config) {
  const value = config.server || config;
  return { host: String(value.host || "0.0.0.0"), port: parseInt(value.port, 10) };
}
module.exports = { workerServer };
`,
			"src/cli.js": `function main() {
  console.error("migrate command is not implemented");
  return 2;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
`,
			"test/migrate.test.js": `const test = require("node:test");
const assert = require("node:assert/strict");
const { migrateConfig } = require("../src/migrate.js");

test("migrates a basic config", () => {
  assert.deepEqual(migrateConfig({version:1,host:"localhost",port:"8080",features:{x:true}}), {
    version:2, server:{host:"localhost",port:8080}, features:{x:true},
  });
});
`,
		},
		criteria: [
			{ id: "visible-suite", command: "npm test" },
			{
				id: "port-type-and-domain",
				command:
					"node - <<'NODE'\n" +
					"const {normalizeServer}=require('./src/normalize');" +
					"for(const [raw,want] of [[1,1],[65535,65535],['1',1],['0001',1],['65535',65535]]){" +
					"const got=normalizeServer({host:'h',port:raw});if(got.port!==want){console.error('valid',raw,got);process.exit(1)}}" +
					"for(const raw of [0,65536,1.5,NaN,Infinity,true,false,null,undefined,{},[],new Number(1),'',' ','0','65536','1.5','1e3','0x10','-1','+1']){" +
					"let threw=false;try{normalizeServer({host:'h',port:raw})}catch{threw=true}" +
					"if(!threw){console.error('accepted invalid port',String(raw),typeof raw);process.exit(1)}}\n" +
					"NODE",
			},
			{
				id: "host-default-boundary",
				kind: "security",
				command:
					"node - <<'NODE'\n" +
					"const {normalizeServer}=require('./src/normalize');" +
					"for(const value of [{port:1},{host:'',port:1},{host:'   ',port:1}]){" +
					"if(normalizeServer(value).host!=='127.0.0.1')process.exit(1)}" +
					"if(normalizeServer({host:' example ',port:1}).host!=='example')process.exit(1);" +
					"for(const host of [null,true,false,0,[],{}]){let threw=false;try{normalizeServer({host,port:1})}catch{threw=true}" +
					"if(!threw){console.error('silently defaulted invalid host',host);process.exit(1)}}\n" +
					"NODE",
			},
			{
				id: "preserve-idempotent-no-mutation",
				command:
					"node - <<'NODE'\n" +
					"const assert=require('node:assert/strict');const {migrateConfig}=require('./src/migrate');const x={version:1,host:' ',port:'443',features:{a:1},note:'keep'};" +
					"const before=JSON.stringify(x);const y=migrateConfig(x);const z=migrateConfig(y);" +
					"if(JSON.stringify(x)!==before||y.note!=='keep'||y.server.host!=='127.0.0.1'||y===z)process.exit(1);assert.deepEqual(y,z);\n" +
					"NODE",
			},
			{
				id: "shared-normalization",
				kind: "static",
				command:
					"node - <<'NODE'\n" +
					"const fs=require('fs');for(const p of ['./src/runtime','./src/preview','./src/worker']){" +
					"const m=require(p),f=Object.values(m)[0];let ok=false;try{f({server:{host:'x',port:0}})}catch{ok=true}" +
					"if(!ok){console.error('behavior',p);process.exit(1)}" +
					"const source=fs.readFileSync(p+'.js','utf8');if(!/require\\([\"']\\.\\/normalize\\.js[\"']\\)/.test(source)||!source.includes('normalizeServer')){" +
					"console.error('drifted copy',p);process.exit(1)}}\n" +
					"NODE",
			},
			{
				id: "version-and-dependency-boundary",
				kind: "security",
				command:
					"node - <<'NODE'\n" +
					"const pkg=require('./package.json');if(Object.keys(pkg.dependencies||{}).length||Object.keys(pkg.devDependencies||{}).length){console.error('dependency added');process.exit(1)}" +
					"const {migrateConfig}=require('./src/migrate');for(const version of [0,3,'1','2','01',true,false,null,undefined,{},[],new Number(1)]){" +
					"let threw=false;try{migrateConfig({version,host:'h',port:1})}catch{threw=true}" +
					"if(!threw){console.error('accepted version',version);process.exit(1)}}\n" +
					"NODE",
			},
			{
				id: "atomic-rename-boundary",
				kind: "security",
				command:
					"node - <<'NODE'\n" +
					"const fs=require('fs'),os=require('os'),path=require('path');const source=fs.readFileSync('./src/cli.js','utf8');" +
					"if(!/rename(?:Sync)?\\s*\\(/.test(source)){console.error('no rename boundary');process.exit(1)}" +
					"const d=fs.mkdtempSync(path.join(os.tmpdir(),'migrate-atomic-grade-')),f=path.join(d,'c.json');" +
					"const original='{\"version\":1,\"host\":\"h\",\"port\":9000,\"tag\":7}\\n';fs.writeFileSync(f,original);" +
					"fs.renameSync=()=>{const e=new Error('forced rename failure');e.code='EIO';throw e};" +
					"let failed=false;try{const result=require('./src/cli').main(['migrate',f]);failed=result!==0}catch{failed=true}" +
					"if(!failed||fs.readFileSync(f,'utf8')!==original){console.error('rename failure corrupted original');process.exit(1)}\n" +
					"NODE",
			},
			{
				id: "dry-run-and-atomic-failure",
				command:
					"node - <<'NODE'\n" +
					"const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');" +
					"const d=fs.mkdtempSync(path.join(os.tmpdir(),'migrate-grade-'));const f=path.join(d,'c.json');" +
					"const raw='{\"version\":1,\"host\":\"h\",\"port\":\"9000\",\"tag\":7}\\n';fs.writeFileSync(f,raw);" +
					"let r=cp.spawnSync(process.execPath,['src/cli.js','migrate',f,'--dry-run'],{encoding:'utf8'});" +
					"if(r.status!==0||fs.readFileSync(f,'utf8')!==raw||JSON.parse(r.stdout).server.port!==9000)process.exit(1);" +
					"fs.writeFileSync(f,'{\"version\":1,\"port\":0}\\n');r=cp.spawnSync(process.execPath,['src/cli.js','migrate',f],{encoding:'utf8'});" +
					"if(r.status===0||fs.readFileSync(f,'utf8')!=='{\"version\":1,\"port\":0}\\n')process.exit(1);\n" +
					"NODE",
			},
			{
				id: "normal-write",
				command:
					"node - <<'NODE'\n" +
					"const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');" +
					"const d=fs.mkdtempSync(path.join(os.tmpdir(),'migrate-grade-'));const f=path.join(d,'c.json');" +
					"fs.writeFileSync(f,'{\"version\":1,\"host\":\"h\",\"port\":1234,\"tag\":7}\\n');" +
					"const r=cp.spawnSync(process.execPath,['src/cli.js','migrate',f],{encoding:'utf8'});const disk=JSON.parse(fs.readFileSync(f,'utf8'));" +
					"if(r.status!==0||disk.version!==2||disk.tag!==7||disk.server.port!==1234||JSON.stringify(disk)!==JSON.stringify(JSON.parse(r.stdout)))process.exit(1);\n" +
					"NODE",
			},
		],
	},
];
