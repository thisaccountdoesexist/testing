// Renders Claude Code prompt fragments. Their bodies are JS template-literal
// text with ${...} expressions (identifiers, calls, ternaries, .map/.join, arrow
// functions). We interpret a small JS subset ourselves instead of using eval, so a
// downloaded prompt file can never execute code.

const UNDEF = undefined;
const SAFE_METHODS = {
  string: new Set(['trim', 'toLowerCase', 'toUpperCase', 'startsWith', 'endsWith', 'includes', 'slice', 'split', 'repeat', 'padStart', 'padEnd', 'replaceAll', 'replace', 'indexOf']),
  array: new Set(['join', 'map', 'filter', 'includes', 'slice', 'some', 'every', 'find', 'concat', 'indexOf', 'flat']),
  number: new Set(['toFixed', 'toString', 'toLocaleString']),
};

class ParseError extends Error {}

// Character-level recursive-descent parser. Closing backticks and quotes are
// ambiguous (the extractor un-escapes them), so each candidate close is a decision
// point; `decisions` replays a choice vector and parseEmbedded backtracks over it.
class Parser {
  constructor(src, pos, decisions) {
    this.s = src;
    this.p = pos;
    this.decisions = decisions;
    this.taken = [];
  }
  err(msg) { throw new ParseError(`${msg} at ${this.p}`); }
  ws() { while (this.p < this.s.length && /\s/.test(this.s[this.p])) this.p++; }
  peek(str) { return this.s.startsWith(str, this.p); }
  eat(str) { this.ws(); if (this.peek(str)) { this.p += str.length; return true; } return false; }
  expect(str) { if (!this.eat(str)) this.err(`expected '${str}'`); }

  expression() { return this.ternary(); }
  ternary() {
    const cond = this.binary(0);
    this.ws();
    if (this.peek('?') && !this.peek('??') && !this.peek('?.')) {
      this.p++;
      const a = this.ternary();
      this.expect(':');
      const b = this.ternary();
      return { t: 'cond', cond, a, b };
    }
    return cond;
  }
  static LEVELS = [['||', '??'], ['&&'], ['===', '!==', '==', '!='], ['<=', '>=', '<', '>'], ['+', '-'], ['*', '/', '%']];
  binary(level) {
    if (level >= Parser.LEVELS.length) return this.unary();
    let left = this.binary(level + 1);
    for (;;) {
      this.ws();
      const op = this.matchOp(level);
      if (!op) break;
      this.p += op.length;
      left = { t: 'bin', op, left, right: this.binary(level + 1) };
    }
    return left;
  }
  // Operators within a level are listed longest-first, so `===` wins over `==`.
  matchOp(level) {
    for (const o of Parser.LEVELS[level]) {
      if (!this.peek(o)) continue;
      const next = this.s[this.p + o.length];
      if ((o === '+' || o === '-') && next === o) return null;
      if (o === '/' && (next === '/' || next === '*')) return null;
      if ((o === '<' || o === '>') && next === o) return null;
      return o;
    }
    return null;
  }
  unary() {
    this.ws();
    if (this.peek('!') && !this.peek('!=')) { this.p++; return { t: 'not', e: this.unary() }; }
    if (this.peek('-') && !this.peek('--')) { this.p++; return { t: 'neg', e: this.unary() }; }
    if (/^void\b/.test(this.s.slice(this.p, this.p + 5))) { this.p += 4; this.unary(); return { t: 'lit', v: UNDEF }; }
    if (/^typeof\b/.test(this.s.slice(this.p, this.p + 7))) { this.p += 6; return { t: 'typeof', e: this.unary() }; }
    return this.postfix(this.primary());
  }
  postfix(node) {
    for (;;) {
      this.ws();
      if (this.peek('?.')) { this.p += 2; node = { t: 'member', obj: node, name: this.ident(), optional: true }; continue; }
      if (this.peek('.') && /[A-Za-z_$]/.test(this.s[this.p + 1] || '')) { this.p++; node = { t: 'member', obj: node, name: this.ident() }; continue; }
      if (this.peek('(')) { this.p++; node = { t: 'call', callee: node, args: this.list(')') }; continue; }
      if (this.peek('[')) { this.p++; const idx = this.expression(); this.expect(']'); node = { t: 'index', obj: node, idx }; continue; }
      return node;
    }
  }
  list(close) {
    const items = [];
    if (this.eat(close)) return items;
    for (;;) {
      items.push(this.expression());
      if (this.eat(close)) return items;
      this.expect(',');
    }
  }
  ident() {
    const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.p, this.p + 200));
    if (!m) this.err('expected identifier');
    this.p += m[0].length;
    return m[0];
  }
  primary() {
    this.ws();
    const c = this.s[this.p];
    if (c === undefined) this.err('unexpected end');
    if (c === '`') return this.template();
    if (c === '"' || c === "'") return this.quoted(c);
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?(e\d+)?/.exec(this.s.slice(this.p, this.p + 40));
      this.p += m[0].length;
      return { t: 'lit', v: Number(m[0]) };
    }
    if (c === '[') { this.p++; return { t: 'array', items: this.list(']') }; }
    if (c === '{') { this.p++; return this.object(); }
    if (c === '(') {
      const save = this.p;
      try {
        this.p++;
        const params = [];
        if (!this.eat(')')) {
          for (;;) { this.ws(); params.push(this.ident()); if (this.eat(')')) break; this.expect(','); }
        }
        this.expect('=>');
        return { t: 'arrow', params, body: this.arrowBody() };
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.p = save + 1;
        const inner = this.expression();
        this.expect(')');
        return inner;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      const name = this.ident();
      if (name === 'true') return { t: 'lit', v: true };
      if (name === 'false') return { t: 'lit', v: false };
      if (name === 'null') return { t: 'lit', v: null };
      if (name === 'undefined') return { t: 'lit', v: UNDEF };
      const save = this.p;
      if (this.eat('=>')) return { t: 'arrow', params: [name], body: this.arrowBody() };
      this.p = save;
      return { t: 'id', name };
    }
    this.err(`unexpected '${c}'`);
  }
  arrowBody() {
    this.ws();
    if (this.peek('{')) this.err('block-bodied arrows are not supported');
    return this.expression();
  }
  object() {
    const entries = [];
    if (this.eat('}')) return { t: 'object', entries };
    for (;;) {
      this.ws();
      const key = this.s[this.p] === '"' || this.s[this.p] === "'" ? this.quoted(this.s[this.p]).v : this.ident();
      const value = this.eat(':') ? this.expression() : { t: 'id', name: key };
      entries.push([key, value]);
      if (this.eat('}')) return { t: 'object', entries };
      this.expect(',');
    }
  }
  // Like template(), a closing quote may really be an un-escaped apostrophe.
  closes() {
    const close = this.decisions[this.taken.length] ?? true;
    this.taken.push(close);
    return close;
  }
  quoted(q) {
    this.p++;
    let out = '';
    while (this.p < this.s.length) {
      const c = this.s[this.p];
      if (c === q) {
        this.p++;
        if (this.closes()) return { t: 'lit', v: out };
        out += c;
      } else if (c === '\\' && this.p + 1 < this.s.length) {
        const n = this.s[this.p + 1];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        this.p += 2;
      } else {
        out += c;
        this.p++;
      }
    }
    this.err('unterminated string');
  }
  template() {
    this.p++;
    const parts = [];
    let buf = '';
    while (this.p < this.s.length) {
      const c = this.s[this.p];
      if (c === '$' && this.s[this.p + 1] === '{') {
        if (buf) { parts.push(buf); buf = ''; }
        this.p += 2;
        parts.push(this.expression());
        this.expect('}');
        continue;
      }
      if (c === '`') {
        this.p++;
        if (this.closes()) { if (buf) parts.push(buf); return { t: 'tpl', parts }; }
        buf += '`';
        continue;
      }
      buf += c;
      this.p++;
    }
    this.err('unterminated template');
  }
}

// Parse one `${...}` expression starting right after the `${`.
// Returns { ast, end } where end is the index just past the closing `}`.
function parseEmbedded(src, start) {
  let decisions = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    const p = new Parser(src, start, decisions);
    try {
      const ast = p.expression();
      p.expect('}');
      return { ast, end: p.p };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      const taken = p.taken;
      let i = taken.length - 1;
      while (i >= 0 && taken[i] === false) i--;
      if (i < 0) return null;
      decisions = taken.slice(0, i).concat([false]);
    }
  }
  return null;
}

class Evaluator {
  constructor(scope, unresolved) {
    this.scope = scope;
    this.unresolved = unresolved;
  }
  lookup(name, locals) {
    if (locals && Object.prototype.hasOwnProperty.call(locals, name)) return locals[name];
    const v = this.scope(name);
    if (v === UNDEF) this.unresolved.add(name);
    return v;
  }
  ev(n, locals) {
    switch (n.t) {
      case 'lit': return n.v;
      case 'id': return this.lookup(n.name, locals);
      case 'tpl': return n.parts.map((part) => (typeof part === 'string' ? part : toText(this.ev(part, locals)))).join('');
      case 'array': return n.items.map((i) => this.ev(i, locals));
      case 'object': return Object.fromEntries(n.entries.map(([k, v]) => [k, this.ev(v, locals)]));
      case 'not': return !this.ev(n.e, locals);
      case 'neg': return -this.ev(n.e, locals);
      case 'typeof': return typeof this.ev(n.e, locals);
      case 'cond': return this.ev(n.cond, locals) ? this.ev(n.a, locals) : this.ev(n.b, locals);
      case 'arrow': return (...args) => {
        const inner = Object.create(null);
        if (locals) Object.assign(inner, locals);
        n.params.forEach((p, i) => { inner[p] = args[i]; });
        return this.ev(n.body, inner);
      };
      case 'bin': return this.bin(n, locals);
      case 'member': return getProp(this.ev(n.obj, locals), n.name);
      case 'index': return getProp(this.ev(n.obj, locals), this.ev(n.idx, locals));
      case 'call': return this.call(n, locals);
      default: throw new Error(`unknown node ${n.t}`);
    }
  }
  bin(n, locals) {
    if (n.op === '&&') { const l = this.ev(n.left, locals); return l ? this.ev(n.right, locals) : l; }
    if (n.op === '||') { const l = this.ev(n.left, locals); return l ? l : this.ev(n.right, locals); }
    if (n.op === '??') { const l = this.ev(n.left, locals); return l ?? this.ev(n.right, locals); }
    const l = this.ev(n.left, locals);
    const r = this.ev(n.right, locals);
    switch (n.op) {
      case '===': return l === r;
      case '!==': return l !== r;
      case '==': return l == r; // eslint-disable-line eqeqeq
      case '!=': return l != r; // eslint-disable-line eqeqeq
      case '<': return l < r;
      case '>': return l > r;
      case '<=': return l <= r;
      case '>=': return l >= r;
      case '+': return (typeof l === 'string' || typeof r === 'string') ? toText(l) + toText(r) : l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return l / r;
      case '%': return l % r;
      default: throw new Error(`bad op ${n.op}`);
    }
  }
  call(n, locals) {
    if (n.callee.t === 'member') {
      const obj = this.ev(n.callee.obj, locals);
      const name = n.callee.name;
      const kind = Array.isArray(obj) ? 'array' : typeof obj;
      const args = n.args.map((a) => this.ev(a, locals));
      if (SAFE_METHODS[kind]?.has(name)) return obj[name](...args);
      const fn = getProp(obj, name);
      return typeof fn === 'function' ? fn(...args) : UNDEF;
    }
    const fn = this.ev(n.callee, locals);
    const args = n.args.map((a) => this.ev(a, locals));
    return typeof fn === 'function' ? fn(...args) : UNDEF;
  }
}

function getProp(obj, key) {
  if (obj === null || obj === UNDEF) return UNDEF;
  if (typeof obj === 'string' || Array.isArray(obj)) return key === 'length' ? obj.length : (typeof key === 'number' ? obj[key] : UNDEF);
  if (typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  return UNDEF;
}

function toText(v) {
  if (v === UNDEF || v === null || v === false) return '';
  if (Array.isArray(v)) return v.map(toText).join(',');
  if (typeof v === 'object' || typeof v === 'function') return '';
  return String(v);
}

/**
 * Render a fragment body.
 * @param {string} src template text
 * @param {(name: string) => any} scope variable lookup; return undefined when unknown
 * @param {{ keepUnresolved?: boolean }} [opts] keep `${NAME}` text for unknown simple placeholders
 * @returns {{ text: string, unresolved: string[], errors: string[] }}
 */
export function renderTemplate(src, scope, opts = {}) {
  const unresolved = new Set();
  const errors = [];
  const evaluator = new Evaluator(scope, unresolved);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const j = src.indexOf('${', i);
    if (j < 0) { out += src.slice(i); break; }
    out += src.slice(i, j);
    const parsed = parseEmbedded(src, j + 2);
    if (!parsed) {
      errors.push(`could not parse expression at offset ${j}`);
      out += '${';
      i = j + 2;
      continue;
    }
    const raw = src.slice(j, parsed.end);
    try {
      const before = unresolved.size;
      const value = evaluator.ev(parsed.ast);
      const simple = parsed.ast.t === 'id' || (parsed.ast.t === 'call' && parsed.ast.callee.t === 'id');
      if (opts.keepUnresolved && simple && value === UNDEF && unresolved.size > before) out += raw;
      else out += toText(value);
    } catch (e) {
      errors.push(`${raw.slice(0, 60)}: ${e.message}`);
      out += raw;
    }
    i = parsed.end;
  }
  return { text: out, unresolved: [...unresolved], errors };
}
