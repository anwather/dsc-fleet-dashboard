import * as monaco from 'monaco-editor';
import { DSC_RESOURCE_CATALOG, type DscPropertyDoc, listResourceTypes } from './dscResourceCatalog';

/**
 * Register completion + hover providers on the YAML language so users get
 * IntelliSense for resource `type:` values (the curated list of DSC v3
 * resources we know about) and the properties accepted by each resource
 * once a `type:` is set.
 *
 * monaco-yaml handles validation of the outer document shape via the bundled
 * DSC v3 schema. This module layers a thin context-aware completion provider
 * on top, because the document schema does not describe the per-resource
 * property bag.
 */

let registered = false;

export function registerDscIntellisense(): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [':', ' ', '\n', '/'],
    provideCompletionItems(model, position) {
      const lineText = model.getLineContent(position.lineNumber);
      const textUntil = lineText.slice(0, position.column - 1);
      const wordInfo = model.getWordUntilPosition(position);
      const range = new monaco.Range(
        position.lineNumber,
        wordInfo.startColumn,
        position.lineNumber,
        wordInfo.endColumn,
      );

      // Case 1: completing a value after `type:` — suggest known resource types.
      const typeMatch = /^\s*type\s*:\s*(\S*)$/.exec(textUntil);
      if (typeMatch) {
        return {
          suggestions: listResourceTypes().map((t) => ({
            label: t,
            kind: monaco.languages.CompletionItemKind.Class,
            insertText: t,
            range,
            detail: DSC_RESOURCE_CATALOG[t]?.description ?? 'DSC v3 resource',
            documentation: { value: `**${t}**\n\n${DSC_RESOURCE_CATALOG[t]?.description ?? ''}` },
          })),
        };
      }

      // Case 2: inside a `properties:` block — suggest property keys for the
      // closest enclosing resource's `type:` value.
      const propertyContext = findPropertiesContext(model, position);
      if (propertyContext) {
        const resource = DSC_RESOURCE_CATALOG[propertyContext.type];
        if (!resource) return { suggestions: [] };

        // Skip properties that are already set on this resource block.
        const existing = collectExistingPropertyNames(model, propertyContext);

        const suggestions = resource.properties
          .filter((p) => !existing.has(p.name))
          .map((p) => buildPropertySuggestion(p, range));

        return { suggestions };
      }

      return { suggestions: [] };
    },
  });

  monaco.languages.registerHoverProvider('yaml', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const lineText = model.getLineContent(position.lineNumber);

      // Hover over a resource type value.
      const typeMatch = /^(\s*type\s*:\s*)(\S+)/.exec(lineText);
      if (typeMatch) {
        const valueStart = typeMatch[1].length + 1;
        if (position.column >= valueStart && position.column <= valueStart + typeMatch[2].length) {
          const resource = DSC_RESOURCE_CATALOG[typeMatch[2]];
          if (resource) {
            return {
              contents: [
                { value: `**${typeMatch[2]}**` },
                { value: resource.description ?? '' },
              ],
            };
          }
        }
      }

      // Hover over a property key inside a properties block.
      const ctx = findPropertiesContext(model, position);
      if (ctx) {
        const resource = DSC_RESOURCE_CATALOG[ctx.type];
        if (resource) {
          const propMatch = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(lineText);
          if (propMatch) {
            const prop = resource.properties.find((p) => p.name === propMatch[2]);
            if (prop) {
              const lines: string[] = [`**${prop.name}** \`${prop.kind}\`${prop.required ? ' *(required)*' : ''}`];
              if (prop.description) lines.push(prop.description);
              if (prop.enumValues?.length) lines.push(`Allowed: ${prop.enumValues.map((v) => `\`${v}\``).join(', ')}`);
              if (prop.defaultValue) lines.push(`Default: \`${prop.defaultValue}\``);
              return { contents: lines.map((value) => ({ value })) };
            }
          }
        }
      }

      return null;
    },
  });
}

interface PropertiesContext {
  /** The resource type string from the closest enclosing `type:` field. */
  type: string;
  /** Indentation (number of spaces) of children of `properties:`. */
  childIndent: number;
  /** Line number of the `properties:` key. */
  propertiesLine: number;
}

/**
 * Walk upwards from the cursor looking for the closest `properties:` key
 * that has the cursor as a direct child (by indentation), and the matching
 * `type:` sibling above it. Returns null if the cursor is not inside a
 * resource's `properties:` block.
 */
function findPropertiesContext(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): PropertiesContext | null {
  const cursorIndent = leadingSpaces(model.getLineContent(position.lineNumber));

  let propertiesLine = -1;
  let propertiesIndent = -1;
  for (let l = position.lineNumber - 1; l >= 1; l--) {
    const line = model.getLineContent(l);
    if (!line.trim()) continue;
    const indent = leadingSpaces(line);
    const match = /^(\s*)properties\s*:\s*$/.exec(line);
    if (match && indent < cursorIndent) {
      propertiesLine = l;
      propertiesIndent = indent;
      break;
    }
    // If we see a sibling/parent key at lower indent than cursor, we're not
    // inside a properties block.
    if (indent < cursorIndent && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line)) {
      // Keep walking — we're looking for properties: specifically.
      continue;
    }
  }
  if (propertiesLine < 0) return null;

  // Find the matching `type:` at the same indent as `properties:` within the
  // same resource block (walk up until we hit a lower indent).
  let resourceType: string | null = null;
  for (let l = propertiesLine - 1; l >= 1; l--) {
    const line = model.getLineContent(l);
    if (!line.trim()) continue;
    const indent = leadingSpaces(line);
    if (indent < propertiesIndent) break;
    if (indent === propertiesIndent) {
      const typeMatch = /^\s*type\s*:\s*(\S+)\s*$/.exec(line);
      if (typeMatch) {
        resourceType = typeMatch[1];
        break;
      }
    }
  }
  if (!resourceType) return null;

  return { type: resourceType, childIndent: propertiesIndent + 2, propertiesLine };
}

function collectExistingPropertyNames(
  model: monaco.editor.ITextModel,
  ctx: PropertiesContext,
): Set<string> {
  const names = new Set<string>();
  for (let l = ctx.propertiesLine + 1; l <= model.getLineCount(); l++) {
    const line = model.getLineContent(l);
    if (!line.trim()) continue;
    const indent = leadingSpaces(line);
    if (indent <= ctx.propertiesLine - 1) break;
    if (indent < ctx.childIndent) break;
    if (indent !== ctx.childIndent) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  return n;
}

function buildPropertySuggestion(p: DscPropertyDoc, range: monaco.IRange): monaco.languages.CompletionItem {
  let insertText: string;
  let insertTextRules: monaco.languages.CompletionItem['insertTextRules'] | undefined;

  if (p.kind === 'enum' && p.enumValues?.length) {
    const choices = p.enumValues.map((v, i) => `${i + 1}|${v}`).join(',');
    insertText = `${p.name}: \${1|${p.enumValues.join(',')}|}`;
    void choices;
    insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  } else if (p.kind === 'boolean') {
    insertText = `${p.name}: \${1|true,false|}`;
    insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  } else if (p.kind === 'object') {
    insertText = `${p.name}:\n  $0`;
    insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  } else if (p.kind === 'array') {
    insertText = `${p.name}:\n  - $0`;
    insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  } else if (p.defaultValue !== undefined) {
    insertText = `${p.name}: \${1:${p.defaultValue}}`;
    insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  } else {
    insertText = `${p.name}: $0`;
    insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }

  const detailParts: string[] = [p.kind];
  if (p.required) detailParts.push('required');
  if (p.defaultValue) detailParts.push(`default: ${p.defaultValue}`);

  return {
    label: p.name,
    kind: monaco.languages.CompletionItemKind.Property,
    insertText,
    insertTextRules,
    range,
    detail: detailParts.join(' · '),
    documentation: p.description ? { value: p.description } : undefined,
    sortText: p.required ? `0_${p.name}` : `1_${p.name}`,
  };
}
