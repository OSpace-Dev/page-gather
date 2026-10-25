// 仅编译随部署安装的可信提取函数；绝不把页面字符串或用户脚本拼入表达式。
export const expression = fn => `(${fn.toString()})()`;
export function readListDom() {
  return {
    url: location.href,
    challenge: Boolean(document.querySelector('#challenge-running, #challenge-form, .js-abuse-rate-limit, [data-testid="captcha"]')) || /just a moment|verify you are human|rate limit|abuse detection/i.test(document.title),
    listPresent: Boolean(document.querySelector('.explore-pjax-container, [data-hpc], main')),
    rows: Array.from(document.querySelectorAll('article.Box-row')).map(row => ({
      href: row.querySelector('h2 a')?.getAttribute('href'),
      description: row.querySelector('p')?.innerText?.trim() ?? null,
      language: row.querySelector('[itemprop="programmingLanguage"]')?.innerText?.trim() ?? null,
      stars: row.querySelector('a[href$="/stargazers"]')?.innerText?.trim() ?? null,
      dailyChange: row.querySelector('.float-sm-right')?.innerText?.trim() ?? null
    }))
  };
}
export function readRepoDom() {
  // 仅仓库概览页支持 README；wiki/issues/blob 中的 markdown 不属于本采集目标。
  const overview = /^\/[^/]+\/[^/]+\/?$/.test(new URL(location.href).pathname);
  let root = overview ? document.querySelector('#readme') : null;
  let article = root?.querySelector('article.markdown-body, .markdown-body');
  let pageHref = null;
  if (overview && !root) {
    const regions = [];
    for (const nav of document.querySelectorAll('nav[aria-label="Repository files"]')) {
      const header = nav.closest('[itemtype="https://schema.org/abstract"]');
      const region = header?.parentElement;
      const selected = Array.from(nav.querySelectorAll('a[aria-current="page"]'));
      // 已验证的现代 server DOM：语义 header 与正文为同一区域的两个直接子节点。
      if (nav.closest('[hidden], [aria-hidden="true"]') || !region || region.children.length !== 2 || region.children[0] !== header ||
          selected.length !== 1 || selected[0].textContent.trim() !== 'README' ||
          region.querySelectorAll('nav[aria-label="Repository files"]').length !== 1) continue;
      const articles = Array.from(region.children[1].querySelectorAll('article.markdown-body'));
      if (articles.length !== 1 || region.querySelectorAll('article.markdown-body').length !== 1 ||
          articles[0].closest('[hidden], [aria-hidden="true"]')) continue;
      regions.push({ root: region, article: articles[0] });
    }
    // 锚点来自实际 DOM；侧栏链接本身不能证明正文身份，必须先通过上述 header 关联。
    const anchor = Array.from(document.querySelectorAll('a[href="#readme-ov-file"]')).find(a => !a.closest('article, .markdown-body'));
    if (regions.length === 1 && anchor) {
      ({ root, article } = regions[0]);
      pageHref = new URL(anchor.getAttribute('href'), location.href).href;
    }
  }
  // 已知 server DOM 的 README header/metadata 链接；正文中的 blob 链接不代表来源。
  const candidates = Array.from(root?.querySelectorAll('a[href*="/blob/"]') ?? []).filter(a => {
    if (a.closest('article, .markdown-body')) return false;
    return Boolean(a.closest('.Box-header, .Box-title, [data-testid="readme-header"]')) &&
      /(?:^|\/)readme(?:\.[^/]+)?$/i.test((a.getAttribute('href') ?? '').split(/[?#]/)[0]);
  });
  const sources = [...new Set(candidates.map(a => a.getAttribute('href')))];
  // 只支持 GitHub 空仓库的明确 Quick setup 结构；一般 root 缺失一律未知。
  const empty = document.querySelector('#repo-content-pjax-container .git-empty');
  const absent = !root && Boolean(empty?.querySelector('h3')) && /quick setup/i.test(empty.innerText ?? '');
  return {
    url: location.href,
    challenge: Boolean(document.querySelector('#challenge-running, #challenge-form, .js-abuse-rate-limit, [data-testid="captcha"]')) || /just a moment|verify you are human|rate limit|abuse detection/i.test(document.title),
    repoPresent: Boolean(document.querySelector('[itemprop="name"] a, #repository-container-header, [data-testid="repository-container"]')),
    readmePresent: Boolean(root),
    absenceEvidence: absent ? 'github_empty_repository_quick_setup' : null,
    text: article?.innerText ?? null,
    fileHref: sources.length === 1 ? sources[0] : null,
    pageHref
  };
}
