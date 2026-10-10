const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 账单统计文件：context_stats 工具的数据源（工具运行时生成，可配置）
let STATS_PATH = path.join(os.tmpdir(), 'contextkeeper_stats.jsonl');
try {
  const ws = vscode.workspace && vscode.workspace.workspaceFolders;
  if (ws && ws.length) {
    const dir = path.join(ws[0].uri.fsPath, '.contextkeeper');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    STATS_PATH = path.join(dir, 'stats.jsonl');
  }
} catch (e) {}

function appendStat(rec) {
  try { fs.appendFileSync(STATS_PATH, JSON.stringify(rec) + '\n', 'utf8'); } catch (e) {}
  try {
    if (Number.isFinite(rec.origTok) && Number.isFinite(rec.compTok)) savedTotal += Math.max(0, rec.origTok - rec.compTok);
    updateStatusBar();
  } catch (e) {}
}

// ---------- 状态栏实时账单 ----------

let statusBar = null;
let savedTotal = 0; // 累计节省 tokens（启动时从 stats.jsonl 读取基准，运行中内存增量）

function loadSavedTotal() {
  try {
    if (!fs.existsSync(STATS_PATH)) return;
    const lines = fs.readFileSync(STATS_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
    let total = 0;
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (Number.isFinite(r.origTok) && Number.isFinite(r.compTok)) total += Math.max(0, r.origTok - r.compTok);
      } catch (e) {}
    }
    savedTotal = total;
  } catch (e) {}
}

function updateStatusBar() {
  try {
    if (!statusBar) return;
    const modeTxt = MODE === 'optimize' ? '$(zap) CK 优化' : '$(eye) CK 常规';
    statusBar.text = `${modeTxt} | 已省 ${savedTotal.toLocaleString()} tok`;
    statusBar.tooltip = `ContextKeeper token 账单\n当前模式：${MODE === 'optimize' ? '优化（压缩读取）' : '常规（全文返回）'}\n累计节省：${savedTotal.toLocaleString()} tokens\n点击查看明细（context_stats）`;
  } catch (e) {}
}
function estTokens(s) {
  return Math.max(1, Math.ceil(s.length / 3.4));
}

const BRACE_EXTS = new Set(['.java', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json',
  '.css', '.scss', '.less', '.c', '.h', '.cpp', '.hpp', '.cc', '.go', '.rs', '.cs',
  '.kt', '.kts', '.swift', '.php', '.dart', '.scala', '.groovy']);

// ---------- 工具函数 ----------

function resolvePath(p) {
  if (!p) return null;
  const raw = String(p).trim().replace(/^["']|["']$/g, '');
  if (path.isAbsolute(raw)) return raw;
  const ws = vscode.workspace && vscode.workspace.workspaceFolders;
  if (ws && ws.length) return path.join(ws[0].uri.fsPath, raw);
  return raw;
}

function braceDelta(line) {
  // 去掉字符串字面量与行注释后再数大括号，避免误判
  let s = line.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const ci = s.indexOf('//');
  if (ci >= 0) s = s.slice(0, ci);
  let n = 0;
  for (let i = 0; i < s.length; i++) { if (s[i] === '{') n++; else if (s[i] === '}') n--; }
  return n;
}

function buildBraceBlocks(lines) {
  const stack = [];
  const blocks = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const d = braceDelta(lines[i]);
    if (d > 0) stack.push({ start: i, depth: depth });
    depth += d;
    if (d < 0) {
      for (let k = 0; k < -d; k++) {
        const b = stack.pop();
        if (b) blocks.push({ start: b.start, end: i, depth: b.depth });
      }
    }
  }
  return blocks;
}

function findSigStart(lines, braceLine) {
  let s = braceLine;
  let back = 0;
  while (s > 0 && back < 8) {
    const prev = lines[s - 1].trim();
    if (prev === '' || prev.endsWith(';') || prev.endsWith('}') || prev.endsWith('*/')) break;
    s--; back++;
  }
  return s;
}

function cleanupOut(arr) {
  // 1) 去行尾空白 + 折叠连续空行
  const step1 = [];
  let lastBlank = false;
  for (const raw of arr) {
    const l = raw.replace(/\s+$/, '');
    if (l.trim() === '') {
      if (!lastBlank) step1.push('');
      lastBlank = true;
    } else { step1.push(l); lastBlank = false; }
  }
  // 2) 连续 3 行以上行注释折叠为首行 + 省略标记
  const step2 = [];
  let i = 0;
  const isC = (s) => s.trim().startsWith('//');
  while (i < step1.length) {
    if (isC(step1[i])) {
      let j = i;
      while (j < step1.length && isC(step1[j])) j++;
      const run = j - i;
      if (run >= 3) {
        step2.push(step1[i]);
        step2.push(`// ...(${run - 1} more comment lines omitted)`);
      } else {
        for (let k = i; k < j; k++) step2.push(step1[k]);
      }
      i = j;
    } else { step2.push(step1[i]); i++; }
  }
  // 3) 重复 import 去重（保留首个）
  const isImport = (s) => /^\s*(import\b|using\s|package\s|#include|from\s+\S+\s+import)/.test(s);
  const seen = new Set();
  const step3 = [];
  for (const l of step2) {
    if (isImport(l)) {
      const key = l.trim();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    step3.push(l);
  }
  return step3;
}

// ---------- REF 影子存储（内存 + 落盘持久化） ----------

const refs = new Map();
let refSeq = 0;
const MAX_PERSISTED_REFS = 200;

function ckDir() {
  const ws = vscode.workspace && vscode.workspace.workspaceFolders;
  const base = (ws && ws.length) ? ws[0].uri.fsPath : path.dirname(STATS_PATH);
  return path.join(base, '.contextkeeper');
}
function refsDir() { return path.join(ckDir(), 'refs'); }

// ---------- 模式开关（/optimize ↔ /normal，跨对话持久化） ----------

let MODE = 'optimize'; // optimize=压缩省 token（默认）；normal=常规全文读取
function modeFile() { return path.join(ckDir(), 'mode.json'); }
function loadMode() {
  try {
    if (fs.existsSync(modeFile())) {
      const m = JSON.parse(fs.readFileSync(modeFile(), 'utf8'));
      if (m.mode === 'normal' || m.mode === 'optimize') MODE = m.mode;
    }
  } catch (e) {}
}
function getMode() { return MODE; }
function setMode(m) {
  MODE = m;
  try {
    fs.mkdirSync(ckDir(), { recursive: true });
    fs.writeFileSync(modeFile(), JSON.stringify({ mode: m, time: new Date().toISOString() }), 'utf8');
  } catch (e) {}
  updateStatusBar();
}

function refFile(id) { return path.join(refsDir(), id + '.json'); }

function persistRef(id, rec) {
  try {
    const dir = refsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(refFile(id), JSON.stringify({ id, path: rec.path, text: rec.text, time: new Date().toISOString() }), 'utf8');
    // 超出上限时删除最旧的落盘 REF
    const files = fs.readdirSync(dir).filter(f => /^ck-\d+\.json$/.test(f));
    if (files.length > MAX_PERSISTED_REFS) {
      files.map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => a.m - b.m)
        .slice(0, files.length - MAX_PERSISTED_REFS)
        .forEach(x => { try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) {} });
    }
  } catch (e) {}
}

function getRef(id) {
  if (refs.has(id)) return refs.get(id);
  try { // 窗口重载后内存清空，从磁盘恢复
    const f = refFile(id);
    if (fs.existsSync(f)) {
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
      refs.set(id, { path: rec.path, text: rec.text });
      return refs.get(id);
    }
  } catch (e) {}
  return null;
}

function restoreRefSeq() {
  // 启动时对齐落盘 REF 的最大编号，避免新 REF 覆盖历史编号
  try {
    const dir = refsDir();
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^ck-(\d+)\.json$/);
      if (m) refSeq = Math.max(refSeq, parseInt(m[1], 10));
    }
  } catch (e) {}
}

function saveRef(fp, text) {
  refSeq += 1;
  const id = 'ck-' + refSeq;
  refs.set(id, { path: fp, text: text });
  persistRef(id, refs.get(id));
  return id;
}

// ---------- 压缩引擎 ----------

// 定义行识别：顶层块若包含多个"定义型"直接子块（方法/函数），说明是类/命名空间等包裹结构
function looksLikeDef(line) {
  return /\b(function|def|class|public|private|protected|static|fn|func|impl|sub|interface|enum|trait)\b/.test(line);
}

function compressBraced(lines, opts, refId) {
  const blocks = buildBraceBlocks(lines);
  // 候选：块体足够长；深层（叶子）优先，同层按出现顺序
  const cand = blocks
    .filter(b => (b.end - b.start - 1) - opts.keepHead - opts.keepTail >= 2)
    .sort((a, b) => (b.depth - a.depth) || (a.start - b.start));
  const chosen = [];
  for (const b of cand) {
    if (chosen.some(c => b.start >= c.start && b.end <= c.end)) continue; // 落在已选块内，跳过
    if (b.depth === 0) {
      // 顶层包裹结构（类/命名空间）：改用"签名保全"渲染——保留全部成员签名，成员体整体省略
      const defChildren = blocks.filter(c =>
        c.depth === 1 && c.start > b.start && c.end < b.end && looksLikeDef(lines[c.start]));
      if (defChildren.length >= 2) b.wrapper = defChildren.sort((x, y) => x.start - y.start);
    }
    chosen.push(b);
  }
  // wrapper 类统一渲染成员：删除其内部已选子块，否则子块先渲染会把 cursor 推过类起点，wrapper 被 start<cursor 跳过
  const wrappers = chosen.filter(b => b.wrapper);
  for (let k = chosen.length - 1; k >= 0; k--) {
    const b = chosen[k];
    if (!b.wrapper && wrappers.some(w => b.start >= w.start && b.end <= w.end)) chosen.splice(k, 1);
  }
  chosen.sort((a, b) => a.start - b.start);
  const out = [];
  const omitted = [];
  let cursor = 0;
  for (const b of chosen) {
    if (b.start < cursor) continue;
    if (b.wrapper) {
      // 包裹结构渲染：成员签名全保留，成员体（含小方法）全部省略为行号标记
      for (let i = cursor; i <= b.start; i++) out.push(lines[i]);
      let i = b.start + 1;
      for (const ch of b.wrapper) {
        const sigStart = findSigStart(lines, ch.start);
        for (let k = i; k < sigStart; k++) out.push(lines[k]); // 成员之间的类级语句
        for (let k = sigStart; k <= ch.start; k++) out.push(lines[k]); // 成员签名行
        const s1 = ch.start + 2, e1 = ch.end; // 成员体 1-based 区间（不含收尾大括号行）
        if (e1 >= s1) {
          omitted.push([s1, e1]);
          out.push(`[CK-OMITTED 原文行 ${s1}-${e1}（省略 ${e1 - s1 + 1} 行）—— 调用 load_context_ref(ref_id="${refId}", ranges="${s1}-${e1}") 可查看]`);
        } else {
          for (let k = ch.start + 1; k < ch.end; k++) out.push(lines[k]); // 体过短，原样保留
        }
        out.push(lines[ch.end]); // 收尾大括号
        i = ch.end + 1;
      }
      for (let k = i; k <= b.end; k++) out.push(lines[k]); // 尾部类级语句 + 类收尾
      cursor = b.end + 1;
      continue;
    }
    for (let i = cursor; i <= b.start; i++) out.push(lines[i]);
    for (let i = b.start + 1; i <= b.start + opts.keepHead; i++) out.push(lines[i]);
    const os = b.start + opts.keepHead + 1;   // 0-based 首行
    const oe = b.end - opts.keepTail - 1;      // 0-based 末行
    if (oe >= os) {
      const s1 = os + 1, e1 = oe + 1;         // 1-based（供 ranges 参数使用）
      omitted.push([s1, e1]);
      out.push(`[CK-OMITTED 原文行 ${s1}-${e1}（省略 ${e1 - s1 + 1} 行）—— 调用 load_context_ref(ref_id="${refId}", ranges="${s1}-${e1}") 可查看]`);
    }
    for (let i = Math.max(b.start + 1, b.end - opts.keepTail); i <= b.end; i++) out.push(lines[i]);
    cursor = b.end + 1;
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i]);
  return { out: cleanupOut(out), omitted };
}

// ---------- Python（缩进语言）结构骨架 ----------

const PY_EXTS = new Set(['.py', '.pyw']);

function indentWidth(line) {
  const m = line.match(/^\s*/);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

function buildPythonBlocks(lines) {
  const defRe = /^(\s*)(async\s+def|def|class)\b/;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!defRe.test(lines[i])) continue;
    const indent = indentWidth(lines[i]);
    let end = i; // 块末 = 最后一个缩进更深的非空行
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      if (indentWidth(lines[j]) > indent) end = j; else break;
    }
    let sig = i; // 签名起点向上并入连续装饰器行
    while (sig > 0 && /^\s*@/.test(lines[sig - 1])) sig--;
    blocks.push({ start: sig, defLine: i, end, indent });
  }
  return blocks;
}

// docstring 语义线索保留：方法体首部若为 docstring（""" 或 '''), 返回其 0-based 结束行（≤DOC_MAX 行才保留，超长不保留）；非 docstring 返回 -1
const DOC_MAX = 8;
function docstringEnd(lines, defLine, end) {
  const first = (lines[defLine + 1] || '').trim();
  if (!/^(?:"""|''')/.test(first)) return -1;
  const q = first.slice(0, 3);
  if (first.length > 3 && first.indexOf(q, 3) >= 0) return defLine + 1; // 单行 docstring
  for (let j = defLine + 2; j <= Math.min(end, defLine + DOC_MAX); j++) {
    if ((lines[j] || '').indexOf(q) >= 0) return j;
  }
  return -1;
}

function compressPython(lines, opts, refId) {
  const blocks = buildPythonBlocks(lines);
  // 候选：块体足够长；高缩进（叶子）优先——方法先于类被选中，保留成员签名
  const cand = blocks
    .filter(b => (b.end - b.defLine) - opts.keepHead - opts.keepTail >= 2)
    .sort((a, b) => (b.indent - a.indent) || (a.start - b.start));
  const chosen = [];
  for (const b of cand) {
    if (chosen.some(c => b.defLine >= c.defLine && b.end <= c.end)) continue; // 落在已选块内，跳过
    if (b.indent === 0) {
      // 顶层包裹结构（class）：改用"签名保全"渲染——保留全部方法签名，方法体整体省略
      const defChildren = blocks.filter(c => c.indent > b.indent && c.start > b.start && c.end <= b.end);
      if (defChildren.length >= 2) b.wrapper = defChildren.sort((x, y) => x.start - y.start);
    }
    chosen.push(b);
  }
  // wrapper 类统一渲染成员：删除其内部已选子块（同 compressBraced，避免子块先渲染导致 wrapper 被跳过）
  const wrappers = chosen.filter(b => b.wrapper);
  for (let k = chosen.length - 1; k >= 0; k--) {
    const b = chosen[k];
    if (!b.wrapper && wrappers.some(w => b.start >= w.start && b.end <= w.end)) chosen.splice(k, 1);
  }
  chosen.sort((a, b) => a.start - b.start);
  const out = [];
  const omitted = [];
  let cursor = 0;
  for (const b of chosen) {
    if (b.start < cursor) continue;
    if (b.wrapper) {
      // 包裹结构渲染：方法签名全保留（含装饰器），方法体整体省略为行号标记
      for (let i = cursor; i <= b.defLine; i++) out.push(lines[i]);
      let i = b.defLine + 1;
      for (const ch of b.wrapper) {
        for (let k = i; k < ch.start; k++) out.push(lines[k]); // 方法之间的类级语句（docstring/属性）
        for (let k = ch.start; k <= ch.defLine; k++) out.push(lines[k]); // 方法签名（装饰器 + def 行）
        const docEnd = docstringEnd(lines, ch.defLine, ch.end); // 0-based docstring 结束行
        if (docEnd >= 0) {
          for (let k = ch.defLine + 1; k <= docEnd; k++) out.push(lines[k]); // 保留 docstring（方法语义线索）
          const s1 = docEnd + 2, e1 = ch.end + 1; // docstring 之后的方法体 1-based 区间
          if (e1 >= s1) {
            omitted.push([s1, e1]);
            out.push(`[CK-OMITTED 原文行 ${s1}-${e1}（省略 ${e1 - s1 + 1} 行）—— 调用 load_context_ref(ref_id="${refId}", ranges="${s1}-${e1}") 可查看]`);
          }
        } else {
          const s1 = ch.defLine + 2, e1 = ch.end + 1; // 方法体 1-based 区间
          if (e1 >= s1) {
            omitted.push([s1, e1]);
            out.push(`[CK-OMITTED 原文行 ${s1}-${e1}（省略 ${e1 - s1 + 1} 行）—— 调用 load_context_ref(ref_id="${refId}", ranges="${s1}-${e1}") 可查看]`);
          } else {
            for (let k = ch.defLine + 1; k <= ch.end; k++) out.push(lines[k]); // 体过短，原样保留
          }
        }
        i = ch.end + 1;
      }
      for (let k = i; k <= b.end; k++) out.push(lines[k]); // 尾部类级语句
      cursor = b.end + 1;
      continue;
    }
    for (let i = cursor; i <= b.defLine; i++) out.push(lines[i]); // 装饰器 + def/class 签名行
    for (let i = b.defLine + 1; i <= b.defLine + opts.keepHead; i++) out.push(lines[i]); // 体首 keepHead 行
    const os = b.defLine + opts.keepHead + 1; // 0-based 首行
    const oe = b.end - opts.keepTail;         // 0-based 末行
    if (oe >= os) {
      const s1 = os + 1, e1 = oe + 1;         // 1-based（供 ranges 参数使用）
      omitted.push([s1, e1]);
      out.push(`[CK-OMITTED 原文行 ${s1}-${e1}（省略 ${e1 - s1 + 1} 行）—— 调用 load_context_ref(ref_id="${refId}", ranges="${s1}-${e1}") 可查看]`);
    }
    for (let i = Math.max(b.defLine + 1, b.end - opts.keepTail + 1); i <= b.end; i++) out.push(lines[i]); // 体尾 keepTail 行
    cursor = b.end + 1;
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i]);
  return { out: cleanupOut(out), omitted };
}

function compressGeneric(lines, refId) {
  const maxLines = 400;
  if (lines.length <= maxLines) return { out: lines, omitted: [], passthrough: true };
  const head = 120, tail = 60;
  const out = lines.slice(0, head).map(x => x);
  const os = head + 1, oe = lines.length - tail;
  out.push(`[CK-OMITTED 原文行 ${os}-${oe}（省略 ${oe - os + 1} 行）—— 调用 load_context_ref(ref_id="${refId}", ranges="${os}-${oe}") 可查看]`);
  for (let i = lines.length - tail; i < lines.length; i++) out.push(lines[i]);
  return { out: cleanupOut(out), omitted: [[os, oe]] };
}

// ---------- MCP 工具定义 ----------

const tools = [
  {
    name: 'read_file_smart',
    description: '智能读取文件（规则压缩）：返回文件结构骨架（保留包声明/import、类与方法签名、注解、关键行），超长函数体省略为行号索引，比完整读取节省 50-80% token；省略内容随时可用 load_context_ref 按行号取回，不丢信息。当需要读取超过 100 行的代码或文本文件、或只需要理解文件结构与关键逻辑时，应优先使用本工具；确需全文时再用 load_context_ref 取回。受全局模式开关控制：优化模式（/optimize，默认）压缩返回；常规模式（/normal）全文返回。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，绝对路径或相对工作区根目录的相对路径' },
        body_keep_lines: { type: 'number', description: '骨架化大函数块时保留的函数体前几行，默认 4；0 表示只保留签名' },
        full: { type: 'boolean', description: 'true 时跳过压缩直接返回完整原文（仅在明确需要全文时使用）' }
      },
      required: ['path']
    },
    handler: (input) => {
      try {
        const p = resolvePath(input && input.path);
        if (!p || !fs.existsSync(p)) return `[ContextKeeper] 错误：文件不存在（${p || '路径为空'}）`;
        const st = fs.statSync(p);
        if (st.isDirectory()) return `[ContextKeeper] 错误：这是目录不是文件：${p}`;
        if (st.size > 2 * 1024 * 1024) return `[ContextKeeper] 错误：文件超过 2MB，拒绝读取：${p}`;
        const text = fs.readFileSync(p, 'utf8');
        if (text.indexOf('\u0000') >= 0) return `[ContextKeeper] 错误：疑似二进制文件，拒绝读取：${p}`;

        const origLines = text.split(/\r?\n/);
        const origTok = estTokens(text);
        const refId = saveRef(p, text);

        if (MODE === 'normal' && input.full !== true) {
          appendStat({ time: new Date().toISOString(), tool: 'read_file_smart', path: p, mode: 'normal-full', origTok, compTok: origTok, savedPct: 0 });
          return `[ContextKeeper read_file_smart·常规模式] ${p}\n当前为 /normal 常规模式：不做压缩，全文返回（常规 token 消耗）。输入 /optimize 可切回优化模式。\n\n${text}\n\n[REF ${refId}]`;
        }

        if (input.full === true) {
          appendStat({ time: new Date().toISOString(), tool: 'read_file_smart', path: p, mode: 'full', origTok, compTok: origTok, savedPct: 0 });
          return `[ContextKeeper read_file_smart·全文模式] ${p}\n${text}\n[REF ${refId}]`;
        }

        const opts = {
          keepHead: Number.isFinite(input.body_keep_lines) ? Math.max(0, Math.min(50, input.body_keep_lines)) : 4,
          keepTail: 3,
          bodyThreshold: 25
        };
        const ext = path.extname(p).toLowerCase();
        let res, mode;
        if (BRACE_EXTS.has(ext)) {
          res = compressBraced(origLines, opts, refId);
          mode = '结构骨架（花括号语言）';
        } else if (PY_EXTS.has(ext)) {
          res = compressPython(origLines, opts, refId);
          mode = '结构骨架（缩进语言）';
        } else {
          res = compressGeneric(origLines, refId);
          mode = res.passthrough ? '原样' : '首尾截断（缩进语言）';
        }

        const compText = res.out.join('\n');
        const compTok = estTokens(compText);
        const savedPct = origTok > 0 ? Math.round((1 - compTok / origTok) * 100) : 0;

        if (mode === '原样' || savedPct < 10) {
          appendStat({ time: new Date().toISOString(), tool: 'read_file_smart', path: p, mode: 'passthrough', origTok, compTok: origTok, savedPct: 0 });
          return `[ContextKeeper read_file_smart] ${p}\n文件共 ${origLines.length} 行 / ~${origTok} tokens，压缩收益不足，按原样返回。REF ${refId} 可供后续取回全文。\n\n${text}\n\n[REF ${refId}]`;
        }

        const totalOmitted = res.omitted.reduce((a, r) => a + (r[1] - r[0] + 1), 0);
        appendStat({
          time: new Date().toISOString(), tool: 'read_file_smart', path: p, mode,
          origTok, compTok, savedPct, omittedSections: res.omitted.length, omittedLines: totalOmitted
        });
        return `[ContextKeeper read_file_smart] ${p}\n` +
          `原文 ${origLines.length} 行 / ~${origTok} tokens → 压缩后 ${res.out.length} 行 / ~${compTok} tokens（节省 ${savedPct}%）\n` +
          `压缩模式：${mode}；省略 ${res.omitted.length} 处共 ${totalOmitted} 行，原文已存为 REF ${refId}。\n` +
          `用 load_context_ref(ref_id="${refId}", ranges="起-止,...") 可取回任意省略段；不传 ranges 返回完整原文。\n` +
          `提示：骨架保留了全部签名与结构，可直接基于其分析；分析中如需任何被省略段的完整实现，请主动按行号取回，不要基于签名推测。\n\n` +
          compText +
          `\n\n[read_file_smart 结束]`;
      } catch (e) {
        return '[ContextKeeper] 工具执行错误：' + String(e && e.message || e);
      }
    }
  },
  {
    name: 'load_context_ref',
    description: '取回原文：获取 read_file_smart 保存的文件中被省略的行区间或完整原文。ranges 参数为原文行号区间（1 起），格式如 "42-87,100-120" 或 "100"；不传 ranges 则返回完整原文。REF 原文持久化在工作区 .contextkeeper/refs/，窗口重载后仍可取回。',
    inputSchema: {
      type: 'object',
      properties: {
        ref_id: { type: 'string', description: 'read_file_smart 返回的 REF 编号，如 ck-1' },
        ranges: { type: 'string', description: '要取回的原文行号区间，如 "42-87,100-120"；省略则返回全文' }
      },
      required: ['ref_id']
    },
    handler: (input) => {
      try {
        const rec = getRef(String((input && input.ref_id) || ''));
        if (!rec) return `[ContextKeeper] 错误：REF 不存在或编号有误：${input && input.ref_id}`;
        const lines = rec.text.split(/\r?\n/);
        if (!input.ranges) {
          appendStat({ time: new Date().toISOString(), tool: 'load_context_ref', ref: input.ref_id, mode: 'full', chars: rec.text.length });
          return `[ContextKeeper load_context_ref·完整原文] ${rec.path}（${lines.length} 行）\n\n${rec.text}`;
        }
        const parts = String(input.ranges).split(',').map(s => s.trim()).filter(Boolean);
        const chunks = [];
        for (const part of parts) {
          const m = part.match(/^(\d+)(?:-(\d+))?$/);
          if (!m) return `[ContextKeeper] 错误：无法解析区间 "${part}"（格式应为 42-87 或 100）`;
          const a = parseInt(m[1], 10);
          const b = m[2] ? parseInt(m[2], 10) : a;
          const s = Math.max(1, Math.min(a, b));
          const e = Math.min(lines.length, Math.max(a, b));
          chunks.push(`----- 原文行 ${s}-${e} -----`);
          for (let i = s - 1; i <= e - 1; i++) chunks.push(lines[i]);
        }
        const outText = chunks.join('\n');
        appendStat({ time: new Date().toISOString(), tool: 'load_context_ref', ref: input.ref_id, ranges: String(input.ranges), chars: outText.length });
        return `[ContextKeeper load_context_ref] ${rec.path} 取回区间：${String(input.ranges)}\n\n${outText}`;
      } catch (e) {
        return '[ContextKeeper] 工具执行错误：' + String(e && e.message || e);
      }
    }
  },
  {
    name: 'contextkeeper_mode',
    description: 'ContextKeeper 全局模式开关（跨对话持久）。当用户在对话中输入 "/optimize"（含误拼 "/optmize"）时，调用本工具 mode=optimize 开启优化模式：此后所有对话中 read_file_smart 均做结构骨架压缩，减少 token 消耗；当用户输入 "/normal" 时，调用 mode=normal 恢复常规模式（全文读取，常规 token 消耗）。用户询问当前模式时用 mode=status 查询。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['optimize', 'normal', 'status'], description: 'optimize=优化模式（压缩省 token）；normal=常规模式（全文读取）；status=仅查询当前模式' }
      },
      required: ['mode']
    },
    handler: (input) => {
      try {
        const m = String((input && input.mode) || 'status').trim().toLowerCase();
        if (m === 'optimize' || m === 'normal') {
          setMode(m);
          appendStat({ time: new Date().toISOString(), tool: 'contextkeeper_mode', mode: m });
          try {
            vscode.window.showInformationMessage(m === 'optimize'
              ? 'ContextKeeper：已开启优化模式（压缩读取，省 token）'
              : 'ContextKeeper：已切换常规模式（全文读取）');
          } catch (e) {}
          return `[ContextKeeper] 已切换到${m === 'optimize' ? '优化模式：此后所有对话中 read_file_smart 将压缩读取，减少 token 消耗' : '常规模式：此后所有对话中 read_file_smart 将全文返回，恢复常规 token 消费'}（设置已持久化，跨对话/跨重启生效）。当前模式：${MODE}`;
        }
        if (m === 'status') {
          return `[ContextKeeper] 当前模式：${MODE === 'optimize' ? 'optimize（优化模式：压缩读取，省 token）' : 'normal（常规模式：全文读取）'}。切换方式：用户输入 /optimize 开启优化，输入 /normal 恢复常规。`;
        }
        return '[ContextKeeper] 错误：mode 必须是 optimize / normal / status';
      } catch (e) {
        return '[ContextKeeper] 工具执行错误：' + String(e && e.message || e);
      }
    }
  },
  {
    name: 'context_stats',
    description: '查询 ContextKeeper 省 token 统计：返回 read_file_smart 调用次数、压缩前后 token 总量与节省比例。用户询问"节省了多少 token"或需要效果数据时调用。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: () => {
      try {
        if (!fs.existsSync(STATS_PATH)) return '[ContextKeeper] 暂无统计数据（请先调用 read_file_smart）';
        const lines = fs.readFileSync(STATS_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
        let origTok = 0, compTok = 0, reads = 0, loads = 0;
        for (const ln of lines) {
          try {
            const r = JSON.parse(ln);
            if (r.tool === 'read_file_smart') { reads++; origTok += r.origTok || 0; compTok += r.compTok || 0; }
            else if (r.tool === 'load_context_ref') loads++;
          } catch (e) {}
        }
        const saved = origTok - compTok;
        const pct = origTok ? Math.round(saved / origTok * 100) : 0;
        return `[ContextKeeper token 节省统计]\n` +
          `read_file_smart 调用：${reads} 次；load_context_ref 按需取回：${loads} 次\n` +
          `原始内容合计 ~${origTok} tokens → 实际进入上下文 ~${compTok} tokens\n` +
          `累计节省 ~${saved} tokens（节省率 ${pct}%）\n` +
          `(统计文件：${STATS_PATH})`;
      } catch (e) {
        return '[ContextKeeper] 统计查询错误：' + String(e && e.message || e);
      }
    }
  }
];

// ---------- 激活 ----------

async function activate(context) {
  restoreRefSeq();
  loadMode();
  // 状态栏实时账单：底部常驻显示模式 + 累计节省；点击弹出账单摘要
  try {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'contextkeeper.status';
    loadSavedTotal();
    updateStatusBar();
    statusBar.show();
    const cmd = vscode.commands.registerCommand('contextkeeper.status', () => {
      const msg = `ContextKeeper 账单：当前 ${MODE === 'optimize' ? '优化' : '常规'}模式，累计节省 ${savedTotal.toLocaleString()} tokens。输入 /optimize 或 /normal 切换模式。`;
      vscode.window.showInformationMessage(msg);
    });
    if (context && context.subscriptions && context.subscriptions.push) context.subscriptions.push(statusBar, cmd);
  } catch (e) {
    try { vscode.window.showErrorMessage('ContextKeeper 状态栏初始化失败：' + String(e && e.message || e)); } catch (e2) {}
  }
  if (!vscode.trae || typeof vscode.trae.registerMcpProvider !== 'function') {
    vscode.window.showErrorMessage('ContextKeeper: registerMcpProvider 不可用');
    return;
  }
  try {
    const server = await vscode.trae.registerMcpProvider('contextkeeper', 'ContextKeeper', tools);
    try { await server.whenReady(); } catch (e) {}
    vscode.window.showInformationMessage('ContextKeeper 已启动（' + (MODE === 'optimize' ? '优化模式' : '常规模式') + '）：read_file_smart / load_context_ref / context_stats / contextkeeper_mode 就绪');
  } catch (e) {
    vscode.window.showErrorMessage('ContextKeeper 注册失败：' + String(e && e.message || e));
  }
}

function deactivate() {}

module.exports = { activate, deactivate, __test: { compressBraced, compressPython, compressGeneric, estTokens, buildBraceBlocks, buildPythonBlocks, cleanupOut, BRACE_EXTS, PY_EXTS, saveRef, getRef, refsDir, setMode, loadMode, getMode } };
