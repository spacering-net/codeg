/*
 * GENERATED — do not edit. Built from browser-agent/ by
 * scripts/build-browser-agent.mjs (pnpm browser:agent).
 *
 * Bundles a vendored subset of Playwright (Apache-2.0). See
 * browser-agent/vendor/playwright/{VENDOR.md,LICENSE}.
 */
"use strict";
(() => {
  // browser-agent/vendor/playwright/isomorphic/ariaSnapshot.ts
  function hasPointerCursor(ariaNode) {
    return ariaNode.box.cursor === "pointer";
  }

  // browser-agent/vendor/playwright/isomorphic/stringUtils.ts
  var normalizedWhitespaceCache;
  function normalizeWhiteSpace(text) {
    let result = normalizedWhitespaceCache?.get(text);
    if (result === void 0) {
      result = text.replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " ");
      normalizedWhitespaceCache?.set(text, result);
    }
    return result;
  }
  function truncateDataUrl(url) {
    if (!url.startsWith("data:"))
      return url;
    const comma = url.indexOf(",");
    if (comma === -1)
      return url;
    return url.slice(0, comma + 1) + "\u2026";
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function longestCommonSubstring(s1, s2) {
    const n = s1.length;
    const m = s2.length;
    let maxLen = 0;
    let endingIndex = 0;
    const dp = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
          if (dp[i][j] > maxLen) {
            maxLen = dp[i][j];
            endingIndex = i;
          }
        }
      }
    }
    return s1.slice(endingIndex - maxLen, endingIndex);
  }
  var ansiRegex = new RegExp("([\\u001B\\u009B][[\\]()#?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{0,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])))", "g");

  // browser-agent/vendor/playwright/isomorphic/yaml.ts
  function yamlEscapeKeyIfNeeded(str) {
    if (!yamlStringNeedsQuotes(str))
      return str;
    return `'` + str.replace(/'/g, `''`) + `'`;
  }
  function yamlEscapeValueIfNeeded(str) {
    if (!yamlStringNeedsQuotes(str))
      return str;
    return '"' + str.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, (c) => {
      switch (c) {
        case "\\":
          return "\\\\";
        case '"':
          return '\\"';
        case "\b":
          return "\\b";
        case "\f":
          return "\\f";
        case "\n":
          return "\\n";
        case "\r":
          return "\\r";
        case "	":
          return "\\t";
        default:
          const code = c.charCodeAt(0);
          return "\\x" + code.toString(16).padStart(2, "0");
      }
    }) + '"';
  }
  function yamlStringNeedsQuotes(str) {
    if (str.length === 0)
      return true;
    if (/^\s|\s$/.test(str))
      return true;
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str))
      return true;
    if (/^-/.test(str))
      return true;
    if (/[\n:](\s|$)/.test(str))
      return true;
    if (/\s#/.test(str))
      return true;
    if (/[\n\r]/.test(str))
      return true;
    if (/^[&*\],?!>|@"'#%]/.test(str))
      return true;
    if (/[{}`]/.test(str))
      return true;
    if (/^\[/.test(str))
      return true;
    if (!isNaN(Number(str)) || ["y", "n", "yes", "no", "true", "false", "on", "off", "null"].includes(str.toLowerCase()))
      return true;
    return false;
  }

  // browser-agent/vendor/playwright/isomorphic/ariaSnapshotRenderer.ts
  function renderAriaSnapshotAsYaml(snapshot2, options = {}) {
    const lines = [];
    const includeText = options.convertStringsToRegex ? textContributesInfo : () => true;
    const renderString = options.convertStringsToRegex ? convertToBestGuessRegex : (str) => str;
    const visitText = (text, depth) => {
      const escaped = yamlEscapeValueIfNeeded(renderString(text));
      if (escaped)
        lines.push(indent(depth) + "- text: " + escaped);
    };
    const createKey = (node) => {
      let key = node.role;
      if (node.name && node.name.length <= 900) {
        const name = renderString(node.name);
        if (name) {
          const stringifiedName = name.startsWith("/") && name.endsWith("/") ? name : JSON.stringify(name);
          key += " " + stringifiedName;
        }
      }
      if (node.checked === "mixed")
        key += ` [checked=mixed]`;
      if (node.checked === true)
        key += ` [checked]`;
      if (node.disabled)
        key += ` [disabled]`;
      if (node.expanded)
        key += ` [expanded]`;
      if (node.active)
        key += ` [active]`;
      if (node.invalid === "grammar" || node.invalid === "spelling")
        key += ` [invalid=${node.invalid}]`;
      if (node.invalid === true)
        key += ` [invalid]`;
      if (node.level)
        key += ` [level=${node.level}]`;
      if (node.pressed === "mixed")
        key += ` [pressed=mixed]`;
      if (node.pressed === true)
        key += ` [pressed]`;
      if (node.selected === true)
        key += ` [selected]`;
      if (node.ariaHidden)
        key += ` [aria-hidden]`;
      if (node.ref) {
        key += ` [ref=${node.ref}]`;
        if (node.cursor === "pointer")
          key += " [cursor=pointer]";
      }
      if (node.box)
        key += ` [box=${node.box.x},${node.box.y},${node.box.width},${node.box.height}]`;
      return key;
    };
    const visit = (node, depth) => {
      if (node.role === "text") {
        visitText(node.text || "", depth);
        return;
      }
      options.lineToNode?.set(lines.length, node);
      const escapedKey = indent(depth) + "- " + yamlEscapeKeyIfNeeded(createKey(node));
      const props = [];
      if (node.url !== void 0)
        props.push(["url", node.url]);
      if (node.placeholder !== void 0)
        props.push(["placeholder", node.placeholder]);
      if (node.text === void 0 && !props.length && !node.children?.length) {
        lines.push(escapedKey);
      } else if (node.text !== void 0 && !props.length) {
        if (includeText(node, node.text))
          lines.push(escapedKey + ": " + yamlEscapeValueIfNeeded(renderString(node.text)));
        else
          lines.push(escapedKey);
      } else {
        lines.push(escapedKey + ":");
        for (const [name, value] of props)
          lines.push(indent(depth + 1) + "- /" + name + ": " + yamlEscapeValueIfNeeded(value));
        if (node.text !== void 0) {
          visitText(includeText(node, node.text) ? node.text : "", depth + 1);
        } else {
          for (const child of node.children || []) {
            if (typeof child === "string")
              visitText(includeText(node, child) ? child : "", depth + 1);
            else
              visit(child, depth + 1);
          }
        }
      }
    };
    for (const node of snapshot2)
      visit(node, 0);
    return lines.join("\n");
  }
  function indent(depth) {
    return "  ".repeat(depth);
  }
  function convertToBestGuessRegex(text) {
    const dynamicContent = [
      // 550e8400-e29b-41d4-a716-446655440000
      { regex: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/, replacement: "[0-9a-fA-F-]+" },
      // 2mb
      { regex: /\b[\d,.]+[bkmBKM]+\b/, replacement: "[\\d,.]+[bkmBKM]+" },
      // 2ms, 20s
      { regex: /\b\d+[hmsp]+\b/, replacement: "\\d+[hmsp]+" },
      { regex: /\b[\d,.]+[hmsp]+\b/, replacement: "[\\d,.]+[hmsp]+" },
      // Do not replace single digits with regex by default.
      // 2+ digits: [Issue 22, 22.3, 2.33, 2,333]
      { regex: /\b\d+,\d+\b/, replacement: "\\d+,\\d+" },
      { regex: /\b\d+\.\d{2,}\b/, replacement: "\\d+\\.\\d+" },
      { regex: /\b\d{2,}\.\d+\b/, replacement: "\\d+\\.\\d+" },
      { regex: /\b\d{2,}\b/, replacement: "\\d+" }
    ];
    let pattern = "";
    let lastIndex = 0;
    const combinedRegex = new RegExp(dynamicContent.map((r) => "(" + r.regex.source + ")").join("|"), "g");
    text.replace(combinedRegex, (match, ...args) => {
      const offset = args[args.length - 2];
      const groups = args.slice(0, -2);
      pattern += escapeRegExp(text.slice(lastIndex, offset));
      for (let i = 0; i < groups.length; i++) {
        if (groups[i]) {
          const { replacement } = dynamicContent[i];
          pattern += replacement;
          break;
        }
      }
      lastIndex = offset + match.length;
      return match;
    });
    if (!pattern)
      return text;
    pattern += escapeRegExp(text.slice(lastIndex));
    return String(new RegExp(pattern));
  }
  function textContributesInfo(node, text) {
    if (!text.length)
      return false;
    if (!node.name)
      return true;
    const substr = text.length <= 200 && node.name.length <= 200 ? longestCommonSubstring(text, node.name) : "";
    let filtered = text;
    while (substr && filtered.includes(substr))
      filtered = filtered.replace(substr, "");
    return filtered.trim().length / text.length > 0.1;
  }

  // browser-agent/vendor/playwright/injected/ariaSnapshotDistiller.ts
  function distillAriaSnapshot(snapshot2, options) {
    runPlugins(snapshot2, options.mode === "ai" ? aiPlugins : normalizePlugins, options);
  }
  function runPlugins(snapshot2, plugins, options) {
    const ctx = { snapshot: snapshot2, depth: -1, maxDepth: options.depth, ancestors: [], pendingContentRefs: /* @__PURE__ */ new Set() };
    const traverse = (node, depth) => {
      const children = [];
      const visitChild = (child) => {
        if (typeof child === "string") {
          children.push(child);
          return;
        }
        ctx.depth = depth + 1;
        for (const plugin of plugins) {
          const result = plugin.enter?.(child, ctx);
          if (result === "remove")
            return;
          if (result === "unwrap") {
            child.children.forEach(visitChild);
            return;
          }
        }
        traverse(child, depth + 1);
        ctx.depth = depth + 1;
        for (const plugin of plugins) {
          const result = plugin.exit?.(child, ctx);
          if (result === "remove")
            return;
          if (result === "unwrap") {
            children.push(...child.children);
            return;
          }
        }
        children.push(child);
      };
      ctx.ancestors.push(node);
      node.children.forEach(visitChild);
      ctx.ancestors.pop();
      node.children = children;
    };
    for (const plugin of plugins)
      plugin.enter?.(snapshot2.root, ctx);
    traverse(snapshot2.root, -1);
    ctx.depth = -1;
    for (const plugin of plugins)
      plugin.exit?.(snapshot2.root, ctx);
  }
  function isLeafGeneric(node) {
    return node.role === "generic" && node.children.every((child) => typeof child === "string");
  }
  function isClickTargetRoot(node, ctx) {
    return !!node.ref && hasPointerCursor(node) && !ctx.ancestors.some((ancestor) => !!ancestor.ref && hasPointerCursor(ancestor));
  }
  var mergeStringChildren = {
    name: "mergeStringChildren",
    exit(node) {
      const children = [];
      const buffer = [];
      const flush = () => {
        if (!buffer.length)
          return;
        const text = normalizeWhiteSpace(buffer.join(""));
        if (text)
          children.push(text);
        buffer.length = 0;
      };
      for (const child of node.children) {
        if (typeof child === "string") {
          buffer.push(child);
        } else {
          flush();
          children.push(child);
        }
      }
      flush();
      node.children = children;
      if (node.children.length === 1 && node.children[0] === node.name)
        node.children = [];
    }
  };
  var unwrapSingleChildGenerics = {
    name: "unwrapSingleChildGenerics",
    exit(node, ctx) {
      if (node.role !== "generic" || node.name || node.children.length > 1 || !node.children.every((child) => typeof child !== "string" && !!child.ref))
        return;
      if (!node.children.length && isClickTargetRoot(node, ctx))
        return;
      return "unwrap";
    }
  };
  var removeNamelessImages = {
    name: "removeNamelessImages",
    exit(node, ctx) {
      if (node.role === "img" && !node.name && !node.children.length && !isClickTargetRoot(node, ctx))
        return "remove";
    }
  };
  var removeRedundantNames = {
    name: "removeRedundantNames",
    enter(node, ctx) {
      if (!node.ref)
        return;
      for (const ref of ctx.snapshot.info.get(node.ref)?.nameFromContentRefs || [])
        ctx.pendingContentRefs.add(ref);
      const beyondDepth = !!ctx.maxDepth && ctx.depth > ctx.maxDepth;
      if (!beyondDepth && !isLeafGeneric(node))
        ctx.pendingContentRefs.delete(node.ref);
    },
    exit(node, ctx) {
      if (!node.ref)
        return;
      const nameFromContentRefs = ctx.snapshot.info.get(node.ref)?.nameFromContentRefs;
      if (!nameFromContentRefs?.length)
        return;
      if (nameFromContentRefs.every((ref) => !ctx.pendingContentRefs.has(ref))) {
        node.name = "";
      } else {
        for (const ref of nameFromContentRefs)
          ctx.pendingContentRefs.delete(ref);
      }
    }
  };
  var removeNameRepeatingChild = {
    name: "removeNameRepeatingChild",
    exit(node, ctx) {
      const parent = ctx.ancestors[ctx.ancestors.length - 1];
      if (!parent?.name || node.role !== "generic" || node.active || Object.keys(node.props).length)
        return;
      const singleTextChild = node.children.length === 1 && typeof node.children[0] === "string" ? node.children[0] : void 0;
      const text = node.name ? node.children.length ? void 0 : node.name : singleTextChild;
      if (text && text === parent.name) {
        if (node.ref)
          ctx.pendingContentRefs.add(node.ref);
        return "remove";
      }
    }
  };
  var inlineTextIntoGeneric = {
    name: "inlineTextIntoGeneric",
    exit(node) {
      if (node.role !== "generic" || Object.keys(node.props).length || node.children.length !== 1)
        return;
      const child = node.children[0];
      if (typeof child === "string")
        return;
      if (child.role !== "generic" || child.name || child.active || Object.keys(child.props).length)
        return;
      if (child.children.length === 1 && typeof child.children[0] === "string")
        node.children = [child.children[0]];
    }
  };
  var normalizePlugins = [
    mergeStringChildren,
    unwrapSingleChildGenerics
  ];
  var aiPlugins = [
    mergeStringChildren,
    removeNamelessImages,
    removeRedundantNames,
    inlineTextIntoGeneric,
    removeNameRepeatingChild,
    unwrapSingleChildGenerics
  ];

  // browser-agent/vendor/playwright/injected/domUtils.ts
  var globalOptions = {};
  function parentElementOrShadowHost(element) {
    if (element.parentElement)
      return element.parentElement;
    if (!element.parentNode)
      return;
    if (element.parentNode.nodeType === 11 && element.parentNode.host)
      return element.parentNode.host;
  }
  function enclosingShadowRootOrDocument(element) {
    let node = element;
    while (node.parentNode)
      node = node.parentNode;
    if (node.nodeType === 11 || node.nodeType === 9)
      return node;
  }
  function enclosingShadowHost(element) {
    while (element.parentElement)
      element = element.parentElement;
    return parentElementOrShadowHost(element);
  }
  function closestCrossShadow(element, css, scope) {
    while (element) {
      const closest = element.closest(css);
      if (scope && closest !== scope && closest?.contains(scope))
        return;
      if (closest)
        return closest;
      element = enclosingShadowHost(element);
    }
  }
  function getElementComputedStyle(element, pseudo) {
    const cache = pseudo === "::before" ? cacheStyleBefore : pseudo === "::after" ? cacheStyleAfter : cacheStyle;
    if (cache && cache.has(element))
      return cache.get(element);
    const style = element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView.getComputedStyle(element, pseudo) : void 0;
    cache?.set(element, style);
    return style;
  }
  function isElementStyleVisibilityVisible(element, style) {
    const cached = cacheStyleVisibility?.get(element);
    if (cached !== void 0)
      return cached;
    const result = computeElementStyleVisibilityVisible(element, style);
    cacheStyleVisibility?.set(element, result);
    return result;
  }
  function computeElementStyleVisibilityVisible(element, style) {
    style = style ?? getElementComputedStyle(element);
    if (!style)
      return true;
    if (Element.prototype.checkVisibility && globalOptions.browserNameForWorkarounds !== "webkit") {
      if (!element.checkVisibility())
        return false;
    } else {
      const detailsOrSummary = element.closest("details,summary");
      if (detailsOrSummary !== element && detailsOrSummary?.nodeName === "DETAILS" && !detailsOrSummary.open)
        return false;
    }
    if (style.visibility !== "visible")
      return false;
    return true;
  }
  function computeBox(element) {
    const style = getElementComputedStyle(element);
    if (!style)
      return { visible: true, inline: false };
    const cursor = style.cursor;
    if (style.display === "contents") {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isElementVisible(child))
          return { visible: true, inline: false, cursor };
        if (child.nodeType === 3 && isVisibleTextNode(child))
          return { visible: true, inline: true, cursor };
      }
      return { visible: false, inline: false, cursor };
    }
    if (!isElementStyleVisibilityVisible(element, style))
      return { cursor, visible: false, inline: false };
    const rect = element.getBoundingClientRect();
    return { cursor, visible: rect.width > 0 && rect.height > 0, inline: style.display === "inline" };
  }
  function isElementVisible(element) {
    return computeBox(element).visible;
  }
  function isVisibleTextNode(node) {
    const range = node.ownerDocument.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function elementSafeTagName(element) {
    const tagName = element.tagName;
    if (typeof tagName === "string") {
      const firstCharCode = tagName.charCodeAt(0);
      if (firstCharCode >= 97 && firstCharCode <= 122)
        return tagName.toUpperCase();
      return tagName;
    }
    if (element instanceof HTMLFormElement)
      return "FORM";
    return element.tagName.toUpperCase();
  }
  var cacheStyle;
  var cacheStyleBefore;
  var cacheStyleAfter;
  var cacheStyleVisibility;
  var cachesCounter = 0;
  function beginDOMCaches() {
    ++cachesCounter;
    cacheStyle ??= /* @__PURE__ */ new Map();
    cacheStyleBefore ??= /* @__PURE__ */ new Map();
    cacheStyleAfter ??= /* @__PURE__ */ new Map();
    cacheStyleVisibility ??= /* @__PURE__ */ new Map();
  }
  function endDOMCaches() {
    if (!--cachesCounter) {
      cacheStyle = void 0;
      cacheStyleBefore = void 0;
      cacheStyleAfter = void 0;
      cacheStyleVisibility = void 0;
    }
  }

  // browser-agent/vendor/playwright/isomorphic/cssTokenizer.ts
  var between = function(num, first, last) {
    return num >= first && num <= last;
  };
  function digit(code) {
    return between(code, 48, 57);
  }
  function hexdigit(code) {
    return digit(code) || between(code, 65, 70) || between(code, 97, 102);
  }
  function uppercaseletter(code) {
    return between(code, 65, 90);
  }
  function lowercaseletter(code) {
    return between(code, 97, 122);
  }
  function letter(code) {
    return uppercaseletter(code) || lowercaseletter(code);
  }
  function nonascii(code) {
    return code >= 128;
  }
  function namestartchar(code) {
    return letter(code) || nonascii(code) || code === 95;
  }
  function namechar(code) {
    return namestartchar(code) || digit(code) || code === 45;
  }
  function nonprintable(code) {
    return between(code, 0, 8) || code === 11 || between(code, 14, 31) || code === 127;
  }
  function newline(code) {
    return code === 10;
  }
  function whitespace(code) {
    return newline(code) || code === 9 || code === 32;
  }
  var maximumallowedcodepoint = 1114111;
  var InvalidCharacterError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "InvalidCharacterError";
    }
  };
  function preprocess(str) {
    const codepoints = [];
    for (let i = 0; i < str.length; i++) {
      let code = str.charCodeAt(i);
      if (code === 13 && str.charCodeAt(i + 1) === 10) {
        code = 10;
        i++;
      }
      if (code === 13 || code === 12)
        code = 10;
      if (code === 0)
        code = 65533;
      if (between(code, 55296, 56319) && between(str.charCodeAt(i + 1), 56320, 57343)) {
        const lead = code - 55296;
        const trail = str.charCodeAt(i + 1) - 56320;
        code = Math.pow(2, 16) + lead * Math.pow(2, 10) + trail;
        i++;
      }
      codepoints.push(code);
    }
    return codepoints;
  }
  function stringFromCode(code) {
    if (code <= 65535)
      return String.fromCharCode(code);
    code -= Math.pow(2, 16);
    const lead = Math.floor(code / Math.pow(2, 10)) + 55296;
    const trail = code % Math.pow(2, 10) + 56320;
    return String.fromCharCode(lead) + String.fromCharCode(trail);
  }
  function tokenize(str1) {
    const str = preprocess(str1);
    let i = -1;
    const tokens = [];
    let code;
    let line = 0;
    let column = 0;
    let lastLineLength = 0;
    const incrLineno = function() {
      line += 1;
      lastLineLength = column;
      column = 0;
    };
    const locStart = { line, column };
    const codepoint = function(i2) {
      if (i2 >= str.length)
        return -1;
      return str[i2];
    };
    const next = function(num) {
      if (num === void 0)
        num = 1;
      if (num > 3)
        throw "Spec Error: no more than three codepoints of lookahead.";
      return codepoint(i + num);
    };
    const consume = function(num) {
      if (num === void 0)
        num = 1;
      i += num;
      code = codepoint(i);
      if (newline(code))
        incrLineno();
      else
        column += num;
      return true;
    };
    const reconsume = function() {
      i -= 1;
      if (newline(code)) {
        line -= 1;
        column = lastLineLength;
      } else {
        column -= 1;
      }
      locStart.line = line;
      locStart.column = column;
      return true;
    };
    const eof = function(codepoint2) {
      if (codepoint2 === void 0)
        codepoint2 = code;
      return codepoint2 === -1;
    };
    const donothing = function() {
    };
    const parseerror = function() {
    };
    const consumeAToken = function() {
      consumeComments();
      consume();
      if (whitespace(code)) {
        while (whitespace(next()))
          consume();
        return new WhitespaceToken();
      } else if (code === 34) {
        return consumeAStringToken();
      } else if (code === 35) {
        if (namechar(next()) || areAValidEscape(next(1), next(2))) {
          const token = new HashToken("");
          if (wouldStartAnIdentifier(next(1), next(2), next(3)))
            token.type = "id";
          token.value = consumeAName();
          return token;
        } else {
          return new DelimToken(code);
        }
      } else if (code === 36) {
        if (next() === 61) {
          consume();
          return new SuffixMatchToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 39) {
        return consumeAStringToken();
      } else if (code === 40) {
        return new OpenParenToken();
      } else if (code === 41) {
        return new CloseParenToken();
      } else if (code === 42) {
        if (next() === 61) {
          consume();
          return new SubstringMatchToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 43) {
        if (startsWithANumber()) {
          reconsume();
          return consumeANumericToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 44) {
        return new CommaToken();
      } else if (code === 45) {
        if (startsWithANumber()) {
          reconsume();
          return consumeANumericToken();
        } else if (next(1) === 45 && next(2) === 62) {
          consume(2);
          return new CDCToken();
        } else if (startsWithAnIdentifier()) {
          reconsume();
          return consumeAnIdentlikeToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 46) {
        if (startsWithANumber()) {
          reconsume();
          return consumeANumericToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 58) {
        return new ColonToken();
      } else if (code === 59) {
        return new SemicolonToken();
      } else if (code === 60) {
        if (next(1) === 33 && next(2) === 45 && next(3) === 45) {
          consume(3);
          return new CDOToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 64) {
        if (wouldStartAnIdentifier(next(1), next(2), next(3)))
          return new AtKeywordToken(consumeAName());
        else
          return new DelimToken(code);
      } else if (code === 91) {
        return new OpenSquareToken();
      } else if (code === 92) {
        if (startsWithAValidEscape()) {
          reconsume();
          return consumeAnIdentlikeToken();
        } else {
          parseerror();
          return new DelimToken(code);
        }
      } else if (code === 93) {
        return new CloseSquareToken();
      } else if (code === 94) {
        if (next() === 61) {
          consume();
          return new PrefixMatchToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 123) {
        return new OpenCurlyToken();
      } else if (code === 124) {
        if (next() === 61) {
          consume();
          return new DashMatchToken();
        } else if (next() === 124) {
          consume();
          return new ColumnToken();
        } else {
          return new DelimToken(code);
        }
      } else if (code === 125) {
        return new CloseCurlyToken();
      } else if (code === 126) {
        if (next() === 61) {
          consume();
          return new IncludeMatchToken();
        } else {
          return new DelimToken(code);
        }
      } else if (digit(code)) {
        reconsume();
        return consumeANumericToken();
      } else if (namestartchar(code)) {
        reconsume();
        return consumeAnIdentlikeToken();
      } else if (eof()) {
        return new EOFToken();
      } else {
        return new DelimToken(code);
      }
    };
    const consumeComments = function() {
      while (next(1) === 47 && next(2) === 42) {
        consume(2);
        while (true) {
          consume();
          if (code === 42 && next() === 47) {
            consume();
            break;
          } else if (eof()) {
            parseerror();
            return;
          }
        }
      }
    };
    const consumeANumericToken = function() {
      const num = consumeANumber();
      if (wouldStartAnIdentifier(next(1), next(2), next(3))) {
        const token = new DimensionToken();
        token.value = num.value;
        token.repr = num.repr;
        token.type = num.type;
        token.unit = consumeAName();
        return token;
      } else if (next() === 37) {
        consume();
        const token = new PercentageToken();
        token.value = num.value;
        token.repr = num.repr;
        return token;
      } else {
        const token = new NumberToken();
        token.value = num.value;
        token.repr = num.repr;
        token.type = num.type;
        return token;
      }
    };
    const consumeAnIdentlikeToken = function() {
      const str2 = consumeAName();
      if (str2.toLowerCase() === "url" && next() === 40) {
        consume();
        while (whitespace(next(1)) && whitespace(next(2)))
          consume();
        if (next() === 34 || next() === 39)
          return new FunctionToken(str2);
        else if (whitespace(next()) && (next(2) === 34 || next(2) === 39))
          return new FunctionToken(str2);
        else
          return consumeAURLToken();
      } else if (next() === 40) {
        consume();
        return new FunctionToken(str2);
      } else {
        return new IdentToken(str2);
      }
    };
    const consumeAStringToken = function(endingCodePoint) {
      if (endingCodePoint === void 0)
        endingCodePoint = code;
      let string = "";
      while (consume()) {
        if (code === endingCodePoint || eof()) {
          return new StringToken(string);
        } else if (newline(code)) {
          parseerror();
          reconsume();
          return new BadStringToken();
        } else if (code === 92) {
          if (eof(next()))
            donothing();
          else if (newline(next()))
            consume();
          else
            string += stringFromCode(consumeEscape());
        } else {
          string += stringFromCode(code);
        }
      }
      throw new Error("Internal error");
    };
    const consumeAURLToken = function() {
      const token = new URLToken("");
      while (whitespace(next()))
        consume();
      if (eof(next()))
        return token;
      while (consume()) {
        if (code === 41 || eof()) {
          return token;
        } else if (whitespace(code)) {
          while (whitespace(next()))
            consume();
          if (next() === 41 || eof(next())) {
            consume();
            return token;
          } else {
            consumeTheRemnantsOfABadURL();
            return new BadURLToken();
          }
        } else if (code === 34 || code === 39 || code === 40 || nonprintable(code)) {
          parseerror();
          consumeTheRemnantsOfABadURL();
          return new BadURLToken();
        } else if (code === 92) {
          if (startsWithAValidEscape()) {
            token.value += stringFromCode(consumeEscape());
          } else {
            parseerror();
            consumeTheRemnantsOfABadURL();
            return new BadURLToken();
          }
        } else {
          token.value += stringFromCode(code);
        }
      }
      throw new Error("Internal error");
    };
    const consumeEscape = function() {
      consume();
      if (hexdigit(code)) {
        const digits = [code];
        for (let total = 0; total < 5; total++) {
          if (hexdigit(next())) {
            consume();
            digits.push(code);
          } else {
            break;
          }
        }
        if (whitespace(next()))
          consume();
        let value = parseInt(digits.map(function(x) {
          return String.fromCharCode(x);
        }).join(""), 16);
        if (value > maximumallowedcodepoint)
          value = 65533;
        return value;
      } else if (eof()) {
        return 65533;
      } else {
        return code;
      }
    };
    const areAValidEscape = function(c1, c2) {
      if (c1 !== 92)
        return false;
      if (newline(c2))
        return false;
      return true;
    };
    const startsWithAValidEscape = function() {
      return areAValidEscape(code, next());
    };
    const wouldStartAnIdentifier = function(c1, c2, c3) {
      if (c1 === 45)
        return namestartchar(c2) || c2 === 45 || areAValidEscape(c2, c3);
      else if (namestartchar(c1))
        return true;
      else if (c1 === 92)
        return areAValidEscape(c1, c2);
      else
        return false;
    };
    const startsWithAnIdentifier = function() {
      return wouldStartAnIdentifier(code, next(1), next(2));
    };
    const wouldStartANumber = function(c1, c2, c3) {
      if (c1 === 43 || c1 === 45) {
        if (digit(c2))
          return true;
        if (c2 === 46 && digit(c3))
          return true;
        return false;
      } else if (c1 === 46) {
        if (digit(c2))
          return true;
        return false;
      } else if (digit(c1)) {
        return true;
      } else {
        return false;
      }
    };
    const startsWithANumber = function() {
      return wouldStartANumber(code, next(1), next(2));
    };
    const consumeAName = function() {
      let result = "";
      while (consume()) {
        if (namechar(code)) {
          result += stringFromCode(code);
        } else if (startsWithAValidEscape()) {
          result += stringFromCode(consumeEscape());
        } else {
          reconsume();
          return result;
        }
      }
      throw new Error("Internal parse error");
    };
    const consumeANumber = function() {
      let repr = "";
      let type = "integer";
      if (next() === 43 || next() === 45) {
        consume();
        repr += stringFromCode(code);
      }
      while (digit(next())) {
        consume();
        repr += stringFromCode(code);
      }
      if (next(1) === 46 && digit(next(2))) {
        consume();
        repr += stringFromCode(code);
        consume();
        repr += stringFromCode(code);
        type = "number";
        while (digit(next())) {
          consume();
          repr += stringFromCode(code);
        }
      }
      const c1 = next(1);
      const c2 = next(2);
      const c3 = next(3);
      if ((c1 === 69 || c1 === 101) && digit(c2)) {
        consume();
        repr += stringFromCode(code);
        consume();
        repr += stringFromCode(code);
        type = "number";
        while (digit(next())) {
          consume();
          repr += stringFromCode(code);
        }
      } else if ((c1 === 69 || c1 === 101) && (c2 === 43 || c2 === 45) && digit(c3)) {
        consume();
        repr += stringFromCode(code);
        consume();
        repr += stringFromCode(code);
        consume();
        repr += stringFromCode(code);
        type = "number";
        while (digit(next())) {
          consume();
          repr += stringFromCode(code);
        }
      }
      const value = convertAStringToANumber(repr);
      return { type, value, repr };
    };
    const convertAStringToANumber = function(string) {
      return +string;
    };
    const consumeTheRemnantsOfABadURL = function() {
      while (consume()) {
        if (code === 41 || eof()) {
          return;
        } else if (startsWithAValidEscape()) {
          consumeEscape();
          donothing();
        } else {
          donothing();
        }
      }
    };
    let iterationCount = 0;
    while (!eof(next())) {
      tokens.push(consumeAToken());
      iterationCount++;
      if (iterationCount > str.length * 2)
        throw new Error("I'm infinite-looping!");
    }
    return tokens;
  }
  var CSSParserToken = class {
    constructor() {
      this.tokenType = "";
    }
    toJSON() {
      return { token: this.tokenType };
    }
    toString() {
      return this.tokenType;
    }
    toSource() {
      return "" + this;
    }
  };
  var BadStringToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "BADSTRING";
    }
  };
  var BadURLToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "BADURL";
    }
  };
  var WhitespaceToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "WHITESPACE";
    }
    toString() {
      return "WS";
    }
    toSource() {
      return " ";
    }
  };
  var CDOToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "CDO";
    }
    toSource() {
      return "<!--";
    }
  };
  var CDCToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "CDC";
    }
    toSource() {
      return "-->";
    }
  };
  var ColonToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = ":";
    }
  };
  var SemicolonToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = ";";
    }
  };
  var CommaToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = ",";
    }
  };
  var GroupingToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.value = "";
      this.mirror = "";
    }
  };
  var OpenCurlyToken = class extends GroupingToken {
    constructor() {
      super();
      this.tokenType = "{";
      this.value = "{";
      this.mirror = "}";
    }
  };
  var CloseCurlyToken = class extends GroupingToken {
    constructor() {
      super();
      this.tokenType = "}";
      this.value = "}";
      this.mirror = "{";
    }
  };
  var OpenSquareToken = class extends GroupingToken {
    constructor() {
      super();
      this.tokenType = "[";
      this.value = "[";
      this.mirror = "]";
    }
  };
  var CloseSquareToken = class extends GroupingToken {
    constructor() {
      super();
      this.tokenType = "]";
      this.value = "]";
      this.mirror = "[";
    }
  };
  var OpenParenToken = class extends GroupingToken {
    constructor() {
      super();
      this.tokenType = "(";
      this.value = "(";
      this.mirror = ")";
    }
  };
  var CloseParenToken = class extends GroupingToken {
    constructor() {
      super();
      this.tokenType = ")";
      this.value = ")";
      this.mirror = "(";
    }
  };
  var IncludeMatchToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "~=";
    }
  };
  var DashMatchToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "|=";
    }
  };
  var PrefixMatchToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "^=";
    }
  };
  var SuffixMatchToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "$=";
    }
  };
  var SubstringMatchToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "*=";
    }
  };
  var ColumnToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "||";
    }
  };
  var EOFToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.tokenType = "EOF";
    }
    toSource() {
      return "";
    }
  };
  var DelimToken = class extends CSSParserToken {
    constructor(code) {
      super();
      this.tokenType = "DELIM";
      this.value = "";
      this.value = stringFromCode(code);
    }
    toString() {
      return "DELIM(" + this.value + ")";
    }
    toJSON() {
      const json = this.constructor.prototype.constructor.prototype.toJSON.call(this);
      json.value = this.value;
      return json;
    }
    toSource() {
      if (this.value === "\\")
        return "\\\n";
      else
        return this.value;
    }
  };
  var StringValuedToken = class extends CSSParserToken {
    constructor() {
      super(...arguments);
      this.value = "";
    }
    ASCIIMatch(str) {
      return this.value.toLowerCase() === str.toLowerCase();
    }
    toJSON() {
      const json = this.constructor.prototype.constructor.prototype.toJSON.call(this);
      json.value = this.value;
      return json;
    }
  };
  var IdentToken = class extends StringValuedToken {
    constructor(val) {
      super();
      this.tokenType = "IDENT";
      this.value = val;
    }
    toString() {
      return "IDENT(" + this.value + ")";
    }
    toSource() {
      return escapeIdent(this.value);
    }
  };
  var FunctionToken = class extends StringValuedToken {
    constructor(val) {
      super();
      this.tokenType = "FUNCTION";
      this.value = val;
      this.mirror = ")";
    }
    toString() {
      return "FUNCTION(" + this.value + ")";
    }
    toSource() {
      return escapeIdent(this.value) + "(";
    }
  };
  var AtKeywordToken = class extends StringValuedToken {
    constructor(val) {
      super();
      this.tokenType = "AT-KEYWORD";
      this.value = val;
    }
    toString() {
      return "AT(" + this.value + ")";
    }
    toSource() {
      return "@" + escapeIdent(this.value);
    }
  };
  var HashToken = class extends StringValuedToken {
    constructor(val) {
      super();
      this.tokenType = "HASH";
      this.value = val;
      this.type = "unrestricted";
    }
    toString() {
      return "HASH(" + this.value + ")";
    }
    toJSON() {
      const json = this.constructor.prototype.constructor.prototype.toJSON.call(this);
      json.value = this.value;
      json.type = this.type;
      return json;
    }
    toSource() {
      if (this.type === "id")
        return "#" + escapeIdent(this.value);
      else
        return "#" + escapeHash(this.value);
    }
  };
  var StringToken = class extends StringValuedToken {
    constructor(val) {
      super();
      this.tokenType = "STRING";
      this.value = val;
    }
    toString() {
      return '"' + escapeString(this.value) + '"';
    }
  };
  var URLToken = class extends StringValuedToken {
    constructor(val) {
      super();
      this.tokenType = "URL";
      this.value = val;
    }
    toString() {
      return "URL(" + this.value + ")";
    }
    toSource() {
      return 'url("' + escapeString(this.value) + '")';
    }
  };
  var NumberToken = class extends CSSParserToken {
    constructor() {
      super();
      this.tokenType = "NUMBER";
      this.type = "integer";
      this.repr = "";
    }
    toString() {
      if (this.type === "integer")
        return "INT(" + this.value + ")";
      return "NUMBER(" + this.value + ")";
    }
    toJSON() {
      const json = super.toJSON();
      json.value = this.value;
      json.type = this.type;
      json.repr = this.repr;
      return json;
    }
    toSource() {
      return this.repr;
    }
  };
  var PercentageToken = class extends CSSParserToken {
    constructor() {
      super();
      this.tokenType = "PERCENTAGE";
      this.repr = "";
    }
    toString() {
      return "PERCENTAGE(" + this.value + ")";
    }
    toJSON() {
      const json = this.constructor.prototype.constructor.prototype.toJSON.call(this);
      json.value = this.value;
      json.repr = this.repr;
      return json;
    }
    toSource() {
      return this.repr + "%";
    }
  };
  var DimensionToken = class extends CSSParserToken {
    constructor() {
      super();
      this.tokenType = "DIMENSION";
      this.type = "integer";
      this.repr = "";
      this.unit = "";
    }
    toString() {
      return "DIM(" + this.value + "," + this.unit + ")";
    }
    toJSON() {
      const json = this.constructor.prototype.constructor.prototype.toJSON.call(this);
      json.value = this.value;
      json.type = this.type;
      json.repr = this.repr;
      json.unit = this.unit;
      return json;
    }
    toSource() {
      const source = this.repr;
      let unit = escapeIdent(this.unit);
      if (unit[0].toLowerCase() === "e" && (unit[1] === "-" || between(unit.charCodeAt(1), 48, 57))) {
        unit = "\\65 " + unit.slice(1, unit.length);
      }
      return source + unit;
    }
  };
  function escapeIdent(string) {
    string = "" + string;
    let result = "";
    const firstcode = string.charCodeAt(0);
    for (let i = 0; i < string.length; i++) {
      const code = string.charCodeAt(i);
      if (code === 0)
        throw new InvalidCharacterError("Invalid character: the input contains U+0000.");
      if (between(code, 1, 31) || code === 127 || i === 0 && between(code, 48, 57) || i === 1 && between(code, 48, 57) && firstcode === 45)
        result += "\\" + code.toString(16) + " ";
      else if (code >= 128 || code === 45 || code === 95 || between(code, 48, 57) || between(code, 65, 90) || between(code, 97, 122))
        result += string[i];
      else
        result += "\\" + string[i];
    }
    return result;
  }
  function escapeHash(string) {
    string = "" + string;
    let result = "";
    for (let i = 0; i < string.length; i++) {
      const code = string.charCodeAt(i);
      if (code === 0)
        throw new InvalidCharacterError("Invalid character: the input contains U+0000.");
      if (code >= 128 || code === 45 || code === 95 || between(code, 48, 57) || between(code, 65, 90) || between(code, 97, 122))
        result += string[i];
      else
        result += "\\" + code.toString(16) + " ";
    }
    return result;
  }
  function escapeString(string) {
    string = "" + string;
    let result = "";
    for (let i = 0; i < string.length; i++) {
      const code = string.charCodeAt(i);
      if (code === 0)
        throw new InvalidCharacterError("Invalid character: the input contains U+0000.");
      if (between(code, 1, 31) || code === 127)
        result += "\\" + code.toString(16) + " ";
      else if (code === 34 || code === 92)
        result += "\\" + string[i];
      else
        result += string[i];
    }
    return result;
  }

  // browser-agent/vendor/playwright/injected/roleUtils.ts
  function hasExplicitAccessibleName(e) {
    return e.hasAttribute("aria-label") || e.hasAttribute("aria-labelledby");
  }
  var kAncestorPreventingLandmark = "article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]";
  var kGlobalAriaAttributes = [
    ["aria-atomic", void 0],
    ["aria-busy", void 0],
    ["aria-controls", void 0],
    ["aria-current", void 0],
    ["aria-describedby", void 0],
    ["aria-details", void 0],
    // Global use deprecated in ARIA 1.2
    // ['aria-disabled', undefined],
    ["aria-dropeffect", void 0],
    // Global use deprecated in ARIA 1.2
    // ['aria-errormessage', undefined],
    ["aria-flowto", void 0],
    ["aria-grabbed", void 0],
    // Global use deprecated in ARIA 1.2
    // ['aria-haspopup', undefined],
    ["aria-hidden", void 0],
    // Global use deprecated in ARIA 1.2
    // ['aria-invalid', undefined],
    ["aria-keyshortcuts", void 0],
    ["aria-label", ["caption", "code", "deletion", "emphasis", "generic", "insertion", "paragraph", "presentation", "strong", "subscript", "superscript"]],
    ["aria-labelledby", ["caption", "code", "deletion", "emphasis", "generic", "insertion", "paragraph", "presentation", "strong", "subscript", "superscript"]],
    ["aria-live", void 0],
    ["aria-owns", void 0],
    ["aria-relevant", void 0],
    ["aria-roledescription", ["generic"]]
  ];
  function hasGlobalAriaAttribute(element, forRole) {
    return kGlobalAriaAttributes.some(([attr, prohibited]) => {
      return !prohibited?.includes(forRole || "") && element.hasAttribute(attr);
    });
  }
  function hasTabIndex(element) {
    return !Number.isNaN(Number(String(element.getAttribute("tabindex"))));
  }
  function isFocusable(element) {
    return !isNativelyDisabled(element) && (isNativelyFocusable(element) || hasTabIndex(element));
  }
  function isNativelyFocusable(element) {
    const tagName = elementSafeTagName(element);
    if (["BUTTON", "DETAILS", "SELECT", "TEXTAREA"].includes(tagName))
      return true;
    if (tagName === "A" || tagName === "AREA")
      return element.hasAttribute("href");
    if (tagName === "INPUT")
      return !element.hidden;
    return false;
  }
  var kImplicitRoleByTagName = {
    "A": (e) => {
      return e.hasAttribute("href") ? "link" : null;
    },
    "AREA": (e) => {
      return e.hasAttribute("href") ? "link" : null;
    },
    "ARTICLE": () => "article",
    "ASIDE": () => "complementary",
    "BLOCKQUOTE": () => "blockquote",
    "BUTTON": () => "button",
    "CAPTION": () => "caption",
    "CODE": () => "code",
    "DATALIST": () => "listbox",
    "DD": () => "definition",
    "DEL": () => "deletion",
    "DETAILS": () => "group",
    "DFN": () => "term",
    "DIALOG": () => "dialog",
    "DT": () => "term",
    "EM": () => "emphasis",
    "FIELDSET": () => "group",
    "FIGURE": () => "figure",
    "FOOTER": (e) => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : "contentinfo",
    "FORM": (e) => hasExplicitAccessibleName(e) ? "form" : null,
    "H1": () => "heading",
    "H2": () => "heading",
    "H3": () => "heading",
    "H4": () => "heading",
    "H5": () => "heading",
    "H6": () => "heading",
    "HEADER": (e) => closestCrossShadow(e, kAncestorPreventingLandmark) ? null : "banner",
    "HR": () => "separator",
    "HTML": () => "document",
    "IMG": (e) => e.getAttribute("alt") === "" && !e.getAttribute("title") && !hasGlobalAriaAttribute(e) && !hasTabIndex(e) ? "presentation" : "img",
    "INPUT": (e) => {
      const type = e.type.toLowerCase();
      if (["email", "search", "tel", "text", "url", ""].includes(type)) {
        const list = getIdRefs(e, e.getAttribute("list"))[0];
        if (list && elementSafeTagName(list) === "DATALIST")
          return "combobox";
        return type === "search" ? "searchbox" : "textbox";
      }
      if (type === "hidden")
        return null;
      if (type === "file")
        return "button";
      return inputTypeToRole[type] || "textbox";
    },
    "INS": () => "insertion",
    "LI": () => "listitem",
    "MAIN": () => "main",
    "MARK": () => "mark",
    "MATH": () => "math",
    "MENU": () => "list",
    "METER": () => "meter",
    "NAV": () => "navigation",
    "OL": () => "list",
    "OPTGROUP": () => "group",
    "OPTION": () => "option",
    "OUTPUT": () => "status",
    "P": () => "paragraph",
    "PROGRESS": () => "progressbar",
    "SEARCH": () => "search",
    "SECTION": (e) => hasExplicitAccessibleName(e) ? "region" : null,
    "SELECT": (e) => e.hasAttribute("multiple") || e.size > 1 ? "listbox" : "combobox",
    "STRONG": () => "strong",
    "SUB": () => "subscript",
    "SUP": () => "superscript",
    // For <svg> we default to Chrome behavior:
    // - Chrome reports 'img'.
    // - Firefox reports 'diagram' that is not in official ARIA spec yet.
    // - Safari reports 'no role', but still computes accessible name.
    "SVG": () => "img",
    "TABLE": () => "table",
    "TBODY": () => "rowgroup",
    "TD": (e) => {
      const table = closestCrossShadow(e, "table");
      const role = table ? getExplicitAriaRole(table) : "";
      return role === "grid" || role === "treegrid" ? "gridcell" : "cell";
    },
    "TEXTAREA": () => "textbox",
    "TFOOT": () => "rowgroup",
    "TH": (e) => {
      const scope = e.getAttribute("scope");
      if (scope === "col" || scope === "colgroup")
        return "columnheader";
      if (scope === "row" || scope === "rowgroup")
        return "rowheader";
      const nextSibling = e.nextElementSibling;
      const prevSibling = e.previousElementSibling;
      const row = !!e.parentElement && elementSafeTagName(e.parentElement) === "TR" ? e.parentElement : void 0;
      if (!nextSibling && !prevSibling) {
        if (row) {
          const table = closestCrossShadow(row, "table");
          if (table && table.rows.length <= 1)
            return null;
        }
        return "columnheader";
      }
      if (isHeaderCell(nextSibling) && isHeaderCell(prevSibling))
        return "columnheader";
      if (isNonEmptyDataCell(nextSibling) || isNonEmptyDataCell(prevSibling))
        return "rowheader";
      return "columnheader";
    },
    "THEAD": () => "rowgroup",
    "TIME": () => "time",
    "TR": () => "row",
    "UL": () => "list"
  };
  function isHeaderCell(element) {
    return !!element && elementSafeTagName(element) === "TH";
  }
  function isNonEmptyDataCell(element) {
    if (!element || elementSafeTagName(element) !== "TD")
      return false;
    return !!(element.textContent?.trim() || element.children.length > 0);
  }
  var kPresentationInheritanceParents = {
    "DD": ["DL", "DIV"],
    "DIV": ["DL"],
    "DT": ["DL", "DIV"],
    "LI": ["OL", "UL"],
    "TBODY": ["TABLE"],
    "TD": ["TR"],
    "TFOOT": ["TABLE"],
    "TH": ["TR"],
    "THEAD": ["TABLE"],
    "TR": ["THEAD", "TBODY", "TFOOT", "TABLE"]
  };
  function getImplicitAriaRole(element) {
    const implicitRole = kImplicitRoleByTagName[elementSafeTagName(element)]?.(element) || "";
    if (!implicitRole)
      return null;
    let ancestor = element;
    while (ancestor) {
      const parent = parentElementOrShadowHost(ancestor);
      const parents = kPresentationInheritanceParents[elementSafeTagName(ancestor)];
      if (!parents || !parent || !parents.includes(elementSafeTagName(parent)))
        break;
      const parentExplicitRole = getExplicitAriaRole(parent);
      if ((parentExplicitRole === "none" || parentExplicitRole === "presentation") && !hasPresentationConflictResolution(parent, parentExplicitRole))
        return parentExplicitRole;
      ancestor = parent;
    }
    return implicitRole;
  }
  var validRoles = [
    "alert",
    "alertdialog",
    "application",
    "article",
    "banner",
    "blockquote",
    "button",
    "caption",
    "cell",
    "checkbox",
    "code",
    "columnheader",
    "combobox",
    "complementary",
    "contentinfo",
    "definition",
    "deletion",
    "dialog",
    "directory",
    "document",
    "emphasis",
    "feed",
    "figure",
    "form",
    "generic",
    "grid",
    "gridcell",
    "group",
    "heading",
    "img",
    "insertion",
    "link",
    "list",
    "listbox",
    "listitem",
    "log",
    "main",
    "mark",
    "marquee",
    "math",
    "meter",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "navigation",
    "none",
    "note",
    "option",
    "paragraph",
    "presentation",
    "progressbar",
    "radio",
    "radiogroup",
    "region",
    "row",
    "rowgroup",
    "rowheader",
    "scrollbar",
    "search",
    "searchbox",
    "separator",
    "slider",
    "spinbutton",
    "status",
    "strong",
    "subscript",
    "superscript",
    "switch",
    "tab",
    "table",
    "tablist",
    "tabpanel",
    "term",
    "textbox",
    "time",
    "timer",
    "toolbar",
    "tooltip",
    "tree",
    "treegrid",
    "treeitem"
  ];
  function getExplicitAriaRole(element) {
    const roles = (element.getAttribute("role") || "").split(" ").map((role) => role.trim());
    return roles.find((role) => validRoles.includes(role)) || null;
  }
  function hasPresentationConflictResolution(element, role) {
    return hasGlobalAriaAttribute(element, role) || isFocusable(element);
  }
  function getAriaRole(element) {
    const cached = cacheAriaRole?.get(element);
    if (cached !== void 0)
      return cached;
    const role = computeAriaRole(element);
    cacheAriaRole?.set(element, role);
    return role;
  }
  function computeAriaRole(element) {
    const explicitRole = getExplicitAriaRole(element);
    if (!explicitRole)
      return getImplicitAriaRole(element);
    if (explicitRole === "none" || explicitRole === "presentation") {
      const implicitRole = getImplicitAriaRole(element);
      if (hasPresentationConflictResolution(element, implicitRole))
        return implicitRole;
    }
    return explicitRole;
  }
  function getAriaBoolean(attr) {
    return attr === null ? void 0 : attr.toLowerCase() === "true";
  }
  function isElementIgnoredForAria(element) {
    return ["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"].includes(elementSafeTagName(element));
  }
  function isElementHiddenForAria(element) {
    if (isElementIgnoredForAria(element))
      return true;
    const style = getElementComputedStyle(element);
    const isSlot = element.nodeName === "SLOT";
    if (style?.display === "contents" && !isSlot) {
      for (let child = element.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && !isElementHiddenForAria(child))
          return false;
        if (child.nodeType === 3 && isVisibleTextNode(child))
          return false;
      }
      return true;
    }
    const isOptionInsideSelect = element.nodeName === "OPTION" && !!element.closest("select");
    if (!isOptionInsideSelect && !isSlot && !isElementStyleVisibilityVisible(element, style))
      return true;
    return belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element);
  }
  function belongsToDisplayNoneOrAriaHiddenOrNonSlotted(element) {
    let hidden = cacheIsHidden?.get(element);
    if (hidden === void 0) {
      hidden = false;
      if (element.parentElement && element.parentElement.shadowRoot && !element.assignedSlot)
        hidden = true;
      if (!hidden) {
        const style = getElementComputedStyle(element);
        hidden = !style || style.display === "none" || getAriaBoolean(element.getAttribute("aria-hidden")) === true;
      }
      if (!hidden) {
        const parent = parentElementOrShadowHost(element);
        if (parent)
          hidden = belongsToDisplayNoneOrAriaHiddenOrNonSlotted(parent);
      }
      cacheIsHidden?.set(element, hidden);
    }
    return hidden;
  }
  function getIdRefs(element, ref) {
    if (!ref)
      return [];
    const root = enclosingShadowRootOrDocument(element);
    if (!root)
      return [];
    try {
      const ids = ref.split(" ").filter((id) => !!id);
      const result = [];
      for (const id of ids) {
        const firstElement = root.querySelector("#" + CSS.escape(id));
        if (firstElement && !result.includes(firstElement))
          result.push(firstElement);
      }
      return result;
    } catch (e) {
      return [];
    }
  }
  function trimFlatString(s) {
    return s.trim();
  }
  function asFlatString(s) {
    return s.split("\xA0").map((chunk) => chunk.replace(/\r\n/g, "\n").replace(/[\u200b\u00ad]/g, "").replace(/\s\s*/g, " ")).join("\xA0").trim();
  }
  function queryInAriaOwned(element, selector) {
    const result = [...element.querySelectorAll(selector)];
    for (const owned of getIdRefs(element, element.getAttribute("aria-owns"))) {
      if (owned.matches(selector))
        result.push(owned);
      result.push(...owned.querySelectorAll(selector));
    }
    return result;
  }
  function getCSSContent(element, pseudo) {
    const cache = pseudo === "::before" ? cachePseudoContentBefore : pseudo === "::after" ? cachePseudoContentAfter : cachePseudoContent;
    if (cache?.has(element))
      return cache?.get(element);
    const style = getElementComputedStyle(element, pseudo);
    let content;
    if (style) {
      const contentValue = style.content;
      if (contentValue && contentValue !== "none" && contentValue !== "normal") {
        if (style.display !== "none" && style.visibility !== "hidden") {
          content = parseCSSContentPropertyAsString(element, contentValue, !!pseudo);
        }
      }
    }
    if (pseudo && content !== void 0) {
      const display = style?.display || "inline";
      if (display !== "inline")
        content = " " + content + " ";
    }
    if (cache)
      cache.set(element, content);
    return content;
  }
  function parseCSSContentPropertyAsString(element, content, isPseudo) {
    if (!content || content === "none" || content === "normal") {
      return;
    }
    try {
      let tokens = tokenize(content).filter((token) => !(token instanceof WhitespaceToken));
      const delimIndex = tokens.findIndex((token) => token instanceof DelimToken && token.value === "/");
      if (delimIndex !== -1) {
        tokens = tokens.slice(delimIndex + 1);
      } else if (!isPseudo) {
        return;
      }
      const accumulated = [];
      let index = 0;
      while (index < tokens.length) {
        if (tokens[index] instanceof StringToken) {
          accumulated.push(tokens[index].value);
          index++;
        } else if (index + 2 < tokens.length && tokens[index] instanceof FunctionToken && tokens[index].value === "attr" && tokens[index + 1] instanceof IdentToken && tokens[index + 2] instanceof CloseParenToken) {
          const attrName = tokens[index + 1].value;
          accumulated.push(element.getAttribute(attrName) || "");
          index += 3;
        } else {
          return;
        }
      }
      return accumulated.join("");
    } catch {
    }
  }
  function getAriaLabelledByElements(element) {
    const ref = element.getAttribute("aria-labelledby");
    if (ref === null)
      return null;
    const refs2 = getIdRefs(element, ref);
    return refs2.length ? refs2 : null;
  }
  function allowsNameFromContent(role, targetDescendant) {
    const alwaysAllowsNameFromContent = ["button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "row", "rowheader", "switch", "tab", "tooltip", "treeitem"].includes(role);
    const descendantAllowsNameFromContent = targetDescendant && ["", "caption", "code", "contentinfo", "definition", "deletion", "emphasis", "insertion", "list", "listitem", "mark", "none", "paragraph", "presentation", "region", "row", "rowgroup", "section", "strong", "subscript", "superscript", "table", "term", "time"].includes(role);
    return alwaysAllowsNameFromContent || descendantAllowsNameFromContent;
  }
  function computeAccessibleNameComposite(element, includeHidden, collectElements) {
    const elementProhibitsNaming = ["caption", "code", "definition", "deletion", "emphasis", "generic", "insertion", "mark", "paragraph", "presentation", "strong", "subscript", "suggestion", "superscript", "term", "time"].includes(getAriaRole(element) || "");
    if (elementProhibitsNaming)
      return { ...emptyCompositeString(), derivedFromContent: false };
    const outDerivedFromContent = { value: false };
    const result = getTextAlternativeInternal(element, {
      includeHidden,
      collectElements,
      outDerivedFromContent,
      visitedElements: /* @__PURE__ */ new Set(),
      embeddedInTargetElement: "self"
    });
    return { text: asFlatString(result.text), elements: result.elements, derivedFromContent: outDerivedFromContent.value };
  }
  function getElementAccessibleName(element, includeHidden) {
    const cache = includeHidden ? cacheAccessibleNameHidden : cacheAccessibleName;
    let accessibleName = cache?.get(element);
    if (accessibleName === void 0) {
      accessibleName = computeAccessibleNameComposite(
        element,
        includeHidden,
        true
        /* collectElements */
      );
      cache?.set(element, accessibleName);
    }
    return accessibleName;
  }
  var kAriaInvalidRoles = [
    "application",
    "checkbox",
    "columnheader",
    "combobox",
    "gridcell",
    "listbox",
    "radiogroup",
    "rowheader",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "textbox",
    "tree"
  ];
  function getAriaInvalid(element) {
    const ariaInvalid = element.getAttribute("aria-invalid");
    if (!ariaInvalid || ariaInvalid.trim() === "" || ariaInvalid.toLocaleLowerCase() === "false")
      return "false";
    if (ariaInvalid === "true" || ariaInvalid === "grammar" || ariaInvalid === "spelling")
      return ariaInvalid;
    return "true";
  }
  function insideTargetElement(options) {
    return options.embeddedInTargetElement === "self" || options.embeddedInTargetElement === "descendant";
  }
  function getTextAlternativeInternal(element, options) {
    if (options.visitedElements.has(element))
      return emptyCompositeString();
    const childOptions = {
      ...options,
      embeddedInTargetElement: options.embeddedInTargetElement === "self" ? "descendant" : options.embeddedInTargetElement
    };
    if (!options.includeHidden) {
      const isEmbeddedInHiddenReferenceTraversal = !!options.embeddedInLabelledBy?.hidden || !!options.embeddedInDescribedBy?.hidden || !!options.embeddedInNativeTextAlternative?.hidden || !!options.embeddedInLabel?.hidden;
      if (isElementIgnoredForAria(element) || !isEmbeddedInHiddenReferenceTraversal && isElementHiddenForAria(element)) {
        options.visitedElements.add(element);
        return emptyCompositeString();
      }
    }
    const labelledBy = getAriaLabelledByElements(element);
    if (!options.embeddedInLabelledBy) {
      const accessibleName = joinCompositeString((labelledBy || []).map((ref) => getTextAlternativeInternal(ref, {
        ...options,
        embeddedInLabelledBy: { element: ref, hidden: isElementHiddenForAria(ref) },
        embeddedInDescribedBy: void 0,
        embeddedInTargetElement: void 0,
        embeddedInLabel: void 0,
        embeddedInNativeTextAlternative: void 0
      })), " ", options.collectElements);
      if (accessibleName.text) {
        if (options.outDerivedFromContent && insideTargetElement(options) && (labelledBy || []).some((ref) => ref === element || element.contains(ref)))
          options.outDerivedFromContent.value = true;
        return accessibleName;
      }
    }
    const role = getAriaRole(element) || "";
    const tagName = elementSafeTagName(element);
    if (!!options.embeddedInLabel || !!options.embeddedInLabelledBy || options.embeddedInTargetElement === "descendant") {
      const isOwnLabel = [...element.labels || []].includes(element);
      const isOwnLabelledBy = (labelledBy || []).includes(element);
      if (!isOwnLabel && !isOwnLabelledBy) {
        if (role === "textbox" || role === "searchbox") {
          options.visitedElements.add(element);
          if (tagName === "INPUT" || tagName === "TEXTAREA")
            return compositeString(element.value, element, options.collectElements);
          return compositeString(element.textContent, element, options.collectElements);
        }
        if (["combobox", "listbox"].includes(role)) {
          options.visitedElements.add(element);
          let selectedOptions;
          if (tagName === "SELECT") {
            selectedOptions = [...element.selectedOptions];
            if (!selectedOptions.length && element.options.length)
              selectedOptions.push(element.options[0]);
          } else {
            const listbox = role === "combobox" ? queryInAriaOwned(element, "*").find((e) => getAriaRole(e) === "listbox") : element;
            selectedOptions = listbox ? queryInAriaOwned(listbox, '[aria-selected="true"]').filter((e) => getAriaRole(e) === "option") : [];
          }
          if (!selectedOptions.length && tagName === "INPUT") {
            return compositeString(element.value, element, options.collectElements);
          }
          return joinCompositeString(selectedOptions.map((option) => getTextAlternativeInternal(option, childOptions)), " ", options.collectElements);
        }
        if (["progressbar", "scrollbar", "slider", "spinbutton", "meter"].includes(role)) {
          options.visitedElements.add(element);
          if (element.hasAttribute("aria-valuetext"))
            return compositeString(element.getAttribute("aria-valuetext"), element, options.collectElements);
          if (element.hasAttribute("aria-valuenow"))
            return compositeString(element.getAttribute("aria-valuenow"), element, options.collectElements);
          return compositeString(element.getAttribute("value"), element, options.collectElements);
        }
        if (["menu"].includes(role)) {
          options.visitedElements.add(element);
          return emptyCompositeString();
        }
      }
    }
    const ariaLabel = element.getAttribute("aria-label") || "";
    if (trimFlatString(ariaLabel)) {
      options.visitedElements.add(element);
      return compositeString(ariaLabel, element, options.collectElements);
    }
    if (!["presentation", "none"].includes(role)) {
      if (tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type)) {
        options.visitedElements.add(element);
        const value = element.value || "";
        if (trimFlatString(value))
          return compositeString(value, element, options.collectElements);
        if (element.type === "submit")
          return compositeString("Submit", element, options.collectElements);
        if (element.type === "reset")
          return compositeString("Reset", element, options.collectElements);
        const title = element.getAttribute("title") || "";
        return compositeString(title, element, options.collectElements);
      }
      if (tagName === "INPUT" && element.type === "file") {
        options.visitedElements.add(element);
        const labels = element.labels || [];
        if (labels.length && !options.embeddedInLabelledBy)
          return getAccessibleNameFromAssociatedLabels(labels, options);
        return compositeString("Choose File", element, options.collectElements);
      }
      if (tagName === "INPUT" && element.type === "image") {
        options.visitedElements.add(element);
        const labels = element.labels || [];
        if (labels.length && !options.embeddedInLabelledBy)
          return getAccessibleNameFromAssociatedLabels(labels, options);
        const alt = element.getAttribute("alt") || "";
        if (trimFlatString(alt))
          return compositeString(alt, element, options.collectElements);
        const title = element.getAttribute("title") || "";
        if (trimFlatString(title))
          return compositeString(title, element, options.collectElements);
        return compositeString("Submit", element, options.collectElements);
      }
      if (!labelledBy && tagName === "BUTTON") {
        options.visitedElements.add(element);
        const labels = element.labels || [];
        if (labels.length)
          return getAccessibleNameFromAssociatedLabels(labels, options);
      }
      if (!labelledBy && tagName === "OUTPUT") {
        options.visitedElements.add(element);
        const labels = element.labels || [];
        if (labels.length)
          return getAccessibleNameFromAssociatedLabels(labels, options);
        return compositeString(element.getAttribute("title") || "", element, options.collectElements);
      }
      if (!labelledBy && (tagName === "TEXTAREA" || tagName === "SELECT" || tagName === "INPUT" || tagName === "METER" || tagName === "PROGRESS")) {
        options.visitedElements.add(element);
        const labels = element.labels || [];
        if (labels.length)
          return getAccessibleNameFromAssociatedLabels(labels, options);
        const usePlaceholder = tagName === "INPUT" && ["text", "password", "number", "search", "tel", "email", "url"].includes(element.type) || tagName === "TEXTAREA";
        const placeholder = element.getAttribute("placeholder") || "";
        const title = element.getAttribute("title") || "";
        if (!usePlaceholder || title)
          return compositeString(title, element, options.collectElements);
        return compositeString(placeholder, element, options.collectElements);
      }
      if (!labelledBy && tagName === "FIELDSET") {
        options.visitedElements.add(element);
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === "LEGEND") {
            return getTextAlternativeInternal(child, {
              ...childOptions,
              embeddedInNativeTextAlternative: { element: child, hidden: isElementHiddenForAria(child) }
            });
          }
        }
        const title = element.getAttribute("title") || "";
        return compositeString(title, element, options.collectElements);
      }
      if (!labelledBy && tagName === "FIGURE") {
        options.visitedElements.add(element);
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === "FIGCAPTION") {
            return getTextAlternativeInternal(child, {
              ...childOptions,
              embeddedInNativeTextAlternative: { element: child, hidden: isElementHiddenForAria(child) }
            });
          }
        }
        const title = element.getAttribute("title") || "";
        return compositeString(title, element, options.collectElements);
      }
      if (tagName === "IMG") {
        options.visitedElements.add(element);
        const alt = element.getAttribute("alt") || "";
        if (trimFlatString(alt))
          return compositeString(alt, element, options.collectElements);
        const title = element.getAttribute("title") || "";
        return compositeString(title, element, options.collectElements);
      }
      if (tagName === "TABLE") {
        options.visitedElements.add(element);
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === "CAPTION") {
            return getTextAlternativeInternal(child, {
              ...childOptions,
              embeddedInNativeTextAlternative: { element: child, hidden: isElementHiddenForAria(child) }
            });
          }
        }
        const summary = element.getAttribute("summary") || "";
        if (summary)
          return compositeString(summary, element, options.collectElements);
      }
      if (tagName === "AREA") {
        options.visitedElements.add(element);
        const alt = element.getAttribute("alt") || "";
        if (trimFlatString(alt))
          return compositeString(alt, element, options.collectElements);
        const title = element.getAttribute("title") || "";
        return compositeString(title, element, options.collectElements);
      }
      if (tagName === "SVG" || element.ownerSVGElement) {
        options.visitedElements.add(element);
        for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
          if (elementSafeTagName(child) === "TITLE" && child.ownerSVGElement) {
            return getTextAlternativeInternal(child, {
              ...childOptions,
              embeddedInLabelledBy: { element: child, hidden: isElementHiddenForAria(child) }
            });
          }
        }
      }
      if (element.ownerSVGElement && tagName === "A") {
        const title = element.getAttribute("xlink:title") || "";
        if (trimFlatString(title)) {
          options.visitedElements.add(element);
          return compositeString(title, element, options.collectElements);
        }
      }
    }
    const shouldNameFromContentForSummary = tagName === "SUMMARY" && !["presentation", "none"].includes(role);
    if (allowsNameFromContent(role, options.embeddedInTargetElement === "descendant") || shouldNameFromContentForSummary || !!options.embeddedInLabelledBy || !!options.embeddedInDescribedBy || !!options.embeddedInLabel || !!options.embeddedInNativeTextAlternative) {
      options.visitedElements.add(element);
      const accessibleName = innerAccumulatedElementText(element, childOptions);
      const maybeTrimmedAccessibleName = options.embeddedInTargetElement === "self" ? trimFlatString(accessibleName.text) : accessibleName.text;
      if (maybeTrimmedAccessibleName) {
        if (options.outDerivedFromContent && insideTargetElement(options) && trimFlatString(accessibleName.text))
          options.outDerivedFromContent.value = true;
        accessibleName.elements?.add(element);
        return accessibleName;
      }
    }
    if (!["presentation", "none"].includes(role) || tagName === "IFRAME" || tagName === "FRAME") {
      options.visitedElements.add(element);
      const title = element.getAttribute("title") || "";
      if (trimFlatString(title))
        return compositeString(title, element, options.collectElements);
    }
    options.visitedElements.add(element);
    return emptyCompositeString();
  }
  function innerAccumulatedElementText(element, options) {
    const tokens = [];
    const elements = options.collectElements ? /* @__PURE__ */ new Set() : void 0;
    const visit = (node, skipSlotted) => {
      if (skipSlotted && node.assignedSlot)
        return;
      if (node.nodeType === 1) {
        const display = getElementComputedStyle(node)?.display || "inline";
        const childComposite = getTextAlternativeInternal(node, options);
        let token = childComposite.text;
        for (const contributor of childComposite.elements || [])
          elements?.add(contributor);
        if (display !== "inline" || node.nodeName === "BR")
          token = " " + token + " ";
        tokens.push(token);
      } else if (node.nodeType === 3) {
        tokens.push(node.textContent || "");
      }
    };
    tokens.push(getCSSContent(element, "::before") || "");
    const content = getCSSContent(element);
    if (content !== void 0) {
      tokens.push(content);
    } else {
      const assignedNodes = element.nodeName === "SLOT" ? element.assignedNodes() : [];
      if (assignedNodes.length) {
        for (const child of assignedNodes)
          visit(child, false);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling)
          visit(child, true);
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling)
            visit(child, true);
        }
        for (const owned of getIdRefs(element, element.getAttribute("aria-owns")))
          visit(owned, true);
      }
    }
    tokens.push(getCSSContent(element, "::after") || "");
    return { text: tokens.join(""), elements };
  }
  var kAriaSelectedRoles = ["gridcell", "option", "row", "tab", "rowheader", "columnheader", "treeitem"];
  function getAriaSelected(element) {
    if (elementSafeTagName(element) === "OPTION")
      return element.selected;
    if (kAriaSelectedRoles.includes(getAriaRole(element) || ""))
      return getAriaBoolean(element.getAttribute("aria-selected")) === true;
    return false;
  }
  var kAriaCheckedRoles = ["checkbox", "menuitemcheckbox", "option", "radio", "switch", "menuitemradio", "treeitem"];
  function getAriaChecked(element) {
    const result = getChecked(element, true);
    return result === "error" ? false : result;
  }
  function getChecked(element, allowMixed) {
    const tagName = elementSafeTagName(element);
    if (allowMixed && tagName === "INPUT" && element.indeterminate)
      return "mixed";
    if (tagName === "INPUT" && ["checkbox", "radio"].includes(element.type))
      return element.checked;
    if (kAriaCheckedRoles.includes(getAriaRole(element) || "")) {
      const checked = element.getAttribute("aria-checked");
      if (checked === "true")
        return true;
      if (allowMixed && checked === "mixed")
        return "mixed";
      return false;
    }
    return "error";
  }
  var kAriaPressedRoles = ["button"];
  function getAriaPressed(element) {
    if (kAriaPressedRoles.includes(getAriaRole(element) || "")) {
      const pressed = element.getAttribute("aria-pressed");
      if (pressed === "true")
        return true;
      if (pressed === "mixed")
        return "mixed";
    }
    return false;
  }
  var kAriaExpandedRoles = ["application", "button", "checkbox", "combobox", "gridcell", "link", "listbox", "menuitem", "row", "rowheader", "tab", "treeitem", "columnheader", "menuitemcheckbox", "menuitemradio", "rowheader", "switch"];
  function getAriaExpanded(element) {
    if (elementSafeTagName(element) === "DETAILS")
      return element.open;
    if (kAriaExpandedRoles.includes(getAriaRole(element) || "")) {
      const expanded = element.getAttribute("aria-expanded");
      if (expanded === null)
        return void 0;
      if (expanded === "true")
        return true;
      return false;
    }
    return void 0;
  }
  var kAriaLevelRoles = ["heading", "listitem", "row", "treeitem"];
  function getAriaLevel(element) {
    const native = { "H1": 1, "H2": 2, "H3": 3, "H4": 4, "H5": 5, "H6": 6 }[elementSafeTagName(element)];
    if (native)
      return native;
    if (kAriaLevelRoles.includes(getAriaRole(element) || "")) {
      const attr = element.getAttribute("aria-level");
      const value = attr === null ? Number.NaN : Number(attr);
      if (Number.isInteger(value) && value >= 1)
        return value;
    }
    return 0;
  }
  var kAriaDisabledRoles = ["application", "button", "composite", "gridcell", "group", "input", "link", "menuitem", "scrollbar", "separator", "tab", "checkbox", "columnheader", "combobox", "grid", "listbox", "menu", "menubar", "menuitemcheckbox", "menuitemradio", "option", "radio", "radiogroup", "row", "rowheader", "searchbox", "select", "slider", "spinbutton", "switch", "tablist", "textbox", "toolbar", "tree", "treegrid", "treeitem"];
  function getAriaDisabled(element) {
    return isNativelyDisabled(element) || hasExplicitAriaDisabled(element);
  }
  function isNativelyDisabled(element) {
    const isNativeFormControl = ["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "OPTGROUP"].includes(elementSafeTagName(element));
    return isNativeFormControl && (element.hasAttribute("disabled") || belongsToDisabledOptGroup(element) || belongsToDisabledFieldSet(element));
  }
  function belongsToDisabledOptGroup(element) {
    return elementSafeTagName(element) === "OPTION" && !!element.closest("OPTGROUP[DISABLED]");
  }
  function belongsToDisabledFieldSet(element) {
    const fieldSetElement = element?.closest("FIELDSET[DISABLED]");
    if (!fieldSetElement)
      return false;
    const legendElement = fieldSetElement.querySelector(":scope > LEGEND");
    return !legendElement || !legendElement.contains(element);
  }
  function hasExplicitAriaDisabled(element) {
    if (!kAriaDisabledRoles.includes(getAriaRole(element) || ""))
      return false;
    return hasAriaDisabledInChain(element);
  }
  function hasAriaDisabledInChain(element) {
    let result = cacheAriaDisabled?.get(element);
    if (result === void 0) {
      const attribute = (element.getAttribute("aria-disabled") || "").toLowerCase();
      if (attribute === "true") {
        result = true;
      } else if (attribute === "false") {
        result = false;
      } else {
        const parent = parentElementOrShadowHost(element);
        result = parent ? hasAriaDisabledInChain(parent) : false;
      }
      cacheAriaDisabled?.set(element, result);
    }
    return result;
  }
  function getAccessibleNameFromAssociatedLabels(labels, options) {
    return joinCompositeString([...labels].map((label) => getTextAlternativeInternal(label, {
      ...options,
      embeddedInLabel: { element: label, hidden: isElementHiddenForAria(label) },
      embeddedInNativeTextAlternative: void 0,
      embeddedInLabelledBy: void 0,
      embeddedInDescribedBy: void 0,
      embeddedInTargetElement: void 0
    })).filter((accessibleName) => !!accessibleName.text), " ", options.collectElements);
  }
  function receivesPointerEvents(element) {
    const cache = cachePointerEvents;
    let e = element;
    let result;
    const parents = [];
    for (; e; e = parentElementOrShadowHost(e)) {
      const cached = cache.get(e);
      if (cached !== void 0) {
        result = cached;
        break;
      }
      parents.push(e);
      const style = getElementComputedStyle(e);
      if (!style) {
        result = true;
        break;
      }
      const value = style.pointerEvents;
      if (value) {
        result = value !== "none";
        break;
      }
    }
    if (result === void 0)
      result = true;
    for (const parent of parents)
      cache.set(parent, result);
    return result;
  }
  var cacheAccessibleName;
  var cacheAccessibleNameHidden;
  var cacheAccessibleNameText;
  var cacheAccessibleNameTextHidden;
  var cacheAccessibleDescription;
  var cacheAccessibleDescriptionHidden;
  var cacheAccessibleErrorMessage;
  var cacheIsHidden;
  var cachePseudoContent;
  var cachePseudoContentBefore;
  var cachePseudoContentAfter;
  var cachePointerEvents;
  var cacheAriaRole;
  var cacheAriaDisabled;
  var cachesCounter2 = 0;
  function beginAriaCaches() {
    beginDOMCaches();
    ++cachesCounter2;
    cacheAriaRole ??= /* @__PURE__ */ new Map();
    cacheAriaDisabled ??= /* @__PURE__ */ new Map();
    cacheAccessibleName ??= /* @__PURE__ */ new Map();
    cacheAccessibleNameHidden ??= /* @__PURE__ */ new Map();
    cacheAccessibleNameText ??= /* @__PURE__ */ new Map();
    cacheAccessibleNameTextHidden ??= /* @__PURE__ */ new Map();
    cacheAccessibleDescription ??= /* @__PURE__ */ new Map();
    cacheAccessibleDescriptionHidden ??= /* @__PURE__ */ new Map();
    cacheAccessibleErrorMessage ??= /* @__PURE__ */ new Map();
    cacheIsHidden ??= /* @__PURE__ */ new Map();
    cachePseudoContent ??= /* @__PURE__ */ new Map();
    cachePseudoContentBefore ??= /* @__PURE__ */ new Map();
    cachePseudoContentAfter ??= /* @__PURE__ */ new Map();
    cachePointerEvents ??= /* @__PURE__ */ new Map();
  }
  function endAriaCaches() {
    if (!--cachesCounter2) {
      cacheAccessibleName = void 0;
      cacheAccessibleNameHidden = void 0;
      cacheAccessibleNameText = void 0;
      cacheAccessibleNameTextHidden = void 0;
      cacheAccessibleDescription = void 0;
      cacheAccessibleDescriptionHidden = void 0;
      cacheAccessibleErrorMessage = void 0;
      cacheIsHidden = void 0;
      cachePseudoContent = void 0;
      cachePseudoContentBefore = void 0;
      cachePseudoContentAfter = void 0;
      cachePointerEvents = void 0;
      cacheAriaRole = void 0;
      cacheAriaDisabled = void 0;
    }
    endDOMCaches();
  }
  var inputTypeToRole = {
    "button": "button",
    "checkbox": "checkbox",
    "image": "button",
    "number": "spinbutton",
    "radio": "radio",
    "range": "slider",
    "reset": "button",
    "submit": "button"
  };
  function emptyCompositeString() {
    return { text: "" };
  }
  function compositeString(text, element, collectElements) {
    const elements = text && collectElements ? /* @__PURE__ */ new Set([element]) : void 0;
    return { text: text || "", elements };
  }
  function joinCompositeString(parts, separator, collectElements) {
    let elements;
    if (collectElements) {
      elements = /* @__PURE__ */ new Set();
      for (const part of parts) {
        for (const element of part.elements || [])
          elements.add(element);
      }
    }
    return { text: parts.map((part) => part.text).join(separator), elements };
  }

  // browser-agent/vendor/playwright/injected/ariaSnapshot.ts
  var lastRef = 0;
  function toInternalOptions(options) {
    const renderBoxes = options.boxes;
    if (options.mode === "ai") {
      return {
        visibility: "ariaOrVisible",
        refs: "interactable",
        refPrefix: options.refPrefix,
        includeGenericRole: true,
        renderActive: !options.doNotRenderActive,
        renderCursorPointer: true,
        renderBoxes
      };
    }
    if (options.mode === "autoexpect") {
      return { visibility: "ariaAndVisible", refs: "none", renderBoxes };
    }
    return { visibility: "aria", refs: "none", renderBoxes };
  }
  function generateAriaTree(rootElement, publicOptions) {
    const options = toInternalOptions(publicOptions);
    const visited = /* @__PURE__ */ new Set();
    const nameSourceElements = /* @__PURE__ */ new Map();
    const snapshot2 = {
      root: { role: "fragment", name: "", children: [], props: {}, box: computeBox(rootElement), receivesPointerEvents: true },
      info: /* @__PURE__ */ new Map(),
      refs: /* @__PURE__ */ new Map(),
      iframeRefs: []
    };
    setAriaNodeElement(snapshot2.root, rootElement);
    const visit = (ariaNode, node, parentElementVisible) => {
      if (visited.has(node))
        return;
      visited.add(node);
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue) {
        if (!parentElementVisible)
          return;
        const text = node.nodeValue;
        if (ariaNode.role !== "textbox" && text)
          ariaNode.children.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE)
        return;
      const element = node;
      const isElementVisibleForAria = !isElementHiddenForAria(element);
      let visible = isElementVisibleForAria;
      if (options.visibility === "ariaOrVisible")
        visible = isElementVisibleForAria || isElementVisible(element);
      if (options.visibility === "ariaAndVisible")
        visible = isElementVisibleForAria && isElementVisible(element);
      if (options.visibility === "aria" && !visible)
        return;
      const ariaChildren = [];
      if (element.hasAttribute("aria-owns")) {
        const ids = element.getAttribute("aria-owns").split(/\s+/);
        for (const id of ids) {
          const ownedElement = rootElement.ownerDocument.getElementById(id);
          if (ownedElement)
            ariaChildren.push(ownedElement);
        }
      }
      const childAriaNode = visible ? toAriaNode(element, options, nameSourceElements) : null;
      if (childAriaNode && element.getAttribute("aria-hidden")?.toLowerCase() === "true")
        childAriaNode.props["aria-hidden"] = "true";
      let elementInfo;
      if (childAriaNode) {
        if (childAriaNode.ref) {
          elementInfo = { element, nameFromContentRefs: [] };
          snapshot2.info.set(childAriaNode.ref, elementInfo);
          snapshot2.refs.set(element, childAriaNode.ref);
          if (childAriaNode.role === "iframe")
            snapshot2.iframeRefs.push(childAriaNode.ref);
        }
        ariaNode.children.push(childAriaNode);
      }
      processElement(childAriaNode || ariaNode, element, ariaChildren, visible);
      if (elementInfo) {
        for (const contributor of nameSourceElements.get(childAriaNode) || []) {
          const ref = snapshot2.refs.get(contributor);
          if (ref && ref !== childAriaNode.ref)
            elementInfo.nameFromContentRefs.push(ref);
        }
      }
    };
    function processElement(ariaNode, element, ariaChildren, parentElementVisible) {
      const display = getElementComputedStyle(element)?.display || "inline";
      const treatAsBlock = display !== "inline" || element.nodeName === "BR" ? " " : "";
      if (treatAsBlock)
        ariaNode.children.push(treatAsBlock);
      ariaNode.children.push(getCSSContent(element, "::before") || "");
      const assignedNodes = element.nodeName === "SLOT" ? element.assignedNodes() : [];
      if (assignedNodes.length) {
        for (const child of assignedNodes)
          visit(ariaNode, child, parentElementVisible);
      } else {
        for (let child = element.firstChild; child; child = child.nextSibling) {
          if (!child.assignedSlot)
            visit(ariaNode, child, parentElementVisible);
        }
        if (element.shadowRoot) {
          for (let child = element.shadowRoot.firstChild; child; child = child.nextSibling)
            visit(ariaNode, child, parentElementVisible);
        }
      }
      for (const child of ariaChildren)
        visit(ariaNode, child, parentElementVisible);
      ariaNode.children.push(getCSSContent(element, "::after") || "");
      if (treatAsBlock)
        ariaNode.children.push(treatAsBlock);
      if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0])
        ariaNode.children = [];
      if (ariaNode.role === "link" && element.hasAttribute("href")) {
        const href = element.getAttribute("href");
        ariaNode.props["url"] = truncateDataUrl(href);
      }
      if (ariaNode.role === "textbox" && element.hasAttribute("placeholder") && element.getAttribute("placeholder") !== ariaNode.name) {
        const placeholder = element.getAttribute("placeholder");
        ariaNode.props["placeholder"] = placeholder;
      }
    }
    beginAriaCaches();
    try {
      visit(snapshot2.root, rootElement, true);
    } finally {
      endAriaCaches();
    }
    distillAriaSnapshot(snapshot2, publicOptions);
    return snapshot2;
  }
  function computeAriaRef(ariaNode, options) {
    if (options.refs === "none")
      return;
    if (options.refs === "interactable" && (!ariaNode.box.visible || !ariaNode.receivesPointerEvents))
      return;
    const element = ariaNodeElement(ariaNode);
    let ariaRef = element._ariaRef;
    if (!ariaRef || ariaRef.role !== ariaNode.role || ariaRef.name !== ariaNode.name) {
      ariaRef = { role: ariaNode.role, name: ariaNode.name, ref: (options.refPrefix ?? "") + "e" + ++lastRef };
      element._ariaRef = ariaRef;
    }
    ariaNode.ref = ariaRef.ref;
  }
  function toAriaNode(element, options, nameSourceElements) {
    const active = element.ownerDocument.activeElement === element && element.ownerDocument.hasFocus();
    if (element.nodeName === "IFRAME" || element.nodeName === "FRAME") {
      const ariaNode = {
        role: "iframe",
        name: "",
        children: [],
        props: {},
        box: computeBox(element),
        receivesPointerEvents: true,
        active
      };
      setAriaNodeElement(ariaNode, element);
      computeAriaRef(ariaNode, options);
      return ariaNode;
    }
    const defaultRole = options.includeGenericRole ? "generic" : null;
    const role = getAriaRole(element) ?? defaultRole;
    if (!role || role === "presentation" || role === "none")
      return null;
    const name = getElementAccessibleName(element, false);
    const receivesPointerEvents2 = receivesPointerEvents(element);
    const box = computeBox(element);
    if (role === "generic" && box.inline && element.childNodes.length === 1 && element.childNodes[0].nodeType === Node.TEXT_NODE)
      return null;
    const result = {
      role,
      name: normalizeWhiteSpace(name.text),
      children: [],
      props: {},
      box,
      receivesPointerEvents: receivesPointerEvents2,
      active
    };
    setAriaNodeElement(result, element);
    nameSourceElements.set(result, name.elements);
    computeAriaRef(result, options);
    if (kAriaCheckedRoles.includes(role))
      result.checked = getAriaChecked(element);
    if (kAriaDisabledRoles.includes(role))
      result.disabled = getAriaDisabled(element);
    if (kAriaExpandedRoles.includes(role))
      result.expanded = getAriaExpanded(element);
    if (kAriaInvalidRoles.includes(role)) {
      const invalid = getAriaInvalid(element);
      result.invalid = invalid === "false" ? false : invalid === "true" ? true : invalid;
    }
    if (kAriaLevelRoles.includes(role))
      result.level = getAriaLevel(element);
    if (kAriaPressedRoles.includes(role))
      result.pressed = getAriaPressed(element);
    if (kAriaSelectedRoles.includes(role))
      result.selected = getAriaSelected(element);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.type !== "checkbox" && element.type !== "radio" && element.type !== "file")
        result.children = [element.value];
    }
    return result;
  }
  function renderAriaTreeAsJSON(ariaSnapshot, publicOptions) {
    const options = toInternalOptions(publicOptions);
    const iframeDepths = {};
    const visit = (ariaNode, depth, renderCursorPointer) => {
      if (ariaNode.role === "iframe" && ariaNode.ref)
        iframeDepths[ariaNode.ref] = depth;
      const node = { role: ariaNode.role };
      if (ariaNode.name)
        node.name = ariaNode.name;
      if (ariaNode.checked === "mixed" || ariaNode.checked === true)
        node.checked = ariaNode.checked;
      if (ariaNode.disabled)
        node.disabled = true;
      if (ariaNode.expanded)
        node.expanded = true;
      if (ariaNode.active && options.renderActive)
        node.active = true;
      if (ariaNode.invalid)
        node.invalid = ariaNode.invalid;
      if (ariaNode.level)
        node.level = ariaNode.level;
      if (ariaNode.pressed === "mixed" || ariaNode.pressed === true)
        node.pressed = ariaNode.pressed;
      if (ariaNode.selected === true)
        node.selected = true;
      if (ariaNode.ref) {
        node.ref = ariaNode.ref;
        if (renderCursorPointer && hasPointerCursor(ariaNode))
          node.cursor = "pointer";
      }
      if (options.renderBoxes) {
        const element = ariaNodeElement(ariaNode);
        if (element) {
          const r = element.getBoundingClientRect();
          node.box = { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        }
      }
      if (ariaNode.props.url !== void 0)
        node.url = ariaNode.props.url;
      if (ariaNode.props.placeholder !== void 0)
        node.placeholder = ariaNode.props.placeholder;
      if (ariaNode.props["aria-hidden"] !== void 0)
        node.ariaHidden = true;
      const singleTextChild = ariaNode.children.length === 1 && typeof ariaNode.children[0] === "string" ? ariaNode.children[0] : void 0;
      const isAtDepthLimit = !!publicOptions.depth && depth === publicOptions.depth;
      if (singleTextChild !== void 0) {
        node.text = singleTextChild;
      } else if (!isAtDepthLimit && ariaNode.children.length) {
        const inCursorPointer = !!ariaNode.ref && renderCursorPointer && hasPointerCursor(ariaNode);
        node.children = ariaNode.children.map((child) => {
          if (typeof child === "string")
            return child;
          return visit(child, depth + 1, renderCursorPointer && !inCursorPointer);
        });
      }
      return node;
    };
    const json = [];
    const nodesToRender = ariaSnapshot.root.role === "fragment" ? ariaSnapshot.root.children : [ariaSnapshot.root];
    for (const nodeToRender of nodesToRender) {
      if (typeof nodeToRender === "string")
        json.push({ role: "text", text: nodeToRender });
      else
        json.push(visit(nodeToRender, 0, !!options.renderCursorPointer));
    }
    return { json, iframeDepths };
  }
  var elementSymbol = /* @__PURE__ */ Symbol("element");
  function ariaNodeElement(ariaNode) {
    return ariaNode[elementSymbol];
  }
  function setAriaNodeElement(ariaNode, element) {
    ariaNode[elementSymbol] = element;
  }

  // browser-agent/src/act.ts
  function pointAt(el) {
    el.scrollIntoView?.({
      block: "center",
      inline: "center",
      behavior: "instant"
    });
    const box = visibleBox(el);
    if (box) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    if (!isRendered(el))
      return {
        error: "not-visible",
        detail: `${describe(el)} is not being rendered at the moment \u2014 it, or something above it, is hidden (\`display: none\`, \`visibility: hidden\`). Whatever hides it has to be opened first; then take a new snapshot and use a ref from that one.`
      };
    const own = largestBox(el);
    if (own.width <= 1 || own.height <= 1) return unreachable(el);
    if (isParkedOutsideTheDocument(el, own)) return unreachable(el, "parked");
    return {
      error: "not-visible",
      detail: `${describe(el)} is laid out but none of it is inside the viewport, even after scrolling to it \u2014 something between it and the page is holding it off screen.`
    };
  }
  function isParkedOutsideTheDocument(el, box) {
    const viewport = document.scrollingElement ?? document.documentElement;
    for (let node = el; node; node = parentElementOf(node)) {
      const page = node === document.body || node === document.documentElement;
      const style = getComputedStyle(node);
      if (page) {
        if (node !== viewport && (node.scrollTop !== 0 || node.scrollLeft !== 0))
          return false;
      } else if (node !== el && (style.overflowX !== "visible" || style.overflowY !== "visible")) {
        return false;
      }
      if (style.transform !== "none") return false;
    }
    return box.right + window.scrollX < -window.innerWidth && box.right < -window.innerWidth || box.bottom + window.scrollY < -window.innerHeight && box.bottom < -window.innerHeight;
  }
  function unreachable(el, shape = "erased", touched) {
    const instead = touched ? `; ${describe(touched)} is what a pointer there would touch` : "";
    const wrong = shape === "parked" ? `is parked outside the page, further out than any scroll reaches` : `is in the accessibility tree but paints nothing on screen`;
    const act2 = shape === "parked" ? `act on a ref a pointer can land on.` : `act on a ref that is actually drawn on the page.`;
    return {
      error: "not-visible",
      detail: `${describe(el)} ${wrong}${instead}. A person could not reach it either, and no snapshot will change that \u2014 ` + act2
    };
  }
  function isVisuallyErased(el) {
    const style = getComputedStyle(el);
    const positioned = style.position === "absolute" || style.position === "fixed";
    const rect = style.clip.match(
      /^rect\((-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px,?\s*(-?[\d.]+)px\)$/
    );
    if (positioned && rect) {
      const [top, right, bottom, left] = rect.slice(1).map(Number);
      if (bottom - top <= 1 || right - left <= 1) return true;
    }
    const path = style.clipPath.match(/^inset\(([^)]*?)(?:\s+round\s.*)?\)$/);
    if (path) {
      const sides = insetSides(path[1].trim().split(/\s+/));
      if (sides && (sides.top + sides.bottom >= 100 || sides.left + sides.right >= 100))
        return true;
    }
    return false;
  }
  function insetSides(parts) {
    if (parts.length < 1 || parts.length > 4) return null;
    const percents = parts.map(
      (part) => Number.parseFloat(part) === 0 ? 0 : part.endsWith("%") ? Number.parseFloat(part) : NaN
    );
    if (percents.some(Number.isNaN)) return null;
    const [a, b = a, c = a, d = b] = percents;
    return { top: a, right: b, bottom: c, left: d };
  }
  function largestBox(el) {
    const rects = Array.from(el.getClientRects());
    return rects.length ? rects.reduce((a, b) => a.width * a.height >= b.width * b.height ? a : b) : el.getBoundingClientRect();
  }
  function visibleBox(el) {
    const box = largestBox(el);
    const left = Math.max(box.left, 0);
    const top = Math.max(box.top, 0);
    const right = Math.min(box.right, window.innerWidth);
    const bottom = Math.min(box.bottom, window.innerHeight);
    if (right - left <= 1 || bottom - top <= 1) return null;
    return new DOMRect(left, top, right - left, bottom - top);
  }
  function obstructionAt(x, y, target) {
    if (typeof document.elementFromPoint !== "function") return null;
    const hit = deepElementFromPoint(x, y);
    if (!hit) return document.documentElement;
    for (let node = hit; node; node = parentOf(node)) {
      if (node === target) return null;
    }
    return hit;
  }
  function pointerReach(target, point) {
    const cover = obstructionAt(point.x, point.y, target);
    if (!cover) return null;
    if (isVisuallyErased(target)) return unreachable(target, "erased", cover);
    return { error: "obscured", detail: obscuredBy(cover, target) };
  }
  function obscuredBy(cover, target) {
    const named = describe(target);
    const actionable = cover !== document.documentElement && cover !== document.body;
    if (!actionable || !isAncestorOf(cover, target))
      return `${describe(cover)} is on top of ${named} where a pointer would land`;
    const shared = textOf(cover) === textOf(target);
    return `${describeNode(cover, !shared)} is an ancestor of ${named} and paints over it where a pointer would land \u2014 act on the ancestor, the way a person clicking the card would.`;
  }
  function isAncestorOf(maybe, node) {
    for (let up = parentOf(node); up; up = parentOf(up))
      if (up === maybe) return true;
    return false;
  }
  function deepElementFromPoint(x, y) {
    if (typeof document.elementFromPoint !== "function") return null;
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  function parentOf(node) {
    const parent = node.parentNode;
    return parent instanceof ShadowRoot ? parent.host : parent;
  }
  var PointerCtor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  function clickAt(el, point, button, count, stillCurrent = () => true) {
    const buttonCode = button === "right" ? 2 : 0;
    const held = button === "right" ? 2 : 1;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      screenX: point.x,
      screenY: point.y,
      button: buttonCode
    };
    const pointer = (type, init = {}) => el.dispatchEvent(
      new PointerCtor(type, {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...init
      })
    );
    const mouse = (type, init = {}) => el.dispatchEvent(new MouseEvent(type, { ...base, ...init }));
    enter(el, point);
    let delivered = 0;
    for (let i = 1; i <= count; i++) {
      if (i > 1 && !stillCurrent()) break;
      const downOk = pointer("pointerdown", { detail: i, buttons: held });
      if (downOk) {
        const mouseDownOk = mouse("mousedown", { detail: i, buttons: held });
        if (mouseDownOk) focusFrom(el);
      }
      pointer("pointerup", { detail: i, buttons: 0 });
      if (downOk) mouse("mouseup", { detail: i, buttons: 0 });
      if (button === "right") mouse("contextmenu", { detail: i });
      else mouse("click", { detail: i });
      delivered = i;
    }
    if (button === "left" && count >= 2 && delivered === count)
      mouse("dblclick", { detail: delivered });
    return delivered;
  }
  function isDisabledControl(el) {
    try {
      return el.matches(":disabled");
    } catch {
      return el.disabled === true;
    }
  }
  function isRendered(el) {
    const check = el.checkVisibility;
    if (typeof check === "function")
      return check.call(el, { visibilityProperty: true });
    if (getComputedStyle(el).visibility === "hidden") return false;
    for (let node = el; node; node = parentElementOf(node)) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.contentVisibility === "hidden")
        return false;
    }
    return true;
  }
  function hoverAt(el, point) {
    enter(el, point);
  }
  function enter(el, point) {
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      screenX: point.x,
      screenY: point.y
    };
    const pointer = (type, init = {}) => el.dispatchEvent(
      new PointerCtor(type, {
        ...base,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        ...init
      })
    );
    const mouse = (type, init = {}) => el.dispatchEvent(new MouseEvent(type, { ...base, ...init }));
    pointer("pointerover");
    pointer("pointerenter", { bubbles: false });
    mouse("mouseover");
    mouse("mouseenter", { bubbles: false });
    pointer("pointermove");
    mouse("mousemove");
  }
  function focusFrom(el) {
    for (let node = el; node; node = parentElementOf(node)) {
      if (node instanceof HTMLElement && isFocusable2(node)) {
        node.focus({ preventScroll: true });
        return;
      }
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  }
  function parentElementOf(el) {
    const parent = el.parentNode;
    if (parent instanceof ShadowRoot) return parent.host;
    return parent instanceof Element ? parent : null;
  }
  function isFocusable2(el) {
    return el.tabIndex >= 0 || el.hasAttribute("tabindex") || el.isContentEditable;
  }
  var NON_TEXT_INPUTS = /* @__PURE__ */ new Set([
    "button",
    "checkbox",
    "radio",
    "submit",
    "reset",
    "file",
    "image",
    "hidden"
  ]);
  function isTextControl(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
  }
  function editableFrom(el) {
    if (isTextControl(el)) return el;
    const reachable = (candidate) => candidate && isTextControl(candidate) && isRendered(candidate) ? candidate : null;
    if (el instanceof HTMLLabelElement) return reachable(el.control);
    if (el instanceof HTMLElement && el.isContentEditable) {
      let host = el;
      while (host.parentElement instanceof HTMLElement && host.parentElement.isContentEditable)
        host = host.parentElement;
      return host;
    }
    return reachable(el.querySelector("input:not([type=hidden]), textarea"));
  }
  function typeInto(el, text) {
    const target = editableFrom(el);
    if (!target)
      return { error: "not-editable", detail: `${describe(el)} takes no text` };
    if (isTextControl(target)) {
      if (isDisabledControl(target))
        return {
          error: "disabled",
          detail: `${describe(target)} is disabled`
        };
      if (target.readOnly)
        return {
          error: "not-editable",
          detail: `${describe(target)} is read-only`
        };
      target.focus({ preventScroll: true });
      replaceValue(target, text);
      return null;
    }
    target.focus({ preventScroll: true });
    replaceContents(target, text);
    return null;
  }
  function replaceValue(input, text) {
    let done = false;
    try {
      input.select();
      done = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
    } catch {
      done = false;
    }
    if (!done || input.value !== text) {
      setNativeValue(input, text);
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: text ? "insertText" : "deleteContentBackward",
          data: text || null
        })
      );
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }
  function replaceContents(host, text) {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(host);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    let done = false;
    try {
      done = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
    } catch {
      done = false;
    }
    if (!done) {
      host.textContent = text;
      host.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: text ? "insertText" : "deleteContentBackward",
          data: text || null
        })
      );
    }
  }
  var NAMED_KEYS = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    Insert: { code: "Insert", keyCode: 45 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Space: { code: "Space", keyCode: 32, key: " " }
  };
  for (let n = 1; n <= 12; n++)
    NAMED_KEYS[`F${n}`] = { code: `F${n}`, keyCode: 111 + n };
  var KEY_ALIASES = {
    Return: "Enter",
    Esc: "Escape",
    Del: "Delete",
    Up: "ArrowUp",
    Down: "ArrowDown",
    Left: "ArrowLeft",
    Right: "ArrowRight",
    " ": "Space",
    Spacebar: "Space"
  };
  var MODIFIER_ALIASES = {
    Control: "ctrl",
    Ctrl: "ctrl",
    Shift: "shift",
    Alt: "alt",
    Option: "alt",
    Meta: "meta",
    Cmd: "meta",
    Command: "meta",
    Super: "meta"
  };
  var PUNCTUATION = {
    "-": { code: "Minus", keyCode: 189 },
    "=": { code: "Equal", keyCode: 187 },
    "[": { code: "BracketLeft", keyCode: 219 },
    "]": { code: "BracketRight", keyCode: 221 },
    "\\": { code: "Backslash", keyCode: 220 },
    ";": { code: "Semicolon", keyCode: 186 },
    "'": { code: "Quote", keyCode: 222 },
    ",": { code: "Comma", keyCode: 188 },
    ".": { code: "Period", keyCode: 190 },
    "/": { code: "Slash", keyCode: 191 },
    "`": { code: "Backquote", keyCode: 192 }
  };
  function keyDescription(spec) {
    const parts = spec.split("+");
    const last = parts.pop() ?? "";
    let name = last === "" && spec.endsWith("+") ? "+" : last;
    const mods = { ctrl: false, shift: false, alt: false, meta: false };
    for (const part of parts) {
      if (part === "") continue;
      const mod = MODIFIER_ALIASES[part];
      if (!mod) return null;
      mods[mod] = true;
    }
    name = KEY_ALIASES[name] ?? name;
    if (name.length === 1) {
      const upper = name.toUpperCase();
      let code = "";
      let keyCode = 0;
      if (/[A-Z]/.test(upper)) {
        code = `Key${upper}`;
        keyCode = upper.charCodeAt(0);
      } else if (/[0-9]/.test(name)) {
        code = `Digit${name}`;
        keyCode = name.charCodeAt(0);
      } else if (PUNCTUATION[name]) {
        ;
        ({ code, keyCode } = PUNCTUATION[name]);
      }
      return { key: name, code, keyCode, ...mods, printable: true };
    }
    const named = NAMED_KEYS[name];
    if (!named) return null;
    return {
      key: named.key ?? name,
      code: named.code,
      keyCode: named.keyCode,
      ...mods,
      printable: false
    };
  }
  function pressOn(el, spec) {
    const desc = keyDescription(spec);
    if (!desc)
      return {
        error: "unsupported",
        detail: `"${spec}" is not a key this browser knows`
      };
    if (el && isDisabledControl(el))
      return { error: "disabled", detail: `${describe(el)} is disabled` };
    if (el instanceof HTMLElement && deepActiveElement() !== el)
      el.focus({ preventScroll: true });
    const target = el ?? deepActiveElement() ?? document.body;
    if (!target)
      return { error: "not-visible", detail: "the page has no body yet" };
    const init = {
      key: desc.key,
      code: desc.code,
      keyCode: desc.keyCode,
      which: desc.keyCode,
      ctrlKey: desc.ctrl,
      shiftKey: desc.shift,
      altKey: desc.alt,
      metaKey: desc.meta,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    let scrolled = null;
    const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
    if (proceed) {
      const plain = !desc.ctrl && !desc.alt && !desc.meta;
      if (desc.printable && plain) {
        if (target.dispatchEvent(
          new KeyboardEvent("keypress", {
            ...init,
            charCode: desc.key.charCodeAt(0)
          })
        ))
          insertTyped(target, desc.key);
      } else {
        scrolled = defaultActionFor(target, desc, el !== null) ?? null;
      }
    }
    target.dispatchEvent(
      new KeyboardEvent("keyup", { ...init, cancelable: false })
    );
    return { scrolled };
  }
  function deepActiveElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement)
      active = active.shadowRoot.activeElement;
    return active;
  }
  function insertTyped(target, char) {
    const editable = editableFrom(target);
    if (!editable) return;
    if (isTextControl(editable) && (isDisabledControl(editable) || editable.readOnly))
      return;
    let done = false;
    try {
      done = document.execCommand("insertText", false, char);
    } catch {
      done = false;
    }
    if (done) return;
    if (isTextControl(editable)) {
      const start = editable.selectionStart ?? editable.value.length;
      const end = editable.selectionEnd ?? editable.value.length;
      setNativeValue(
        editable,
        editable.value.slice(0, start) + char + editable.value.slice(end)
      );
      try {
        editable.setSelectionRange(start + char.length, start + char.length);
      } catch {
      }
    } else {
      editable.textContent = (editable.textContent ?? "") + char;
    }
    editable.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: char
      })
    );
  }
  function defaultActionFor(target, desc, named) {
    const plain = !desc.ctrl && !desc.alt && !desc.meta;
    switch (desc.key) {
      case "Enter": {
        if (desc.alt) return;
        if (target instanceof HTMLTextAreaElement && plain) {
          insertTyped(target, "\n");
          return;
        }
        if (target instanceof HTMLElement && target.isContentEditable && plain) {
          try {
            document.execCommand("insertParagraph");
          } catch {
          }
          return;
        }
        if (target instanceof HTMLInputElement && isTextControl(target)) {
          submitImplicitly(target);
          return;
        }
        if (isActivatable(target)) target.click();
        return;
      }
      case " ": {
        if (!plain) return;
        if (target instanceof HTMLButtonElement || isCheckable(target)) {
          target.click();
          return;
        }
        insertTyped(target, " ");
        return;
      }
      case "Tab": {
        if (desc.ctrl || desc.alt || desc.meta) return;
        moveFocus(target, desc.shift ? -1 : 1);
        return;
      }
      case "Backspace":
      case "Delete": {
        if (!plain) return;
        const editable = editableFrom(target);
        if (!editable) return;
        try {
          document.execCommand(
            desc.key === "Backspace" ? "delete" : "forwardDelete"
          );
        } catch {
        }
        return;
      }
      case "PageDown":
      case "PageUp":
      case "Home":
      case "End": {
        const ends = desc.key === "Home" || desc.key === "End";
        if (desc.alt) return;
        if (!ends && !plain) return;
        if (target instanceof HTMLSelectElement) return;
        const caret = isTextControl(target) || target instanceof HTMLElement && target.isContentEditable;
        if (caret && ends) return;
        return scrollByKey(target, desc.key, named);
      }
      default:
        return;
    }
  }
  var PAGE_FRACTION = 0.875;
  function scrollByKey(from, key, named) {
    const scroller = scrollerFor(from, named);
    const before = scroller.scrollTop;
    const page = Math.max(1, scroller.clientHeight * PAGE_FRACTION);
    switch (key) {
      case "PageDown":
        scrollTopTo(scroller, before + page);
        break;
      case "PageUp":
        scrollTopTo(scroller, before - page);
        break;
      case "Home":
        scrollTopTo(scroller, 0);
        break;
      case "End":
        scrollTopTo(scroller, scroller.scrollHeight);
        break;
    }
    const after = scroller.scrollTop;
    return {
      by: Math.round(after - before),
      top: Math.round(after),
      max: Math.round(Math.max(0, scroller.scrollHeight - scroller.clientHeight))
    };
  }
  function scrollTopTo(el, top) {
    if (typeof el.scrollTo === "function")
      el.scrollTo({ top, behavior: "instant" });
    else el.scrollTop = top;
  }
  function scrollerFor(from, named = true) {
    const own = scrollableAncestorOf(from);
    if (own) return own;
    const page = document.scrollingElement ?? document.documentElement;
    if (named || page.scrollHeight - page.clientHeight > 1) return page;
    const middle = deepElementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2)
    );
    return (middle && scrollableAncestorOf(middle)) ?? page;
  }
  function scrollableAncestorOf(from) {
    for (let node = from; node; node = parentElementOf(node)) {
      if (node === document.body || node === document.documentElement) break;
      if (scrollsVertically(node)) return node;
    }
    return null;
  }
  function scrollsVertically(el) {
    if (el.clientHeight <= 0) return false;
    if (el.scrollHeight - el.clientHeight <= 1) return false;
    const overflow = getComputedStyle(el).overflowY;
    return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
  }
  function isActivatable(el) {
    if (el instanceof HTMLButtonElement) return true;
    if (el instanceof HTMLAnchorElement) return el.hasAttribute("href");
    if (el instanceof HTMLInputElement)
      return el.type === "submit" || el.type === "button" || el.type === "reset" || el.type === "image";
    return false;
  }
  function isCheckable(el) {
    return el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
  }
  function submitImplicitly(input) {
    const form = input.form;
    if (!form || isDisabledControl(input)) return;
    const elements = Array.from(form.elements);
    const button = elements.find(
      (el) => el instanceof HTMLButtonElement && el.type === "submit" || el instanceof HTMLInputElement && (el.type === "submit" || el.type === "image")
    );
    if (button instanceof HTMLElement) {
      if (!button.disabled) button.click();
      return;
    }
    const blocking = elements.filter(
      (el) => el instanceof HTMLInputElement && isTextControl(el) && el.type !== "hidden"
    );
    if (blocking.length > 1) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  }
  function moveFocus(from, direction) {
    const candidates = Array.from(
      document.querySelectorAll(
        "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]"
      )
    ).filter((el) => isTabbable(el));
    if (candidates.length === 0) return;
    const index = candidates.indexOf(from);
    const next = index === -1 ? direction === 1 ? candidates[0] : candidates[candidates.length - 1] : candidates[(index + direction + candidates.length) % candidates.length];
    next.focus({ preventScroll: true });
  }
  function isTabbable(el) {
    if (el.tabIndex < 0) return false;
    if (el.disabled) return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return el.getClientRects().length > 0;
  }
  var OPTIONS_LISTED = 20;
  function selectIn(el, values) {
    const other = el instanceof HTMLLabelElement ? el.control : el.closest("select") ?? el.querySelector("select");
    const select = el instanceof HTMLSelectElement ? el : other instanceof HTMLSelectElement && isRendered(other) ? other : null;
    if (!select)
      return { error: "not-editable", detail: `${describe(el)} is not a select` };
    if (isDisabledControl(select))
      return { error: "disabled", detail: `${describe(select)} is disabled` };
    if (values.length === 0)
      return { error: "unsupported", detail: "no value to select" };
    if (!select.multiple && values.length > 1)
      return {
        error: "unsupported",
        detail: `${describe(select)} takes one value`
      };
    const options = Array.from(select.options);
    const picked = [];
    for (const wanted of values) {
      const matches = (o) => o.value === wanted || o.label === wanted || (o.textContent ?? "").trim() === wanted;
      const usable = (o) => !o.disabled && !(o.parentElement instanceof HTMLOptGroupElement && o.parentElement.disabled);
      const option = options.find((o) => usable(o) && o.value === wanted) ?? options.find((o) => usable(o) && matches(o));
      if (!option) {
        const disabled = options.find((o) => !usable(o) && matches(o));
        if (disabled)
          return {
            error: "disabled",
            detail: `option ${JSON.stringify(wanted)} in ${describe(select)} is disabled`
          };
        const listed = options.slice(0, OPTIONS_LISTED).map((o) => JSON.stringify(o.value || o.label)).join(", ");
        const more = options.length > OPTIONS_LISTED ? `, \u2026 (${options.length} in all)` : "";
        return {
          error: "no-option",
          detail: `no option ${JSON.stringify(wanted)} in ${describe(select)}; the options are ${listed}${more}`
        };
      }
      picked.push(option);
    }
    select.focus({ preventScroll: true });
    for (const option of options) option.selected = false;
    for (const option of picked) option.selected = true;
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return null;
  }
  function describe(el) {
    return describeNode(el, true);
  }
  function describeNode(el, withText) {
    let name = el.tagName.toLowerCase();
    if (el.id) name += `#${el.id}`;
    if (!withText) return name;
    const text = textOf(el);
    if (text) name += ` "${text.length > 40 ? `${text.slice(0, 40)}\u2026` : text}"`;
    return name;
  }
  function textOf(el) {
    return (el.textContent ?? "").trim().replace(/\s+/g, " ");
  }

  // browser-agent/src/index.ts
  var GENERATION = generationToken();
  function generationToken() {
    const buf = new Uint32Array(2);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf);
    else
      for (let i = 0; i < buf.length; i++)
        buf[i] = Math.random() * 2 ** 32 >>> 0;
    return `${buf[0].toString(36)}${buf[1].toString(36)}`;
  }
  var refs = /* @__PURE__ */ new Map();
  var superseded = /* @__PURE__ */ new Set();
  var supersededToken = "";
  var cutAway = /* @__PURE__ */ new Set();
  var refsTakenAt = "";
  var refsHistoryLength = 0;
  var refsNavTicks = 0;
  var navTicks = 0;
  addEventListener("popstate", () => void navTicks++);
  addEventListener("hashchange", () => void navTicks++);
  function navigationEntryId() {
    const nav = globalThis.navigation;
    return nav?.currentEntry?.id ?? null;
  }
  var refsEntryId = null;
  var snapshotSeq = 0;
  var refsToken = "";
  function snapshot(options = {}) {
    const root = document.body ?? document.documentElement;
    const next = /* @__PURE__ */ new Map();
    let rendered = "";
    const lineToNode = /* @__PURE__ */ new Map();
    if (root) {
      const aria = generateAriaTree(root, { mode: "ai" });
      for (const [ref, info] of aria.info) next.set(ref, info.element);
      const { json } = renderAriaTreeAsJSON(aria, { mode: "ai" });
      rendered = renderAriaSnapshotAsYaml(json, { lineToNode });
    }
    const { text, truncated } = truncate(rendered, options.maxChars);
    const cut = /* @__PURE__ */ new Set();
    if (truncated) {
      const shown = shownRefs(lineToNode, rendered, text);
      for (const ref of Array.from(next.keys()))
        if (!shown.has(ref)) {
          next.delete(ref);
          cut.add(ref);
        }
    }
    superseded = new Set(refs.keys());
    supersededToken = refsToken;
    refs = next;
    cutAway = cut;
    refsTakenAt = location.href;
    refsHistoryLength = history.length;
    refsNavTicks = navTicks;
    refsEntryId = navigationEntryId();
    const own = `${GENERATION}.${++snapshotSeq}`;
    refsToken = options.epoch !== void 0 ? `${own}.${options.epoch}` : own;
    return {
      generation: refsToken,
      url: refsTakenAt,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio
      },
      tree: text,
      refsCount: next.size,
      truncated
    };
  }
  function shownRefs(lineToNode, rendered, kept) {
    const shown = /* @__PURE__ */ new Set();
    const wholeLines = kept.length === rendered.length || rendered.startsWith(`${kept}
`);
    if (!wholeLines) return shown;
    const lines = kept.length === 0 ? 0 : kept.split("\n").length;
    for (const [line, node] of lineToNode)
      if (line < lines && node.ref) shown.add(node.ref);
    return shown;
  }
  function elementForRef(generation, ref) {
    if (!refsAreCurrent(generation)) return null;
    const element = refs.get(ref);
    if (!element?.isConnected) return null;
    return element;
  }
  function refsAreCurrent(generation) {
    if (!refsToken || generation !== refsToken) return false;
    if (location.href !== refsTakenAt) return false;
    if (history.length !== refsHistoryLength) return false;
    if (navTicks !== refsNavTicks) return false;
    if (navigationEntryId() !== refsEntryId) return false;
    return true;
  }
  function stale(ref, generation) {
    const cut = ref !== null && generation !== void 0 && // Disjoint from `refs`: these are the names deleted from it.
    cutAway.has(ref) && superseded.has(ref) && // Either the caller is on the current snapshot and this ref is not in it,
    // or it is quoting the very snapshot the ref came from. Anything older
    // than that, or a page that has moved since, is not this case and gets
    // the plain answer.
    (refsAreCurrent(generation) || generation === supersededToken && location.href === refsTakenAt);
    if (cut)
      return {
        error: "stale",
        detail: `${ref} was named by an earlier snapshot of this page, and the snapshot you took after it did not name it \u2014 a smaller \`maxChars\` names fewer refs, and each snapshot replaces the last one's. The page itself has not changed. Take a snapshot large enough to include what you want and use a ref from that one.`
      };
    return {
      error: "stale",
      detail: ref ? `${ref} does not name an element on the page as it is now; take a new snapshot` : "the page has changed since that snapshot; take a new one"
    };
  }
  function clamp(n, low, high, fallback) {
    const value = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
    return Math.min(high, Math.max(low, value));
  }
  function act(generation, ref, request) {
    const url = location.href;
    const failed = (failure) => ({
      ok: false,
      url,
      ...failure
    });
    let element = null;
    if (ref !== null) {
      element = elementForRef(generation, ref);
      if (!element) return failed(stale(ref, generation));
    } else if (!refsAreCurrent(generation)) {
      return failed(stale(null));
    } else if (request.kind !== "press") {
      return failed({
        error: "unsupported",
        detail: `${request.kind} needs a ref`
      });
    }
    switch (request.kind) {
      case "click":
      case "hover": {
        const target = element;
        if (isDisabledControl(target))
          return failed({
            error: "disabled",
            detail: `${describe(target)} is disabled`
          });
        const point = pointAt(target);
        if ("error" in point) return failed(point);
        const blocked = pointerReach(target, point);
        if (blocked) return failed(blocked);
        if (request.kind === "click") {
          const count = clamp(request.count, 1, 3, 1);
          const delivered = clickAt(
            target,
            point,
            request.button === "right" ? "right" : "left",
            count,
            () => refsAreCurrent(generation) && target.isConnected
          );
          if (delivered < count)
            return failed({
              error: "stale",
              detail: `the page changed after click ${delivered} of ${count}; take a new snapshot`
            });
        } else hoverAt(target, point);
        return { ok: true, url: location.href };
      }
      case "type": {
        const failure = typeInto(element, String(request.text ?? ""));
        if (failure) return failed(failure);
        if (request.submit) {
          const after = pressOn(null, "Enter");
          if ("error" in after) return failed(after);
        }
        return { ok: true, url: location.href };
      }
      case "press": {
        const done = pressOn(element, String(request.key ?? ""));
        if ("error" in done) return failed(done);
        return {
          ok: true,
          url: location.href,
          // Omitted rather than null for a key that is not a scroll key: the
          // field's presence is what says the question was asked at all.
          ...done.scrolled ? { scrolled: done.scrolled } : {}
        };
      }
      case "select": {
        const values = Array.isArray(request.values) ? request.values.map(String) : [String(request.values ?? "")];
        const failure = selectIn(element, values);
        return failure ? failed(failure) : { ok: true, url: location.href };
      }
      default:
        return failed({
          error: "unsupported",
          detail: `"${String(request.kind)}" is not an action`
        });
    }
  }
  function locate(generation, ref) {
    const url = location.href;
    const element = elementForRef(generation, ref);
    if (!element) return { ok: false, url, ...stale(ref, generation) };
    if (isDisabledControl(element))
      return {
        ok: false,
        url,
        error: "disabled",
        detail: `${describe(element)} is disabled`
      };
    const point = pointAt(element);
    if ("error" in point) return { ok: false, url, ...point };
    const blocked = pointerReach(element, point);
    if (blocked) return { ok: false, url, ...blocked };
    return { ok: true, url: location.href, x: point.x, y: point.y };
  }
  function rectOf(generation, ref) {
    const url = location.href;
    const element = elementForRef(generation, ref);
    if (!element) return { ok: false, url, ...stale(ref, generation) };
    const before = element.getBoundingClientRect();
    const point = pointAt(element);
    if ("error" in point) return { ok: false, url, ...point };
    const box = visibleBoxOf(element);
    if (!box)
      return {
        ok: false,
        url,
        error: "not-visible",
        detail: `${describe(element)} has no visible box on screen to crop to`
      };
    const after = element.getBoundingClientRect();
    return {
      ok: true,
      url: location.href,
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height,
      scrolled: Math.abs(after.top - before.top) > 0.5 || Math.abs(after.left - before.left) > 0.5,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio
      }
    };
  }
  function visibleBoxOf(el) {
    const box = el.getBoundingClientRect();
    const left = Math.max(box.left, 0);
    const top = Math.max(box.top, 0);
    const right = Math.min(box.right, window.innerWidth);
    const bottom = Math.min(box.bottom, window.innerHeight);
    if (right - left < 1 || bottom - top < 1) return null;
    return new DOMRect(left, top, right - left, bottom - top);
  }
  function truncate(text, maxChars) {
    if (!maxChars || maxChars <= 0 || text.length <= maxChars)
      return { text, truncated: false };
    const cut = text.lastIndexOf("\n", maxChars);
    return {
      text: cut > 0 ? text.slice(0, cut) : text.slice(0, maxChars),
      truncated: true
    };
  }
  globalThis.__codegAgent = { snapshot, elementForRef, act, locate, rectOf };
})();
