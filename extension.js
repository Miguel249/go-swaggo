const vscode = require('vscode');

const tokenTypes = [
  'keyword',
  'string',
  'number',
  'type',
  'variable',
  'parameter',
  'namespace',
  'function',
  'operator'
];

const legend = new vscode.SemanticTokensLegend(tokenTypes, []);
const tokenTypeIndex = new Map(tokenTypes.map((tokenType, index) => [tokenType, index]));

const annotationNames = new Set([
  'Summary',
  'Description',
  'Tags',
  'Accept',
  'Produce',
  'Param',
  'Success',
  'Failure',
  'Router'
]);

const parameterLocations = new Set(['path', 'query', 'header', 'body', 'formData']);
const builtinTypes = new Set([
  'string',
  'bool',
  'byte',
  'rune',
  'error',
  'any',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uintptr',
  'float32',
  'float64',
  'interface'
]);
const responseKinds = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);
const httpMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head']);
const specialNamespaces = new Set(['json']);
const specialKeywords = new Set(['map']);
const documentSymbolCache = new Map();
const workspaceSymbolCache = new Map();
let workspaceSymbolGeneration = 0;

function activate(context) {
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeSemanticTokens: emitter.event,
    async provideDocumentSemanticTokens(document) {
      return buildSemanticTokens(document);
    }
  };

  context.subscriptions.push(
    emitter,
    vscode.languages.registerDocumentSemanticTokensProvider({ language: 'go' }, provider, legend),
    vscode.workspace.onDidChangeTextDocument((event) => {
      documentSymbolCache.delete(event.document.uri.toString());
      if (event.document.languageId === 'go') {
        emitter.fire(event.document.uri);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (document.languageId === 'go') {
        emitter.fire(document.uri);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.languageId === 'go') {
        emitter.fire(editor.document.uri);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      documentSymbolCache.delete(document.uri.toString());
      bumpWorkspaceSymbolGeneration();
      if (document.languageId === 'go') {
        emitter.fire(document.uri);
      }
    }),
    vscode.workspace.onDidDeleteFiles(() => {
      bumpWorkspaceSymbolGeneration();
    }),
    vscode.workspace.onDidCreateFiles(() => {
      bumpWorkspaceSymbolGeneration();
    }),
    vscode.workspace.onDidRenameFiles(() => {
      bumpWorkspaceSymbolGeneration();
    })
  );
}

function deactivate() {}

async function buildSemanticTokens(document) {
  const builder = new vscode.SemanticTokensBuilder(legend);
  const swagRanges = collectSwagRanges(document);
  const candidateIdentifiers = collectCandidateIdentifiers(document, swagRanges);
  const symbols = await collectSymbols(document, candidateIdentifiers);

  for (const range of swagRanges) {
    const line = document.lineAt(range.line);
    const lineTokens = [];
    tokenizeSwagLine(line.text, range.line, range.startCharacter, symbols, lineTokens);

    lineTokens.sort((left, right) => left.start - right.start || right.length - left.length);

    let lastEnd = -1;
    for (const token of lineTokens) {
      if (token.start < lastEnd) {
        continue;
      }

      builder.push(token.line, token.start, token.length, tokenTypeIndex.get(token.type), 0);
      lastEnd = token.start + token.length;
    }
  }

  return builder.build();
}

function collectSwagRanges(document) {
  const ranges = [];
  let inGodocBlock = false;

  for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
    const text = document.lineAt(lineIndex).text;

    if (/^\s*\/\/.*\bgodoc\b/i.test(text)) {
      inGodocBlock = true;
      continue;
    }

    if (!inGodocBlock) {
      continue;
    }

    if (!/^\s*\/\//.test(text)) {
      inGodocBlock = false;
      continue;
    }

    const prefixMatch = text.match(/^(\s*\/\/\s*)/);
    if (!prefixMatch) {
      continue;
    }

    const startCharacter = prefixMatch[0].length;
    if (text.slice(startCharacter).startsWith('@')) {
      ranges.push({ line: lineIndex, startCharacter });
    }
  }

  return ranges;
}

function collectCandidateIdentifiers(document, swagRanges) {
  const identifiers = new Set();

  for (const range of swagRanges) {
    const content = document.lineAt(range.line).text.slice(range.startCharacter);
    for (const match of content.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      identifiers.add(match[0]);
    }
  }

  return identifiers;
}

async function collectSymbols(document, candidateIdentifiers) {
  const types = new Set();
  const variables = new Set();
  const functions = new Set();
  const namespaces = new Set();
  const unresolved = new Set(candidateIdentifiers);
  const text = document.getText();
  const lines = text.split(/\r?\n/);

  let inVarBlock = false;
  let inConstBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, '');

    if (inVarBlock || inConstBlock) {
      if (/^\s*\)/.test(line)) {
        inVarBlock = false;
        inConstBlock = false;
        continue;
      }

      const blockMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (blockMatch) {
        variables.add(blockMatch[1]);
      }
    }

    const typeMatch = line.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
    if (typeMatch) {
      types.add(typeMatch[1]);
      unresolved.delete(typeMatch[1]);
    }

    const funcMatch = line.match(/^\s*func\s*(?:\(([^)]*)\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/);
    if (funcMatch) {
      if (funcMatch[1]) {
        collectNamedIdentifiers(funcMatch[1]).forEach((name) => variables.add(name));
      }

      functions.add(funcMatch[2]);
      unresolved.delete(funcMatch[2]);
      collectParameterNames(funcMatch[3]).forEach((name) => variables.add(name));
    }

    if (/^\s*(?:var|const)\s*\(/.test(line)) {
      inVarBlock = /^\s*var\s*\(/.test(line);
      inConstBlock = /^\s*const\s*\(/.test(line);
      continue;
    }

    const declaredMatch = line.match(/^\s*(?:var|const)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\b/);
    if (declaredMatch) {
      splitIdentifiers(declaredMatch[1]).forEach((name) => variables.add(name));
    }

    for (const shortMatch of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:=/g)) {
      splitIdentifiers(shortMatch[1]).forEach((name) => variables.add(name));
    }
  }

  const documentSymbols = await getDocumentSymbols(document);
  if (documentSymbols) {
    flattenSymbols(documentSymbols).forEach((symbol) => {
      addSymbolByKind(symbol.name, symbol.kind, { types, variables, functions, namespaces });
      unresolved.delete(symbol.name);
    });
  }

  const workspaceQueries = Array.from(unresolved).filter(shouldLookupWorkspaceSymbol);
  await Promise.all(workspaceQueries.map(async (query) => {
    const workspaceSymbols = await getWorkspaceSymbols(query);
    if (!workspaceSymbols) {
      return;
    }

    for (const symbol of workspaceSymbols) {
      if (symbol.name !== query) {
        continue;
      }

      addSymbolByKind(symbol.name, symbol.kind, { types, variables, functions, namespaces });
    }
  }));

  return { types, variables, functions, namespaces };
}

async function getDocumentSymbols(document) {
  const key = document.uri.toString();
  const cached = documentSymbolCache.get(key);

  if (cached && cached.version === document.version) {
    return cached.value;
  }

  try {
    const value = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    documentSymbolCache.set(key, { version: document.version, value });
    return value;
  } catch {
    return undefined;
  }
}

async function getWorkspaceSymbols(query) {
  const cacheKey = `${workspaceSymbolGeneration}:${query}`;
  if (workspaceSymbolCache.has(cacheKey)) {
    return workspaceSymbolCache.get(cacheKey);
  }

  try {
    const value = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query);
    workspaceSymbolCache.set(cacheKey, value);
    return value;
  } catch {
    return undefined;
  }
}

function bumpWorkspaceSymbolGeneration() {
  workspaceSymbolGeneration += 1;
  workspaceSymbolCache.clear();
}

function flattenSymbols(symbols) {
  const flattened = [];

  for (const symbol of symbols) {
    flattened.push(symbol);
    if (symbol.children && symbol.children.length > 0) {
      flattened.push(...flattenSymbols(symbol.children));
    }
  }

  return flattened;
}

function addSymbolByKind(name, kind, symbols) {
  switch (kind) {
    case vscode.SymbolKind.Struct:
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Interface:
    case vscode.SymbolKind.TypeParameter:
    case vscode.SymbolKind.Enum:
      symbols.types.add(name);
      break;
    case vscode.SymbolKind.Function:
    case vscode.SymbolKind.Method:
      symbols.functions.add(name);
      break;
    case vscode.SymbolKind.Package:
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Namespace:
      symbols.namespaces.add(name);
      break;
    case vscode.SymbolKind.Variable:
    case vscode.SymbolKind.Constant:
    case vscode.SymbolKind.Field:
    case vscode.SymbolKind.Property:
      symbols.variables.add(name);
      break;
    default:
      break;
  }
}

function shouldLookupWorkspaceSymbol(word) {
  return !annotationNames.has(word)
    && !parameterLocations.has(word)
    && !httpMethods.has(word)
    && !responseKinds.has(word)
    && !builtinTypes.has(word)
    && !specialKeywords.has(word)
    && !specialNamespaces.has(word)
    && !/^\d+$/.test(word)
    && word.length > 1;
}

function collectNamedIdentifiers(segment) {
  const names = [];
  const match = segment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+/);
  if (match) {
    names.push(match[1]);
  }
  return names;
}

function collectParameterNames(segment) {
  const names = [];

  for (const part of segment.split(',')) {
    const match = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s+/);
    if (match) {
      splitIdentifiers(match[1]).forEach((name) => names.push(name));
    }
  }

  return names;
}

function splitIdentifiers(value) {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function tokenizeSwagLine(lineText, lineNumber, contentStart, symbols, lineTokens) {
  const content = lineText.slice(contentStart);
  const annotationMatch = content.match(/^@([A-Za-z]+)/);

  if (!annotationMatch || !annotationNames.has(annotationMatch[1])) {
    return;
  }

  addToken(lineTokens, lineNumber, contentStart, annotationMatch[0].length, 'keyword');

  const annotation = annotationMatch[1];
  if (annotation === 'Param') {
    tokenizeParamLine(content, lineNumber, contentStart, symbols, lineTokens);
  } else if (annotation === 'Success' || annotation === 'Failure') {
    tokenizeResponseLine(content, lineNumber, contentStart, symbols, lineTokens);
  } else if (annotation === 'Router') {
    tokenizeRouterLine(content, lineNumber, contentStart, lineTokens);
  }

  addPatternTokens(lineTokens, lineNumber, contentStart, content, /"[^"\r\n]*"/g, 'string');
  addPatternTokens(lineTokens, lineNumber, contentStart, content, /\b\d+\b/g, 'number');
  addPatternTokens(lineTokens, lineNumber, contentStart, content, /\b(?:true|false)\b/g, 'keyword');
  addPatternTokens(lineTokens, lineNumber, contentStart, content, /\bmap\b/g, 'keyword');
  addPatternTokens(lineTokens, lineNumber, contentStart, content, /\binterface\b/g, 'type');
  addPatternTokens(lineTokens, lineNumber, contentStart, content, /\bjson\b/g, 'namespace');
  addPatternTokens(lineTokens, lineNumber, contentStart, content, /[\[\]{}]/g, 'operator');
  addQualifiedTypeTokens(lineTokens, lineNumber, contentStart, content);
  addIdentifierTokens(lineTokens, lineNumber, contentStart, content, symbols);
}

function tokenizeParamLine(content, lineNumber, contentStart, symbols, lineTokens) {
  const match = content.match(/^@Param\s+([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (!match) {
    return;
  }

  const variableOffset = content.indexOf(match[1]);
  addToken(lineTokens, lineNumber, contentStart + variableOffset, match[1].length, classifyIdentifier(match[1], symbols, true));

  const locationOffset = content.indexOf(match[2], variableOffset + match[1].length);
  addToken(lineTokens, lineNumber, contentStart + locationOffset, match[2].length, parameterLocations.has(match[2]) ? 'keyword' : 'variable');
}

function tokenizeResponseLine(content, lineNumber, contentStart, symbols, lineTokens) {
  const statusMatch = content.match(/^@(Success|Failure)\s+(\d{3})/);
  if (statusMatch) {
    const numberOffset = content.indexOf(statusMatch[2]);
    addToken(lineTokens, lineNumber, contentStart + numberOffset, statusMatch[2].length, 'number');
  }

  for (const match of content.matchAll(/\{(object|array|string|number|integer|boolean)\}/g)) {
    const valueOffset = match.index + 1;
    addToken(lineTokens, lineNumber, contentStart + match.index, 1, 'operator');
    addToken(lineTokens, lineNumber, contentStart + valueOffset, match[1].length, 'type');
    addToken(lineTokens, lineNumber, contentStart + valueOffset + match[1].length, 1, 'operator');
  }

  const dynamicTypeMatch = content.match(/\}\s+([A-Za-z_][A-Za-z0-9_\[\]\.*]*)/);
  if (dynamicTypeMatch) {
    const typeOffset = content.indexOf(dynamicTypeMatch[1]);
    tokenizeCompositeType(dynamicTypeMatch[1], lineNumber, contentStart + typeOffset, symbols, lineTokens);
  }
}

function tokenizeRouterLine(content, lineNumber, contentStart, lineTokens) {
  const routeMatch = content.match(/\s(\/[^\s\[]+)/);
  if (routeMatch) {
    const routeOffset = content.indexOf(routeMatch[1]);
    addToken(lineTokens, lineNumber, contentStart + routeOffset, routeMatch[1].length, 'string');

    for (const paramMatch of routeMatch[1].matchAll(/\{[A-Za-z_][A-Za-z0-9_]*\}/g)) {
      addToken(lineTokens, lineNumber, contentStart + routeOffset + paramMatch.index, paramMatch[0].length, 'parameter');
    }
  }

  const methodMatch = content.match(/\[(get|post|put|delete|patch|options|head)\]/i);
  if (methodMatch) {
    const bracketOffset = content.indexOf(methodMatch[0]);
    addToken(lineTokens, lineNumber, contentStart + bracketOffset, 1, 'operator');
    addToken(lineTokens, lineNumber, contentStart + bracketOffset + 1, methodMatch[1].length, 'keyword');
    addToken(lineTokens, lineNumber, contentStart + bracketOffset + methodMatch[0].length - 1, 1, 'operator');
  }
}

function addQualifiedTypeTokens(lineTokens, lineNumber, contentStart, content) {
  for (const match of content.matchAll(/\b([a-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const namespace = match[1];
    const member = match[2];
    addToken(lineTokens, lineNumber, contentStart + match.index, namespace.length, specialNamespaces.has(namespace) ? 'namespace' : 'variable');
    addToken(lineTokens, lineNumber, contentStart + match.index + namespace.length, 1, 'operator');
    addToken(lineTokens, lineNumber, contentStart + match.index + namespace.length + 1, member.length, 'type');
  }
}

function addIdentifierTokens(lineTokens, lineNumber, contentStart, content, symbols) {
  for (const match of content.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const word = match[0];
    const type = classifyIdentifier(word, symbols, false);
    if (!type) {
      continue;
    }

    addToken(lineTokens, lineNumber, contentStart + match.index, word.length, type);
  }

  for (const compositeMatch of content.matchAll(/(?:\[\]|\*)+[A-Za-z_][A-Za-z0-9_]*|map\[[^\]]+\][A-Za-z_][A-Za-z0-9_\[\]\.*]*/g)) {
    tokenizeCompositeType(compositeMatch[0], lineNumber, contentStart + compositeMatch.index, symbols, lineTokens);
  }
}

function tokenizeCompositeType(value, lineNumber, startCharacter, symbols, lineTokens) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ('[]{}*'.includes(character)) {
      addToken(lineTokens, lineNumber, startCharacter + index, 1, 'operator');
    }
  }

  for (const match of value.matchAll(/\b([a-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    addToken(lineTokens, lineNumber, startCharacter + match.index, match[1].length, specialNamespaces.has(match[1]) ? 'namespace' : 'variable');
    addToken(lineTokens, lineNumber, startCharacter + match.index + match[1].length, 1, 'operator');
    addToken(lineTokens, lineNumber, startCharacter + match.index + match[1].length + 1, match[2].length, 'type');
  }

  for (const match of value.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const word = match[0];
    const type = classifyIdentifier(word, symbols, false) || (responseKinds.has(word) ? 'type' : undefined);
    if (type) {
      addToken(lineTokens, lineNumber, startCharacter + match.index, word.length, type);
    }
  }
}

function classifyIdentifier(word, symbols, preferParameter) {
  if (annotationNames.has(word)) {
    return 'keyword';
  }

  if (parameterLocations.has(word) || httpMethods.has(word) || specialKeywords.has(word)) {
    return 'keyword';
  }

  if (responseKinds.has(word) || builtinTypes.has(word)) {
    return 'type';
  }

  if (specialNamespaces.has(word)) {
    return 'namespace';
  }

  if (symbols.namespaces.has(word)) {
    return 'namespace';
  }

  if (symbols.types.has(word)) {
    return 'type';
  }

  if (symbols.variables.has(word)) {
    return preferParameter ? 'parameter' : 'variable';
  }

  if (symbols.functions.has(word)) {
    return 'function';
  }

  return undefined;
}

function addPatternTokens(lineTokens, lineNumber, contentStart, content, regex, type) {
  for (const match of content.matchAll(regex)) {
    addToken(lineTokens, lineNumber, contentStart + match.index, match[0].length, type);
  }
}

function addToken(lineTokens, lineNumber, start, length, type) {
  if (!type || length <= 0) {
    return;
  }

  for (const token of lineTokens) {
    const leftEnd = token.start + token.length;
    const rightEnd = start + length;
    if (start < leftEnd && token.start < rightEnd) {
      return;
    }
  }

  lineTokens.push({ line: lineNumber, start, length, type });
}

module.exports = {
  activate,
  deactivate
};
