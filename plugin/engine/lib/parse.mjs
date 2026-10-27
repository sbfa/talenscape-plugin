// Turns one file into graph pieces using Tree-sitter (runs locally, no AI involved).
// Returns { symbols, refs }:
//   symbols: { kind, name, qname, start, end, parent }  (parent = index into symbols, or -1 for the file)
//   refs:    { from, kind, target, line }                (from = symbol index, or -1 for the file)

import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';
import { parseSkill } from '../skills.mjs';

const require = createRequire(import.meta.url);
const GRAMMARS = {
  js: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  ts: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  py: 'tree-sitter-python/tree-sitter-python.wasm',
};
const FUNC_TYPES = new Set(['function_expression', 'function', 'arrow_function', 'generator_function']);
const MAX_QNAME = 60;

let parsers;
async function getParsers() {
  if (!parsers) {
    await Parser.init();
    parsers = {};
    for (const [lang, file] of Object.entries(GRAMMARS)) {
      const p = new Parser();
      p.setLanguage(await Language.load(require.resolve(file)));
      parsers[lang] = p;
    }
  }
  return parsers;
}

const lastPart = (s) => s.split(/[.:]/).filter(Boolean).pop() ?? s;
// Calls like `x.name()` are marked with a leading dot: they only link to nearby code.
const member = (name) => (name ? '.' + name : name);
const unquote = (s) => s.replace(/^[`'"]|[`'"]$/g, '');
const line = (n) => n.startPosition.row + 1;
const endLine = (n) => n.endPosition.row + 1;

// moduleName names anonymous `module.exports = function () {}` (the file name, or folder for index files).
export async function parseFile(lang, text, moduleName = 'module') {
  if (lang === 'md') return parseMarkdown(text);
  const p = (await getParsers())[lang];
  if (!p) return { symbols: [], refs: [] };
  const tree = p.parse(text);
  try {
    return lang === 'py' ? walkPython(tree.rootNode) : walkJs(tree.rootNode, moduleName);
  } finally {
    tree.delete();
  }
}

function makeOut() {
  const symbols = [];
  const refs = [];
  return {
    symbols, refs,
    sym(kind, name, node, parent) {
      const parentQ = parent >= 0 ? symbols[parent].qname + '.' : '';
      symbols.push({ kind, name, qname: (parentQ + name).slice(0, MAX_QNAME), start: line(node), end: endLine(node), parent });
      return symbols.length - 1;
    },
    ref(from, kind, target, node) {
      if (target) refs.push({ from, kind, target, line: line(node) });
    },
  };
}

// ---------- JavaScript / TypeScript ----------

function walkJs(root, moduleName) {
  const out = makeOut();
  const claimed = new Set(); // function nodes already turned into a named symbol
  const defaults = new Set(); // names the file exports by default

  const visit = (node, cur) => {
    let next = cur;
    const t = node.type;
    const name = node.childForFieldName('name');

    if ((t === 'class_declaration' || t === 'abstract_class_declaration' || t === 'class' || t === 'interface_declaration') && name) {
      next = out.sym('class', name.text, node, cur);
      for (const h of node.namedChildren) {
        if (h.type !== 'class_heritage' && h.type !== 'extends_type_clause') continue;
        for (const target of heritageNames(h)) out.ref(next, 'inherits', target, h);
      }
    } else if ((t === 'function_declaration' || t === 'generator_function_declaration') && name) {
      next = out.sym('function', name.text, node, cur);
    } else if (t === 'method_definition' && name) {
      next = out.sym('method', name.text, node, cur);
    } else if (FUNC_TYPES.has(t) && !claimed.has(node.id) && name) {
      next = out.sym('function', name.text, node, cur);
    } else if (t === 'variable_declarator' || t === 'pair' || t === 'public_field_definition' || t === 'field_definition') {
      const value = node.childForFieldName('value');
      const key = name ?? node.childForFieldName('key') ?? node.childForFieldName('property');
      if (value && FUNC_TYPES.has(value.type) && key) {
        claimed.add(value.id);
        next = out.sym(t === 'variable_declarator' ? 'function' : 'method', unquote(key.text), node, cur);
      }
    } else if (t === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      if (left && right && FUNC_TYPES.has(right.type)) {
        claimed.add(right.id);
        const own = right.childForFieldName('name')?.text;
        const leftText = left.text.replace(/\s+/g, '');
        const isExport = /^(module\.)?exports$/.test(leftText);
        const fname = isExport ? own ?? moduleName : lastPart(leftText);
        const i = out.sym('function', fname, node, cur);
        if (isExport) out.symbols[i].main = true;
        if (!isExport && leftText.includes('.')) out.symbols[i].qname = leftText.replace(/\.prototype\./g, '.').slice(0, MAX_QNAME);
        next = i;
      } else if (left && right?.type === 'identifier' && /^(module\.)?exports$/.test(left.text.replace(/\s+/g, ''))) {
        defaults.add(right.text);
      }
    } else if (t === 'import_statement' || (t === 'export_statement' && node.childForFieldName('source'))) {
      const spec = unquote(node.childForFieldName('source')?.text ?? '');
      out.ref(cur, 'imports', spec, node);
      bindImports(out, cur, node, spec);
    } else if (t === 'export_statement' && /^export\s+default\b/.test(node.text)) {
      const d = node.childForFieldName('declaration') ?? node.childForFieldName('value');
      const n = d?.type === 'identifier' ? d : d?.childForFieldName('name');
      if (n) defaults.add(n.text);
    } else if (t === 'call_expression') {
      const fn = node.childForFieldName('function');
      const args = node.childForFieldName('arguments');
      if ((fn?.type === 'identifier' && fn.text === 'require') || fn?.type === 'import') {
        const first = args?.namedChildren[0];
        if (first?.type === 'string') {
          out.ref(cur, 'imports', unquote(first.text), node);
          // `const X = require('./x')`: calls to X go to what ./x exports
          const decl = node.parent?.type === 'variable_declarator' ? node.parent.childForFieldName('name') : null;
          if (decl?.type === 'identifier') out.ref(cur, 'binds', `${decl.text} ${unquote(first.text)}`, node);
        }
      } else if (fn?.type === 'identifier') {
        out.ref(cur, 'calls', fn.text, node);
      } else if (fn?.type === 'member_expression') {
        const obj = fn.childForFieldName('object'), prop = fn.childForFieldName('property')?.text;
        // fn.call(this, …) / fn.apply(…) / fn.bind(this) run fn itself.
        if (obj?.type === 'identifier' && /^(call|apply|bind)$/.test(prop ?? '')) out.ref(cur, 'calls', obj.text, node);
        else out.ref(cur, 'calls', member(prop), node);
      }
    } else if (t === 'new_expression') {
      const c = node.childForFieldName('constructor');
      if (c) out.ref(cur, 'calls', lastPart(c.text), node);
    }

    for (const child of node.namedChildren) visit(child, next);
  };
  visit(root, -1);
  for (const s of out.symbols) if (s.parent === -1 && defaults.has(s.name)) s.main = true;
  return { symbols: out.symbols, refs: out.refs };
}

// `import X from`, `import * as X from`, `import { A as B } from` → binds refs ("B spec A").
function bindImports(out, cur, node, spec) {
  const clause = node.namedChildren.find((c) => c.type === 'import_clause');
  for (const c of clause?.namedChildren ?? []) {
    if (c.type === 'identifier') out.ref(cur, 'binds', `${c.text} ${spec}`, node);
    else if (c.type === 'namespace_import') {
      const id = c.namedChildren.find((x) => x.type === 'identifier');
      if (id) out.ref(cur, 'binds', `${id.text} ${spec}`, node);
    } else if (c.type === 'named_imports') {
      for (const s of c.namedChildren) {
        const orig = s.childForFieldName('name')?.text, alias = s.childForFieldName('alias')?.text;
        if (orig && alias && orig !== alias) out.ref(cur, 'binds', `${alias} ${spec} ${orig}`, node);
      }
    }
  }
}

function heritageNames(h) {
  const names = [];
  const grab = (n) => {
    if (n.type === 'identifier' || n.type === 'type_identifier') names.push(n.text);
    else if (n.type === 'member_expression' || n.type === 'nested_type_identifier') names.push(lastPart(n.text));
    else if (n.type === 'generic_type') grab(n.namedChildren[0]);
    else for (const c of n.namedChildren) grab(c);
  };
  grab(h);
  return names;
}

// ---------- Python ----------

function walkPython(root) {
  const out = makeOut();
  const visit = (node, cur) => {
    let next = cur;
    const t = node.type;
    const name = node.childForFieldName('name');

    if (t === 'class_definition' && name) {
      next = out.sym('class', name.text, node, cur);
      const sup = node.childForFieldName('superclasses');
      for (const s of sup?.namedChildren ?? []) {
        if (s.type === 'identifier' || s.type === 'attribute') out.ref(next, 'inherits', lastPart(s.text), s);
      }
    } else if (t === 'function_definition' && name) {
      const inClass = cur >= 0 && out.symbols[cur].kind === 'class';
      next = out.sym(inClass ? 'method' : 'function', name.text, node, cur);
    } else if (t === 'import_statement') {
      for (const c of node.namedChildren) {
        const mod = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
        if (mod) out.ref(cur, 'imports', 'py:' + mod.text, node);
      }
    } else if (t === 'import_from_statement') {
      const mod = node.childForFieldName('module_name')?.text ?? '';
      out.ref(cur, 'imports', 'py:' + mod, node);
      // `from . import views` / `from pkg import submodule` may name modules too
      for (const c of node.childrenForFieldName('name')) {
        const n = c.type === 'aliased_import' ? c.childForFieldName('name') : c;
        if (n) out.ref(cur, 'imports', 'py:' + mod + (mod.endsWith('.') ? '' : '.') + n.text + '?', node);
      }
    } else if (t === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'identifier') out.ref(cur, 'calls', fn.text, node);
      else if (fn?.type === 'attribute') out.ref(cur, 'calls', member(fn.childForFieldName('attribute')?.text), node);
    }

    for (const child of node.namedChildren) visit(child, next);
  };
  visit(root, -1);
  return { symbols: out.symbols, refs: out.refs };
}

// ---------- Markdown (docs and skills) ----------

const PATH_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:mjs|cjs|js|jsx|ts|tsx|py|md|json|sql|html|css|toml|ya?ml))\b/g;
const TICK_RE = /`([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\(\))?`/g;

function parseMarkdown(text) {
  const out = makeOut();
  const lines = text.split('\n');
  let from = -1;
  const { meta } = parseSkill(text);
  if (meta?.name && meta?.description) {
    out.symbols.push({ kind: 'skill', name: meta.name, qname: meta.name, start: 1, end: lines.length, parent: -1 });
    from = 0;
  }
  lines.forEach((l, i) => {
    const at = { startPosition: { row: i } };
    for (const m of l.matchAll(PATH_RE)) out.ref(from, 'mentions', 'path:' + m[1], at);
    for (const m of l.matchAll(TICK_RE)) out.ref(from, 'mentions', lastPart(m[1]), at);
  });
  return { symbols: out.symbols, refs: out.refs };
}
