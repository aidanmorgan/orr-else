import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * PATH_INSTALL_ROOT: The directory where the harness is installed.
 * If running from dist/core/Paths.js, we go up two levels to reach the root.
 */
export const PATH_INSTALL_ROOT = path.resolve(__dirname, '../../');

/**
 * Pure helper: resolve path segments relative to an explicit root.
 * Prefer this over resolveProject() in any code that has an injected projectRoot.
 */
export const resolveProjectFrom = (root: string, ...args: string[]) => path.join(root, ...args);

/**
 * Resolves a path relative to the installation root.
 */
export const resolveInstall = (...args: string[]) => path.join(PATH_INSTALL_ROOT, ...args);
