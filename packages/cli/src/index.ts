import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { main } from './main.js';
import { defaultIo } from './config.js';

export { main, CLI_SUBCOMMANDS } from './main.js';
export { defaultIo } from './config.js';

// dev 直跑（tsx packages/cli/src/index.ts）时充当统一入口；
// release bin import 打包产物时 argv[1] 是 bin/paneflow.mjs，不会误触发。
const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), defaultIo());
}
