# Go Swaggo Highlight

Semantic highlighting for Swaggo annotations inside Go `godoc` comment blocks.

This extension improves the readability of Swaggo comments by applying semantic token coloring that matches your current VS Code theme more closely than a static TextMate grammar.

## Why this extension exists

Swaggo annotations usually live inside Go comments, so they often look like plain comment text. That makes routes, parameter names, types, response models, JSON namespaces, and other important API details harder to scan.

`Go Swaggo Highlight` adds focused highlighting for those annotations while respecting normal Go comments outside documented API blocks.

## What it highlights

- Swaggo tags like `@Summary`, `@Description`, `@Tags`, `@Accept`, `@Produce`, `@Param`, `@Success`, `@Failure`, and `@Router`
- Go primitive types such as `string`, `int`, `bool`, `float64`, `any`, `interface`
- Composite types like `[]User`, `*User`, `map[string]any`, and qualified names like `json.RawMessage`
- HTTP methods inside router annotations such as `[get]`, `[post]`, `[patch]`
- Route fragments and route parameters like `/users/{id}` and `{id}`
- Numbers, booleans, and quoted strings inside Swaggo lines
- Real symbols from your Go codebase when they can be resolved through document symbols, workspace symbols, or local parsing

## Activation rules

Highlighting is intentionally scoped.

- It only activates inside Go files
- It only activates for `//` comment blocks
- It only starts after a line containing `godoc`
- Comments outside a `godoc` block stay as normal comments

Example:

```go
type User struct{}
type ErrorResponse struct{}

var userID int

// Normal comment: this remains a normal comment

// GetUser godoc
// @Summary Get user
// @Description Returns a user by id
// @Tags users
// @Param userID path int true "User ID"
// @Param payload body map[string]any true "Payload"
// @Success 200 {object} User
// @Failure 404 {object} json.RawMessage
// @Failure 500 {object} ErrorResponse
// @Router /users/{userID} [get]
func GetUser() {}
```

## How symbol-aware highlighting works

The extension uses a hybrid strategy:

1. Local parsing of the current file for common Go declarations like `type`, `var`, `const`, `:=`, functions, and parameters
2. `vscode.executeDocumentSymbolProvider` to read symbols reported for the current file
3. `vscode.executeWorkspaceSymbolProvider` to resolve matching names from the rest of the workspace when available

This means names used in Swaggo comments can be highlighted based on actual symbols from your project instead of only naming conventions.

## Best results

For the best workspace-wide type resolution:

- Install the official Go extension for VS Code
- Make sure `gopls` is enabled and working correctly
- Open the project root, not just a single loose file

Without workspace symbol support, the extension still works using local file analysis.

## Installation

### From a VSIX file

1. Open VS Code
2. Go to `Extensions`
3. Open the menu in the top-right corner
4. Choose `Install from VSIX...`
5. Select your packaged `.vsix`

### From the command line

```bash
code --install-extension go-swaggo-highlight-0.0.2.vsix --force
```

## Development

### Package the extension

```bash
npx @vscode/vsce package --no-dependencies
```

### Run locally

- Open the extension project in VS Code
- Press `F5`
- In the Extension Development Host, open a Go file with Swaggo comments

## Known limitations

- Highlighting currently targets line comments with `//`
- Deep Go syntax parsing is heuristic in a few cases, especially for very complex generic or multiline type expressions
- Workspace-aware symbol highlighting depends on the symbol providers available in your VS Code setup

## Roadmap

- Better support for complex composite and generic types
- More precise highlighting for `@Accept` and `@Produce` values
- Additional polish for large workspaces and caching strategies

## License

MIT. See `LICENSE`.
