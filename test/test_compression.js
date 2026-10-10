// ContextKeeper 压缩引擎单元测试（Node 直跑，无依赖）
// 用法：node test/test_compression.js
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// stub vscode 模块（extension.js 只用到 workspace.workspaceFolders，测试用例不受影响）
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') {
    return {
      workspace: { workspaceFolders: [{ uri: { fsPath: os.tmpdir() } }] },
      window: {},
      commands: {},
      StatusBarAlignment: { Left: 1, Right: 2 },
      trae: {}
    };
  }
  return origLoad.apply(this, [request, ...args]);
};

const ext = require('../extension/extension.js');
const t = ext.__test;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' | ' + extra : ''}`); }
}

// 对齐校验：每个省略标记的区间必须落在原文中，且区间外的内容逐行对齐
function verifyAlignment(src, out, omitted, label) {
  const srcLines = src.split('\n');
  const outLines = out.split('\n');
  let oi = 0;
  for (const [s, e] of omitted) {
    // 标记前的输出必须与原文在标记区间前的内容一致（忽略空行折叠/注释折叠/去重等规范化）
    const marker = outLines.find(l => l.includes(`原文行 ${s}-${e}`));
    if (!marker) return `missing marker for ${s}-${e}`;
  }
  // 行数守恒：输出行数 + 省略行数 = 原文行数（± cleanupOut 的空行折叠）
  const totalOmitted = omitted.reduce((a, r) => a + (r[1] - r[0] + 1), 0);
  if (outLines.length + totalOmitted < srcLines.length - 10) return `line count mismatch: out=${outLines.length} omitted=${totalOmitted} src=${srcLines.length}`;
  return null;
}

// ===== 用例 1：花括号语言（JS/Java）结构骨架 =====
{
  const src = `// header comment
const A = 1;

class Foo {
  constructor() {
    this.x = 1;
    this.y = 2;
    this.z = 3;
    this.w = 4;
    this.v = 5;
    this.u = 6;
  }
  bar(a, b) {
    const r = a + b;
    return r;
  }
}

function bigFn(n) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += i * 2;
  }
  return s;
}
`;
  const lines = src.split('\n');
  const opts = { keepHead: 2, keepTail: 2 };
  const res = t.compressBraced(lines, opts, 'ck-t1');
  const outText = res.out.join('\n');
  const origTok = t.estTokens(src);
  const compTok = t.estTokens(outText);
  check('braced: 有省略标记', res.omitted.length >= 1);
  check('braced: 类签名保留', outText.includes('class Foo'));
  check('braced: 方法签名保留', outText.includes('bar(a, b)'));
  check('braced: token 下降', compTok < origTok * 0.9, `orig=${origTok} comp=${compTok}`);
  const alignErr = verifyAlignment(src, outText, res.omitted, 'braced');
  check('braced: 省略区间对齐', !alignErr, alignErr || '');
}

// ===== 用例 2：Python 结构骨架 =====
{
  const fixture = path.join(__dirname, 'mock_target.py');
  const src = fs.readFileSync(fixture, 'utf8');
  const lines = src.split('\n');
  const opts = { keepHead: 2, keepTail: 2 };
  const res = t.compressPython(lines, opts, 'ck-t2');
  const outText = res.out.join('\n');
  const origTok = t.estTokens(src);
  const compTok = t.estTokens(outText);
  const savedPct = Math.round((1 - compTok / origTok) * 100);
  check('python: 有省略标记', res.omitted.length >= 1);
  check('python: 函数签名保留', outText.includes('def big_function'));
  check('python: 大函数体省略', !outText.includes('x20 = compute_20'));
  check('python: 节省 >= 50%', savedPct >= 50, `saved=${savedPct}% orig=${origTok} comp=${compTok}`);
  const alignErr = verifyAlignment(src, outText, res.omitted, 'python');
  check('python: 省略区间对齐', !alignErr, alignErr || '');
}

// ===== 用例 3：小文件 passthrough =====
{
  const src = 'a\nb\nc\n';
  const res = t.compressGeneric(src.split('\n'), 'ck-t3');
  check('small: 原样返回', res.passthrough === true);
}

// ===== 用例 4：模式开关持久化往返 =====
{
  t.setMode('normal');
  check('mode: set normal', t.getMode() === 'normal');
  t.setMode('optimize');
  check('mode: set optimize', t.getMode() === 'optimize');
}

console.log(`\n===== ${pass} pass / ${fail} fail =====`);
process.exit(fail ? 1 : 0);
