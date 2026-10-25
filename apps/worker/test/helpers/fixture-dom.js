// 测试用 DOM 树：支持本组 fixture 所需的 tag/id/class/属性、后代和逗号选择器。
// 提取器仍执行实际编译表达式；不直接伪造提取结果。
export function fixtureDocument(tree) {
  class Element {
    constructor(input, parentElement = null) {
      this.tagName = input[0].toUpperCase(); this.attrs = input[1]; this.parentElement = parentElement;
      this.nodes = input.slice(2).map(child => Array.isArray(child) ? new Element(child, this) : child);
    }
    get children() { return this.nodes.filter(n => n instanceof Element); }
    get textContent() { return this.nodes.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
    get innerText() { return this.textContent; }
    get id() { return this.attrs.id ?? ''; }
    get hidden() { return Object.hasOwn(this.attrs, 'hidden'); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    matches(selector) {
      return selector.split(',').some(part => {
        const tokens = part.trim().match(/(?:\[[^\]]*\]|[^\s[])+/g);
        const match = (node, partSelector) => {
          let ok = true;
          partSelector = partSelector.replace(/\[([^\]=*]+)(\*?=)?(?:"([^"]*)"|'([^']*)'|([^\]]*))?\]/g, (_, key, op, a, b, c) => {
            const value = node.getAttribute(key); const expected = a ?? b ?? c;
            ok &&= op === '=' ? value === expected : op === '*=' ? value?.includes(expected) === true : value !== null;
            return '';
          });
          partSelector = partSelector.replace(/([.#])([\w-]+)/g, (_, kind, value) => {
            ok &&= kind === '#' ? node.id === value : (node.attrs.class ?? '').split(/\s+/).includes(value); return '';
          });
          return ok && (!partSelector || partSelector === '*' || node.tagName === partSelector.toUpperCase());
        };
        if (!tokens?.length || !match(this, tokens.at(-1))) return false;
        let ancestor = this.parentElement;
        for (let i = tokens.length - 2; i >= 0; i--) {
          while (ancestor && !match(ancestor, tokens[i])) ancestor = ancestor.parentElement;
          if (!ancestor) return false;
          ancestor = ancestor.parentElement;
        }
        return true;
      });
    }
    closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
    querySelectorAll(selector) {
      return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const document = new Element(['document', {}, tree]); document.title = 'GitHub'; return document;
}
