'use strict';

const TOOL_CALL_MARKUP_BLOCK_PATTERN = /<(?:[a-z0-9_:-]+:)?(tool_call|function_call|invoke)\b([^>]*)>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?\1>/gi;
const TOOL_CALL_MARKUP_WRAPPER_PATTERNS = [
  /<(?:[a-z0-9_:-]+:)?tool_calls\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?tool_calls>/gi,
  /<(?:[a-z0-9_:-]+:)?function_calls\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?function_calls>/gi,
];
const TOOL_CALL_MARKUP_SELFCLOSE_PATTERN = /<(?:[a-z0-9_:-]+:)?invoke\b([^>]*)\/>/gi;
const TOOL_CALL_MARKUP_KV_PATTERN = /<(?:[a-z0-9_:-]+:)?([a-z0-9_.-]+)\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?\1>/gi;
const TOOL_CALL_MARKUP_ATTR_PATTERN = /(name|function|tool)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const TOOL_CALL_MARKUP_NAME_PATTERNS = [
  /<(?:[a-z0-9_:-]+:)?tool_name\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?tool_name>/i,
  /<(?:[a-z0-9_:-]+:)?function_name\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?function_name>/i,
  /<(?:[a-z0-9_:-]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?name>/i,
  /<(?:[a-z0-9_:-]+:)?function\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?function>/i,
];
const TOOL_CALL_MARKUP_ARGS_PATTERNS = [
  /<(?:[a-z0-9_:-]+:)?input\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?input>/i,
  /<(?:[a-z0-9_:-]+:)?arguments\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?arguments>/i,
  /<(?:[a-z0-9_:-]+:)?argument\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?argument>/i,
  /<(?:[a-z0-9_:-]+:)?parameters\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?parameters>/i,
  /<(?:[a-z0-9_:-]+:)?parameter\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?parameter>/i,
  /<(?:[a-z0-9_:-]+:)?args\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?args>/i,
  /<(?:[a-z0-9_:-]+:)?params\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9_:-]+:)?params>/i,
];
const CDATA_PATTERN = /^<!\[CDATA\[([\s\S]*?)]]>$/i;
const HTML_ENTITIES_PATTERN = /&[a-z0-9#]+;/gi;

const {
  toStringSafe,
} = require('./state');

function stripFencedCodeBlocks(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t) {
    return '';
  }
  return t.replace(/```[\s\S]*?```/g, ' ');
}

function parseMarkupToolCalls(text) {
  const raw = toStringSafe(text).trim();
  if (!raw) {
    return [];
  }
  const out = [];
  for (const m of raw.matchAll(TOOL_CALL_MARKUP_BLOCK_PATTERN)) {
    const parsed = parseMarkupSingleToolCall(toStringSafe(m[2]).trim(), toStringSafe(m[3]).trim());
    if (parsed) {
      out.push(parsed);
    }
  }
  for (const m of raw.matchAll(TOOL_CALL_MARKUP_SELFCLOSE_PATTERN)) {
    const parsed = parseMarkupSingleToolCall(toStringSafe(m[1]).trim(), '');
    if (parsed) {
      out.push(parsed);
    }
  }
  if (out.length === 0) {
    return parseWrapperNamedTagToolCalls(raw);
  }
  return out;
}

function parseMarkupSingleToolCall(attrs, inner) {
  // Try inline JSON parse for the inner content.
  if (inner) {
    try {
      const decoded = JSON.parse(inner);
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded) && decoded.name) {
        return {
          name: toStringSafe(decoded.name),
          input: decoded.input && typeof decoded.input === 'object' && !Array.isArray(decoded.input) ? decoded.input : {},
        };
      }
    } catch (_err) {
      // Not JSON, continue with markup parsing.
    }
  }
  let name = '';
  const attrMatch = attrs.match(TOOL_CALL_MARKUP_ATTR_PATTERN);
  if (attrMatch) {
    name = sanitizeToolName(attrMatch[2] || attrMatch[3] || attrMatch[4] || '');
  }
  if (!name) {
    name = sanitizeToolName(extractRawTagValue(findMarkupTagValue(inner, TOOL_CALL_MARKUP_NAME_PATTERNS)));
  }
  if (!name) {
    return null;
  }

  let input = {};
  const argsRaw = findMarkupTagValue(inner, TOOL_CALL_MARKUP_ARGS_PATTERNS);
  if (argsRaw) {
    input = parseMarkupInput(argsRaw);
  } else {
    const kv = parseMarkupKVObject(inner);
    if (Object.keys(kv).length > 0) {
      input = kv;
    }
  }
  return { name, input };
}

function parseMarkupInput(raw) {
  const s = toStringSafe(raw).trim();
  if (!s) {
    return {};
  }
  // Prioritize XML-style KV tags (e.g., <arg>val</arg>)
  const kv = parseMarkupKVObject(s);
  if (Object.keys(kv).length > 0) {
    return kv;
  }

  // Fallback to JSON parsing
  const parsed = parseToolCallInput(s);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (Object.keys(parsed).length > 0) {
      return parsed;
    }
  }

  return { _raw: extractRawTagValue(s) };
}

function parseMarkupKVObject(text) {
  const raw = toStringSafe(text).trim();
  if (!raw) {
    return {};
  }
  const out = {};
  for (const m of raw.matchAll(TOOL_CALL_MARKUP_KV_PATTERN)) {
    const key = toStringSafe(m[1]).trim();
    if (!key) {
      continue;
    }
    const value = parseMarkupValue(m[2]);
    if (value === undefined || value === null) {
      continue;
    }
    appendMarkupValue(out, key, value);
  }
  return out;
}

function parseMarkupValue(raw) {
  const s = toStringSafe(extractRawTagValue(raw)).trim();
  if (!s) {
    return '';
  }

  if (s.includes('<') && s.includes('>')) {
    const nested = parseMarkupInput(s);
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      if (isOnlyRawValue(nested)) {
        return toStringSafe(nested._raw);
      }
      return nested;
    }
  }

  try {
    return JSON.parse(s);
  } catch (_err) {
    return s;
  }
}

function extractRawTagValue(inner) {
  const s = toStringSafe(inner).trim();
  if (!s) {
    return '';
  }

  // 1. Check for CDATA
  const cdataMatch = s.match(CDATA_PATTERN);
  if (cdataMatch && cdataMatch[1] !== undefined) {
    return cdataMatch[1];
  }

  // 2. Fallback to unescaping standard HTML entities
  // Note: we avoid broad tag stripping here to preserve user content (like < symbols in code)
  return unescapeHtml(inner);
}

function unescapeHtml(safe) {
  if (!safe) return '';
  return safe.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTagText(text) {
  return toStringSafe(text).replace(/<[^>]+>/g, ' ').trim();
}

function findMarkupTagValue(text, patterns) {
  const source = toStringSafe(text);
  for (const p of patterns) {
    const m = source.match(p);
    if (m && m[1] !== undefined) {
      return toStringSafe(m[1]);
    }
  }
  return '';
}

function parseToolCallInput(v) {
  if (v == null) {
    return {};
  }
  if (typeof v === 'string') {
    const raw = toStringSafe(v);
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      return { _raw: raw };
    } catch (_err) {
      return { _raw: raw };
    }
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    return v;
  }
  try {
    const parsed = JSON.parse(JSON.stringify(v));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_err) {
    return {};
  }
  return {};
}

function appendMarkupValue(out, key, value) {
  if (Object.prototype.hasOwnProperty.call(out, key)) {
    const current = out[key];
    if (Array.isArray(current)) {
      current.push(value);
      return;
    }
    out[key] = [current, value];
    return;
  }
  out[key] = value;
}

function sanitizeToolName(raw) {
  let name = toStringSafe(unescapeHtml(raw)).trim();
  name = name.replace(/^[`'"\s]+|[`'"\s]+$/g, '');
  while (name && !/[a-z0-9_.:-]$/i.test(name)) {
    name = name.slice(0, -1).trim();
  }
  return name;
}

function parseWrapperNamedTagToolCalls(text) {
  const raw = toStringSafe(text).trim();
  if (!raw) {
    return [];
  }
  for (const pattern of TOOL_CALL_MARKUP_WRAPPER_PATTERNS) {
    for (const m of raw.matchAll(pattern)) {
      const parsed = parseWrapperNamedTagSingle(toStringSafe(m[1]).trim());
      if (parsed) {
        return [parsed];
      }
    }
  }
  return [];
}

function parseWrapperNamedTagSingle(inner) {
  const body = toStringSafe(inner).trim();
  if (!body.startsWith('<')) {
    return null;
  }
  const open = body.match(/^<([a-z0-9_:-]+)\b[^>]*>/i);
  if (!open || !open[1]) {
    return null;
  }
  const name = sanitizeToolName(open[1]);
  if (!name) {
    return null;
  }
  const lower = name.toLowerCase();
  if (['tool_call', 'function_call', 'invoke', 'tool_calls', 'function_calls'].includes(lower)) {
    return null;
  }
  const bodyPattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  const match = body.match(bodyPattern);
  if (!match || match[1] === undefined) {
    return null;
  }
  const content = toStringSafe(match[1]).trim();
  let input = {};
  const argsRaw = findMarkupTagValue(content, TOOL_CALL_MARKUP_ARGS_PATTERNS);
  if (argsRaw) {
    input = parseMarkupInput(argsRaw);
  } else {
    const kv = parseMarkupKVObject(content);
    if (Object.keys(kv).length > 0) {
      input = kv;
    } else {
      const parsed = parseToolCallInput(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !isOnlyRawValue(parsed)) {
        input = parsed;
      }
    }
  }
  return { name, input };
}

function isOnlyRawValue(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }
  const keys = Object.keys(obj);
  return keys.length === 1 && keys[0] === '_raw';
}

module.exports = {
  stripFencedCodeBlocks,
  parseMarkupToolCalls,
};
