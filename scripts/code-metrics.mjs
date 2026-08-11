import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter((file) => file && existsSync(path.join(root, file)));
const textExtensions = new Set([".ts", ".tsx", ".css", ".md", ".json", ".mjs", ".yml", ".yaml", ".env", ".example"]);
const codeExtensions = new Set([".ts", ".tsx", ".css", ".mjs"]);

function extension(file) {
  if (file === ".env.example") return ".example";
  return path.extname(file).toLowerCase();
}

function countLines(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0);
}

function isFunctionLike(node) {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node);
}

function complexityForFunction(node) {
  let complexity = 1;
  const visit = (child) => {
    if (child !== node && isFunctionLike(child)) return;
    if (
      ts.isIfStatement(child)
      || ts.isConditionalExpression(child)
      || ts.isForStatement(child)
      || ts.isForInStatement(child)
      || ts.isForOfStatement(child)
      || ts.isWhileStatement(child)
      || ts.isDoStatement(child)
      || ts.isCatchClause(child)
    ) complexity += 1;
    if (ts.isCaseClause(child)) complexity += 1;
    if (ts.isBinaryExpression(child)) {
      const operator = child.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.AmpersandAmpersandToken
        || operator === ts.SyntaxKind.BarBarToken
        || operator === ts.SyntaxKind.QuestionQuestionToken
      ) complexity += 1;
    }
    ts.forEachChild(child, visit);
  };
  if (node.body) visit(node.body);
  return complexity;
}

const files = [];
const functions = [];
const byDirectory = new Map();
let totalBytes = 0;
let totalLines = 0;
let applicationLines = 0;
let applicationFiles = 0;

for (const file of trackedFiles) {
  const absolute = path.join(root, file);
  const bytes = readFileSync(absolute);
  const fileExtension = extension(file);
  totalBytes += bytes.byteLength;
  const entry = { file, bytes: bytes.byteLength, lines: null, language: fileExtension.slice(1) || "unknown" };
  if (textExtensions.has(fileExtension)) {
    const text = bytes.toString("utf8");
    entry.lines = countLines(text);
    totalLines += entry.lines;
    const isApplicationFile = /^(app|components|src)\//.test(file);
    if (codeExtensions.has(fileExtension) && isApplicationFile) {
      applicationFiles += 1;
      applicationLines += entry.lines;
      if (fileExtension === ".ts" || fileExtension === ".tsx") {
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const visit = (node) => {
          if (isFunctionLike(node)) {
            const name = node.name?.getText
              ? node.name.getText()
              : ts.isVariableDeclaration(node.parent) ? node.parent.name.getText() : "anonymous";
            functions.push({ file, name, complexity: complexityForFunction(node) });
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  }
  files.push(entry);
  const directory = file.includes("/") ? file.split("/")[0] : "(root)";
  const current = byDirectory.get(directory) ?? { files: 0, lines: 0, bytes: 0 };
  current.files += 1;
  current.lines += entry.lines ?? 0;
  current.bytes += entry.bytes;
  byDirectory.set(directory, current);
}

const sortedFunctions = functions.sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file));
const complexityTotal = functions.reduce((sum, item) => sum + item.complexity, 0);
const complexityAverage = functions.length ? Number((complexityTotal / functions.length).toFixed(2)) : 0;

const result = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  trackedFiles: trackedFiles.length,
  textFiles: files.filter((file) => file.lines !== null).length,
  totalBytes,
  totalLines,
  applicationFiles,
  applicationLines,
  directories: Object.fromEntries([...byDirectory.entries()].sort(([a], [b]) => a.localeCompare(b))),
  complexity: {
    functions: functions.length,
    totalCyclomatic: complexityTotal,
    averageCyclomatic: complexityAverage,
    maxCyclomatic: sortedFunctions[0]?.complexity ?? 0,
    highest: sortedFunctions.slice(0, 10),
  },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`# TwoOnly code metrics\n\n- Commit: \`${result.commit}\`\n- Tracked files: ${result.trackedFiles}\n- Text files: ${result.textFiles}\n- Total tracked text lines: ${result.totalLines.toLocaleString()}\n- Application source files: ${result.applicationFiles}\n- Application source lines: ${result.applicationLines.toLocaleString()}\n- Total tracked bytes: ${result.totalBytes.toLocaleString()}\n- TypeScript/React functions: ${result.complexity.functions}\n- Cyclomatic proxy: total ${result.complexity.totalCyclomatic}, average ${result.complexity.averageCyclomatic}, max ${result.complexity.maxCyclomatic}\n\n## Directory breakdown\n\n| Directory | Files | Text lines | Bytes |\n| --- | ---: | ---: | ---: |`);
  for (const [directory, stats] of Object.entries(result.directories)) {
    console.log(`| \`${directory}\` | ${stats.files} | ${stats.lines.toLocaleString()} | ${stats.bytes.toLocaleString()} |`);
  }
  console.log("\n## Highest complexity functions\n\n| File | Function | Cyclomatic proxy |\n| --- | --- | ---: |");
  for (const item of result.complexity.highest) console.log(`| \`${item.file}\` | \`${item.name}\` | ${item.complexity} |`);
}
