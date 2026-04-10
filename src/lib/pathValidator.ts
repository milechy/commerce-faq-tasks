import path from 'path'

/**
 * Resolves userInput relative to basePath and asserts the result
 * stays within basePath (prevents path traversal attacks).
 * @throws Error if the resolved path escapes basePath
 */
function safePath(basePath: string, userInput: string): string {
  const resolvedBase = path.resolve(basePath)
  const resolvedPath = path.resolve(basePath, path.normalize(userInput))
  if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
    throw new Error(`Invalid file path: access outside base directory is not allowed`)
  }
  return resolvedPath
}
