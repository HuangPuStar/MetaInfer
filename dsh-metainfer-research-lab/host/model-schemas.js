/**
 * Every JSON Schema this plugin sends through the model structured-output
 * boundary, in one startup-checkable registry.
 *
 * `merge` is intentionally listed with a null schema: the lab-merge activation
 * returns ordinary text and the Host never sends it an `outputSchema`. Listing
 * the role keeps the audit complete instead of silently omitting it.
 */
import { ADVISOR_SCHEMA, SCHEDULER_SCHEMA, CHIEF_SCHEMA } from './orchestrator.js';
import { BRANCH_REPORT_SCHEMA } from './experts/hierarchy.js';
import { NODE_REPORT_SCHEMA } from './runtime.js';
import { GC_SCHEMA } from './gc.js';
import { DASHBOARD_CHAT_SCHEMA, WIDGET_DATA_RESULT_SCHEMA } from './dashboard.js';
import { assertModelSchema } from './schema-check.js';

export const MODEL_SCHEMAS = Object.freeze([
  Object.freeze({ role: 'advisor', schema: ADVISOR_SCHEMA }),
  Object.freeze({ role: 'scheduler', schema: SCHEDULER_SCHEMA }),
  Object.freeze({ role: 'branch', schema: BRANCH_REPORT_SCHEMA }),
  Object.freeze({ role: 'lead', schema: ADVISOR_SCHEMA }),
  Object.freeze({ role: 'chief', schema: CHIEF_SCHEMA }),
  Object.freeze({ role: 'worker', schema: NODE_REPORT_SCHEMA }),
  Object.freeze({ role: 'merge', schema: null, note: 'lab-merge is text-only; no structured_output schema is sent' }),
  Object.freeze({ role: 'gc', schema: GC_SCHEMA }),
  Object.freeze({ role: 'dashboard', schema: WIDGET_DATA_RESULT_SCHEMA }),
  Object.freeze({ role: 'dashboard_chat', schema: DASHBOARD_CHAT_SCHEMA }),
]);

/**
 * Fail plugin activation before any model can be called if any registered
 * schema is outside the provider's supported subset.
 * @param {ReadonlyArray<{role: string, schema: object|null}>} entries
 * @returns {string[]} checked roles
 */
export function assertModelSchemas(entries = MODEL_SCHEMAS) {
  const checked = [];
  for (const entry of entries) {
    if (!entry || typeof entry.role !== 'string') throw new TypeError('model schema registry entries require a role');
    if (entry.schema === null || entry.schema === undefined) continue;
    assertModelSchema(entry.schema, entry.role);
    checked.push(entry.role);
  }
  return checked;
}
