/**
 * 앱 버전.
 * package.json에서 직접 읽어 이중 관리를 방지한다.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { version: string };

export const APP_VERSION: string = pkg.version;
