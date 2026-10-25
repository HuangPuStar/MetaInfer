/**
 * Placement policy compiler (V7).
 *
 * Turns a project-level natural-language preference (Chinese or English) into the
 * structured constraints understood by the deterministic cluster coordinator:
 *
 *   { require: { machineLabels, gpuModels, excludeGpuModels, machineIds,
 *                excludeMachineIds, excludeMachineLabels, colocate },
 *     prefer: [{ machineLabels, gpuModels }, ...] }
 *
 * The compiler is deliberately deterministic and catalog-driven: it only matches
 * machine labels and GPU models that actually exist in the configured fleet, and
 * uses hard vs soft keywords to decide `require` vs `prefer`. Unknown phrases are
 * reported as warnings in the UI instead of silently changing behavior.
 */

const HARD_MARKERS = [
  '必须', '必需', '只能', '仅能', '只允许', '仅允许', '限定', '要求', '需要', '一定要',
  'must', 'only', 'require', 'required', 'exactly',
];
const SOFT_MARKERS = [
  '优先', '尽量', '偏好', '倾向', '最好', '希望', '首选', 'prefer', 'preferably', 'ideally', 'favor',
];
const NEGATIVE_MARKERS = [
  '不要', '不能', '不可', '排除', '除了', '禁止', '避免', '不接受',
  'exclude', 'except', 'avoid', 'not ',
];
const COLOCATE_KEYS = ['rack', 'rack_id', 'row', 'zone', 'network', 'interconnect', 'fabric', 'cluster'];

function lower(value) {
  return String(value ?? '').toLowerCase();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitClauses(text) {
  return String(text ?? '')
    .split(/[。；;！!？?\n，,]+/u)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function hasAny(text, markers) {
  return markers.some((marker) => text.includes(marker));
}

function modelTokens(model) {
  const value = lower(model);
  const tokens = value
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !['nvidia', 'geforce', 'tesla', 'microsoft', 'advanced'].includes(token));
  return uniq([value, ...tokens]);
}

function machineCatalog(catalog) {
  const machines = Array.isArray(catalog?.machines) ? catalog.machines : [];
  const labelOptions = new Map(); // key -> Set(values)
  const models = new Map(); // pattern -> label
  for (const machine of machines) {
    for (const [key, value] of Object.entries(machine.labels ?? {})) {
      const labelKey = lower(key);
      if (!labelOptions.has(labelKey)) labelOptions.set(labelKey, new Set());
      labelOptions.get(labelKey).add(lower(value));
    }
    for (const device of machine.devices ?? []) {
      for (const token of modelTokens(device.model)) {
        if (!models.has(token)) models.set(token, lower(device.model));
      }
    }
  }
  return {
    machines,
    labelOptions,
    models,
    machineIds: machines.map((machine) => machine.machineId).filter(Boolean),
    fleetLabels: Object.fromEntries([...labelOptions.entries()].map(([key, values]) => [key, [...values].sort()])),
    deviceModels: [...new Set(machines.flatMap((machine) => (machine.devices ?? []).map((device) => lower(device.model))))].sort(),
  };
}

function addLabelConstraint(target, key, value) {
  if (!target[key]) target[key] = [];
  if (!target[key].includes(value)) target[key].push(value);
}

/**
 * @param {string} text natural-language placement preference.
 * @param {{machines: Array<{machineId:string, labels?:object, devices?:Array<{model:string}>}>}} catalog
 */
export function compilePlacementPolicy(text, catalog) {
  const sourceText = String(text ?? '').trim().slice(0, 4000);
  const parsed = machineCatalog(catalog);
  const spec = {
    require: {
      machineLabels: {},
      gpuModels: [],
      excludeGpuModels: [],
      machineIds: [],
      excludeMachineIds: [],
      excludeMachineLabels: {},
      colocate: null,
    },
    preferColocate: null,
    prefer: [],
  };
  const explanation = [];
  const warnings = [];
  if (!sourceText) {
    return { spec, explanation: ['未填写 GPU 分配诉求，所有 fleet 机器都可被调度。'], warnings, catalog: parsed };
  }
  const clauses = splitClauses(sourceText);
  for (const clause of clauses) {
    const clauseLower = lower(clause);
    const negative = hasAny(clauseLower, NEGATIVE_MARKERS);
    const hard = !negative && hasAny(clauseLower, HARD_MARKERS);
    const soft = !negative && (hasAny(clauseLower, SOFT_MARKERS) || !hard);
    let matched = false;

    // Machine ids explicitly mentioned.
    for (const machineId of parsed.machineIds) {
      if (clauseLower.includes(lower(machineId))) {
        matched = true;
        if (negative) {
          if (!spec.require.excludeMachineIds.includes(machineId)) spec.require.excludeMachineIds.push(machineId);
        } else if (hard) {
          if (!spec.require.machineIds.includes(machineId)) spec.require.machineIds.push(machineId);
          explanation.push(`必须使用机器 ${machineId}`);
        } else if (soft) {
          spec.prefer.push({ machineLabels: {}, gpuModels: [], machineIds: [machineId] });
          explanation.push(`倾向使用机器 ${machineId}`);
        }
      }
    }

    // Machine labels (e.g. rack=rack-a, interconnect=nvlink, gpuModel=a100).
    for (const [key, values] of parsed.labelOptions.entries()) {
      for (const value of values) {
        const keyValueForms = [`${key}=${value}`, `${key}:${value}`, `${key} ${value}`];
        if (!keyValueForms.some((form) => clauseLower.includes(form)) && !clauseLower.includes(value)) continue;
        matched = true;
        if (negative) {
          addLabelConstraint(spec.require.excludeMachineLabels, key, value);
          explanation.push(`排除标签 ${key}=${value}`);
        } else if (hard) {
          addLabelConstraint(spec.require.machineLabels, key, value);
          explanation.push(`必须具备标签 ${key}=${value}`);
        } else if (soft) {
          spec.prefer.push({ machineLabels: { [key]: [value] }, gpuModels: [], machineIds: [] });
          explanation.push(`倾向标签 ${key}=${value}`);
        }
      }
    }

    // GPU model words.
    for (const [pattern, model] of parsed.models.entries()) {
      if (!clauseLower.includes(pattern)) continue;
      matched = true;
      if (negative) {
        if (!spec.require.excludeGpuModels.includes(pattern)) spec.require.excludeGpuModels.push(pattern);
        explanation.push(`排除 GPU 型号 ${model}`);
      } else if (hard) {
        if (!spec.require.gpuModels.includes(pattern)) spec.require.gpuModels.push(pattern);
        explanation.push(`必须使用 GPU 型号 ${model}`);
      } else if (soft) {
        if (!spec.prefer.some((rule) => rule.gpuModels.includes(pattern))) {
          spec.prefer.push({ machineLabels: {}, gpuModels: [pattern], machineIds: [] });
        }
        explanation.push(`倾向 GPU 型号 ${model}`);
      }
    }

    // Co-location preference (same rack/zone/network label).
    let colocateKey = null;
    if (/(同一|同|same)\s*(机架|机柜|rack|row)/iu.test(clause)) {
      matched = true;
      colocateKey = COLOCATE_KEYS.find((candidate) => parsed.labelOptions.has(candidate) && (candidate.includes('rack') || candidate === 'row')) ?? 'rack';
    } else if (/(同一|同|same)\s*(区域|zone)/iu.test(clause)) {
      matched = true;
      colocateKey = parsed.labelOptions.has('zone') ? 'zone' : 'zone';
    } else if (/(同一|同|same)\s*(网络|互联|fabric|interconnect)/iu.test(clause)) {
      matched = true;
      colocateKey = COLOCATE_KEYS.find((candidate) => ['network', 'interconnect', 'fabric'].includes(candidate) && parsed.labelOptions.has(candidate)) ?? 'network';
    }
    if (colocateKey) {
      if (hard) {
        spec.require.colocate = colocateKey;
        explanation.push(`必须把租用机器放在同一 ${colocateKey}（colocate=${colocateKey}）`);
      } else {
        spec.preferColocate = colocateKey;
        explanation.push(`尽量把租用机器放在同一 ${colocateKey}`);
      }
    }

    if (!matched && clause.length > 0) {
      warnings.push(`未能从「${clause.slice(0, 80)}」中识别出已配置的机器标签/GPU 型号，已忽略该句。`);
    }
  }

  // Deduplicate / validate preferences.
  spec.prefer = spec.prefer
    .filter((rule) => Object.keys(rule.machineLabels).length > 0 || rule.gpuModels.length > 0 || (rule.machineIds?.length ?? 0) > 0)
    .slice(0, 5);
  for (const rule of spec.prefer) {
    for (const key of Object.keys(rule.machineLabels)) {
      if (!parsed.labelOptions.has(key)) {
        warnings.push(`偏好中的标签 ${key} 不在任何 fleet 机器上。`);
      }
    }
  }

  // Validate hard requirements against the catalog.
  for (const [key, values] of Object.entries(spec.require.machineLabels)) {
    if (!parsed.labelOptions.has(key)) warnings.push(`必须条件中的标签 ${key} 不在任何 fleet 机器上，该策略会一直排队。`);
    for (const value of values) {
      if (!(parsed.labelOptions.get(key)?.has(value) ?? false)) {
        warnings.push(`必须条件 ${key}=${value} 目前没有被任何 fleet 机器满足。`);
      }
    }
  }
  for (const pattern of spec.require.gpuModels) {
    if (!parsed.deviceModels.some((model) => model.includes(pattern))) {
      warnings.push(`必须条件中的 GPU 型号 ${pattern} 目前没有 fleet 机器提供。`);
    }
  }
  for (const machineId of spec.require.machineIds) {
    if (!parsed.machineIds.includes(machineId)) warnings.push(`必须使用的机器 ${machineId} 不在 fleet 配置中。`);
  }
  if (Object.keys(spec.require.excludeMachineLabels).length > 0 && spec.require.machineLabels && Object.keys(spec.require.machineLabels).length > 0) {
    warnings.push('同时存在包含与排除标签；若二者冲突，任务会一直排队。');
  }
  if (explanation.length === 0) explanation.push('没有解析出任何可执行的分配规则。');
  return {
    spec,
    explanation,
    warnings,
    catalog: {
      machines: parsed.machines.map((machine) => ({
        machineId: machine.machineId,
        labels: machine.labels ?? {},
        models: uniq((machine.devices ?? []).map((device) => lower(device.model))),
      })),
      labels: parsed.fleetLabels,
      models: parsed.deviceModels,
    },
  };
}

/** Human-readable one-line summary of a compiled spec. */
export function describePlacementSpec(spec) {
  if (!spec) return '未设置分配规则';
  const parts = [];
  const require = spec.require ?? {};
  for (const [key, values] of Object.entries(require.machineLabels ?? {})) parts.push(`必须 ${key}∈[${values.join(',')}]`);
  if ((require.gpuModels ?? []).length > 0) parts.push(`必须 GPU 含 ${require.gpuModels.join('/')}`);
  if ((require.machineIds ?? []).length > 0) parts.push(`必须机器 ${require.machineIds.join(',')}`);
  for (const [key, values] of Object.entries(require.excludeMachineLabels ?? {})) parts.push(`排除 ${key}∈[${values.join(',')}]`);
  if ((require.excludeGpuModels ?? []).length > 0) parts.push(`排除 GPU ${require.excludeGpuModels.join('/')}`);
  if ((require.excludeMachineIds ?? []).length > 0) parts.push(`排除机器 ${require.excludeMachineIds.join(',')}`);
  if (require.colocate) parts.push(`必须同 ${require.colocate} 合置`);
  if (spec.preferColocate) parts.push(`尽量同 ${spec.preferColocate}`);
  for (const rule of spec.prefer ?? []) {
    const tokens = [];
    for (const [key, values] of Object.entries(rule.machineLabels ?? {})) tokens.push(`${key}=${values.join('|')}`);
    if ((rule.gpuModels ?? []).length > 0) tokens.push(`GPU ${rule.gpuModels.join('|')}`);
    if ((rule.machineIds ?? []).length > 0) tokens.push(`机器 ${rule.machineIds.join('|')}`);
    if (tokens.length > 0) parts.push(`优先 ${tokens.join(' ')}`);
  }
  return parts.length > 0 ? parts.join('；') : '未设置硬性规则';
}

/** Validate/canonicalize a compiled placement spec (used by project config). */
export function sanitizePlacementSpec(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('placementPolicy.spec must be an object');
  const requireRaw = raw.require && typeof raw.require === 'object' && !Array.isArray(raw.require) ? raw.require : {};
  const labelMap = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const output = {};
    for (const [key, values] of Object.entries(value).slice(0, 16)) {
      const name = lower(key).slice(0, 80);
      const list = (Array.isArray(values) ? values : [values])
        .map((item) => lower(item).slice(0, 160))
        .filter(Boolean)
        .slice(0, 8);
      if (name && list.length > 0) output[name] = list;
    }
    return output;
  };
  const list = (value, max = 64) => (Array.isArray(value)
    ? value.filter((item) => typeof item === 'string').map((item) => lower(item).slice(0, 160)).slice(0, max)
    : []);
  const prefer = Array.isArray(raw.prefer)
    ? raw.prefer.slice(0, 5).map((rule) => ({
        machineLabels: labelMap(rule?.machineLabels),
        gpuModels: list(rule?.gpuModels, 8),
        machineIds: Array.isArray(rule?.machineIds) ? rule.machineIds.filter((id) => typeof id === 'string').slice(0, 64) : [],
      })).filter((rule) => Object.keys(rule.machineLabels).length > 0 || rule.gpuModels.length > 0 || rule.machineIds.length > 0)
    : [];
  return {
    preferColocate: typeof raw.preferColocate === 'string' && raw.preferColocate.trim()
      ? lower(raw.preferColocate).slice(0, 80)
      : null,
    require: {
      machineLabels: labelMap(requireRaw.machineLabels),
      gpuModels: list(requireRaw.gpuModels, 8),
      excludeGpuModels: list(requireRaw.excludeGpuModels, 8),
      machineIds: Array.isArray(requireRaw.machineIds) ? requireRaw.machineIds.filter((id) => typeof id === 'string').slice(0, 64) : [],
      excludeMachineIds: Array.isArray(requireRaw.excludeMachineIds) ? requireRaw.excludeMachineIds.filter((id) => typeof id === 'string').slice(0, 64) : [],
      excludeMachineLabels: labelMap(requireRaw.excludeMachineLabels),
      colocate: typeof requireRaw.colocate === 'string' && requireRaw.colocate.trim()
        ? lower(requireRaw.colocate).slice(0, 80)
        : null,
    },
    prefer,
  };
}
