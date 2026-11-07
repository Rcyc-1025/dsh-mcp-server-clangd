// 工具注册表：7 个只读工具，顺序即 tools/list 顺序。

import * as health from './health.js';
import * as definition from './definition.js';
import * as hover from './hover.js';
import * as references from './references.js';
import * as diagnostics from './diagnostics.js';
import * as documentSymbols from './documentSymbols.js';
import * as workspaceSymbols from './workspaceSymbols.js';

export const TOOLS = [
  health,
  definition,
  hover,
  references,
  diagnostics,
  documentSymbols,
  workspaceSymbols,
];

export const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function listTools() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));
}

export function getTool(name) {
  return TOOL_MAP.get(name) || null;
}
