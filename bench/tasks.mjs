/**
 * Задачи бенчмарка (ROADMAP §5.11-1, H3). Каждая: файлы стартового состояния,
 * промпт и детерминированная проверка успеха (bash, exit 0 = задача решена).
 * Промпты начинаются с якоря «строго в текущем каталоге» (урок §5.9-5).
 */

const STRICT = "Работай СТРОГО в текущем каталоге, никуда из него не выходи. ";

export const tasks = [
	{
		id: "bugfix-off-by-one",
		prompt:
			STRICT +
			"В файле stats.js есть баг — функция sumFirst считает неверно. Почини её так, чтобы node test.js завершался успешно, и прогони тест.",
		files: {
			"stats.js":
				"// суммирует первые n элементов массива\n" +
				"function sumFirst(arr, n) {\n" +
				"  let s = 0;\n" +
				"  for (let i = 0; i <= n; i++) s += arr[i] ?? 0;\n" +
				"  return s;\n" +
				"}\n" +
				"module.exports = { sumFirst };\n",
			"test.js":
				'const { sumFirst } = require("./stats.js");\n' +
				"const ok = sumFirst([1, 2, 3, 4], 2) === 3 && sumFirst([5], 1) === 5 && sumFirst([], 0) === 0;\n" +
				'if (!ok) { console.error("FAIL"); process.exit(1); }\n' +
				'console.log("OK");\n',
		},
		check: "node test.js",
	},
	{
		id: "feature-slugify",
		prompt:
			STRICT +
			"Добавь в text.js функцию slugify(s): нижний регистр, пробелы и подчёркивания → дефисы, все символы кроме латиницы/цифр/дефисов удалить, схлопнуть повторные дефисы, обрезать дефисы по краям. Экспортируй её рядом с trim2 и прогони node test.js.",
		files: {
			"text.js":
				"function trim2(s) {\n  return String(s).trim();\n}\nmodule.exports = { trim2 };\n",
			"test.js":
				'const { slugify } = require("./text.js");\n' +
				'const cases = [["Hello  World", "hello-world"], ["a_b-c", "a-b-c"], ["  Rust & JS!  ", "rust-js"]];\n' +
				"for (const [inp, want] of cases) {\n" +
				"  if (slugify(inp) !== want) { console.error(`FAIL ${inp}: ${slugify(inp)} != ${want}`); process.exit(1); }\n" +
				"}\n" +
				'console.log("OK");\n',
		},
		check: "node test.js",
	},
	{
		id: "refactor-rename",
		prompt:
			STRICT +
			"Переименуй функцию getData во всех файлах проекта в fetchRecords (объявление и все вызовы), ничего больше не меняя. Проверь, что node main.js печатает 42.",
		files: {
			"api.js": "function getData() {\n  return 42;\n}\nmodule.exports = { getData };\n",
			"main.js": 'const { getData } = require("./api.js");\nconsole.log(getData());\n',
		},
		check:
			'node main.js | grep -q 42 && grep -q fetchRecords api.js && grep -q fetchRecords main.js && ! grep -rq getData .',
	},
	{
		id: "multi-file-structure",
		prompt:
			STRICT +
			"Создай мини-структуру CLI-проекта: src/index.js (печатает hello от lib), src/lib/greet.js (экспортирует greet(name) → строка `hello, <name>`), README.md с разделом Usage. Проверь: node src/index.js печатает «hello, world».",
		files: {},
		check: 'node src/index.js | grep -q "hello, world" && grep -qi usage README.md && test -f src/lib/greet.js',
	},
	{
		id: "websearch-version",
		// Ожидаемо падает, пока web-инструменты не возвращены (H4) — это baseline-детектор.
		prompt:
			STRICT +
			"Выясни через web-поиск (если инструменты веба недоступны — честно напиши в ответе фразу NO-WEB-TOOLS) актуальную мажорную версию Node.js LTS и запиши одно число в файл answer.txt.",
		files: {},
		check: 'test -f answer.txt && grep -Eq "^[0-9]{2}" answer.txt',
	},
];
