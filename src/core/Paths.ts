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
 * PATH_PROJECT_ROOT: The directory where the user's project resides.
 * Defaults to process.cwd(), but can be overridden by the Orchestrator.
 */
let projectRoot = process.cwd();

export const setProjectRoot = (root: string) => {
  projectRoot = path.resolve(root);
};

export const getProjectRoot = () => projectRoot;

/**
 * Resolves a path relative to the project root.
 */
export const resolveProject = (...args: string[]) => path.join(getProjectRoot(), ...args);

/**
 * Resolves a path relative to the installation root.
 */
export const resolveInstall = (...args: string[]) => path.join(PATH_INSTALL_ROOT, ...args);
