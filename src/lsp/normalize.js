// LSP 结果归一化：Location / LocationLink / MarkedString / DocumentSymbol / WorkspaceSymbol /
// Diagnostics 统一成桥自己的 JSON 形状；位置一律 1-based，路径用正斜杠。

import { displayPath, fromLspPosition, fromLspRange, fromUri } from '../paths.js';

export const SYMBOL_KIND = {
  1: 'file',
  2: 'module',
  3: 'namespace',
  4: 'package',
  5: 'class',
  6: 'method',
  7: 'property',
  8: 'field',
  9: 'constructor',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  14: 'constant',
  15: 'string',
  16: 'number',
  17: 'boolean',
  18: 'array',
  19: 'object',
  20: 'key',
  21: 'null',
  22: 'enumMember',
  23: 'struct',
  24: 'event',
  25: 'operator',
  26: 'typeParameter',
};

export function kindName(id) {
  return SYMBOL_KIND[id] || 'unknown';
}

function locationFromUriAndRange(uri, range) {
  const file = fromUri(uri);
  return {
    file: file ? displayPath(file) : String(uri || ''),
    uri,
    ...(range ? fromLspRange(range) : { start: null, end: null }),
  };
}

export function normalizeDefinition(result) {
  if (!result) return [];
  const items = Array.isArray(result) ? result : [result];
  const out = [];
  for (const item of items) {
    if (!item) continue;
    if (item.targetUri) {
      const selection = item.targetSelectionRange || item.targetRange;
      const entry = locationFromUriAndRange(item.targetUri, selection);
      if (item.targetRange && selection !== item.targetRange) {
        entry.targetRange = fromLspRange(item.targetRange);
      }
      out.push(entry);
    } else if (item.uri) {
      out.push(locationFromUriAndRange(item.uri, item.range));
    }
  }
  return out;
}

export function normalizeReferences(result) {
  if (!result) return [];
  return result
    .filter((item) => item && item.uri)
    .map((item) => locationFromUriAndRange(item.uri, item.range))
    .sort((a, b) => {
      const fa = (a.file || '').toLowerCase();
      const fb = (b.file || '').toLowerCase();
      if (fa !== fb) return fa < fb ? -1 : 1;
      const la = a.start ? a.start.line : 0;
      const lb = b.start ? b.start.line : 0;
      if (la !== lb) return la - lb;
      const ca = a.start ? a.start.column : 0;
      const cb = b.start ? b.start.column : 0;
      return ca - cb;
    });
}

function hoverPart(part) {
  if (part === null || part === undefined) return null;
  if (typeof part === 'string') return { kind: 'markdown', text: part };
  if (typeof part === 'object') {
    if (part.kind === 'markdown' || part.kind === 'plaintext') {
      return { kind: part.kind, text: String(part.value || '') };
    }
    if (typeof part.language === 'string') {
      return { kind: 'markdown', text: `~~~${part.language}\n${part.value || ''}\n~~~` };
    }
    if (typeof part.value === 'string') return { kind: 'markdown', text: part.value };
  }
  return { kind: 'plaintext', text: String(part) };
}

export function normalizeHover(result) {
  if (!result || result.contents === undefined || result.contents === null) {
    return { contents: '', kind: 'plaintext', empty: true, range: null };
  }
  const rawParts = Array.isArray(result.contents) ? result.contents : [result.contents];
  const parts = rawParts.map(hoverPart).filter(Boolean);
  const kind = parts.length > 0 && parts.every((p) => p.kind === 'markdown') ? 'markdown' : 'plaintext';
  const contents = parts.map((p) => p.text).join('\n\n').trim();
  return {
    contents,
    kind: contents ? kind : 'plaintext',
    empty: contents === '',
    range: result.range ? fromLspRange(result.range) : null,
  };
}

export function normalizeDiagnostic(d, { includeRelated = false } = {}) {
  const severityId = typeof d.severity === 'number' ? d.severity : null;
  const severity = severityId === 1 ? 'error'
    : severityId === 2 ? 'warning'
      : severityId === 3 ? 'information'
        : severityId === 4 ? 'hint'
          : 'unknown';
  const out = {
    severity,
    message: String(d.message || ''),
    code: d.code === undefined ? null : d.code,
    source: d.source === undefined ? null : d.source,
    range: fromLspRange(d.range),
  };
  if (includeRelated) {
    out.relatedInformation = Array.isArray(d.relatedInformation)
      ? d.relatedInformation.map((rel) => ({
        message: String(rel.message || ''),
        ...(rel.location
          ? {
            file: (() => {
              const file = fromUri(rel.location.uri);
              return file ? displayPath(file) : String(rel.location.uri || '');
            })(),
            uri: rel.location.uri,
            range: fromLspRange(rel.location.range),
          }
          : {}),
      }))
      : [];
  }
  return out;
}

export function filterDiagnostics(diagnostics, severityFilter) {
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  const normalized = list.map((d) => normalizeDiagnostic(d, { includeRelated: false }));
  if (!severityFilter) return normalized;
  return normalized.filter((d) => d.severity === severityFilter);
}

function buildSymbolTree(symbol) {
  return {
    name: String(symbol.name || ''),
    kind: kindName(symbol.kind),
    kindId: symbol.kind ?? null,
    detail: symbol.detail === undefined ? null : symbol.detail,
    range: fromLspRange(symbol.range),
    selectionRange: fromLspRange(symbol.selectionRange || symbol.range),
    children: Array.isArray(symbol.children) ? symbol.children.map(buildSymbolTree) : [],
  };
}

function countNodes(nodes) {
  let total = 0;
  for (const node of nodes) {
    total += 1 + countNodes(node.children || []);
  }
  return total;
}

// 按 DFS 顺序保留前 limit 个节点；祖先被保留时其子节点才继续消耗预算。
function pruneNodes(nodes, budget) {
  const out = [];
  for (const node of nodes) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    out.push({ ...node, children: pruneNodes(node.children || [], budget) });
  }
  return out;
}

export function normalizeDocumentSymbols(result, limit) {
  const list = Array.isArray(result) ? result : [];
  if (list.length === 0) {
    return { hierarchical: true, symbols: [], total: 0, truncated: false };
  }
  const first = list[0];
  const flat = Boolean(first && first.location);

  if (flat) {
    const symbols = list.map((item) => {
      const loc = item.location || {};
      const file = loc.uri ? fromUri(loc.uri) : null;
      return {
        name: String(item.name || ''),
        kind: kindName(item.kind),
        kindId: item.kind ?? null,
        containerName: item.containerName === undefined ? null : item.containerName,
        file: file ? displayPath(file) : String(loc.uri || ''),
        uri: loc.uri || null,
        range: loc.range ? fromLspRange(loc.range) : null,
      };
    });
    return {
      hierarchical: false,
      symbols: symbols.slice(0, limit),
      total: symbols.length,
      truncated: symbols.length > limit,
    };
  }

  const trees = list.map(buildSymbolTree);
  const total = countNodes(trees);
  const truncated = total > limit;
  const symbols = truncated ? pruneNodes(trees, { remaining: limit }) : trees;
  return { hierarchical: true, symbols, total, truncated };
}

export function normalizeWorkspaceSymbols(result, limit) {
  const list = Array.isArray(result) ? result : [];
  const out = [];
  let total = 0;
  for (const item of list) {
    total += 1;
    if (total > limit) continue;
    const loc = item.location || null;
    const uri = loc && loc.uri ? loc.uri : null;
    const file = uri ? fromUri(uri) : null;
    out.push({
      name: String(item.name || ''),
      kind: kindName(item.kind),
      kindId: item.kind ?? null,
      containerName: item.containerName === undefined ? null : item.containerName,
      file: file ? displayPath(file) : null,
      uri,
      start: loc && loc.range ? fromLspPosition(loc.range.start) : null,
      end: loc && loc.range ? fromLspPosition(loc.range.end) : null,
    });
  }
  return { symbols: out, total, truncated: total > out.length };
}
