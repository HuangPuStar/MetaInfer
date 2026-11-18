/** Pure CPU mock regressions; no Host service/remote/Agent execution. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const result=spawnSync(process.execPath,['--test','--test-timeout=15000',fileURLToPath(new URL('../tests/sandbox-config/contracts.test.mjs',import.meta.url))],{stdio:'inherit',timeout:30000});
if(result.error) throw result.error;
process.exit(result.status??1);
