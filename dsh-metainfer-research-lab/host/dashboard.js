/**
 * Project dashboard: per-widget data definitions, free-form widgets, chat-driven
 * widget editing, and deterministic per-widget scripts.
 *
 * Every widget owns its data-acquisition logic in config:
 *   config.collector: 'agent' | 'script'
 *   config.query: natural-language data request for the dashboard agent
 *   config.script: deterministic command when collector === 'script'
 * Sharing data between widgets is intentionally deferred.
 */
import { LabError } from './git-engine.js';

export const DEFAULT_DASHBOARD_SPEC = {
  title: 'Dashboard',
  prompt: '',
  intervalMinutes: 15,
  enabled: false,
};

const WIDGET_TYPES = ['metric', 'text', 'list', 'activity', 'chart'];
const DEFAULT_WIDGET_W = 280;
const DEFAULT_WIDGET_H = 160;

export const WIDGET_DATA_SCHEMA = {
  type: 'object',
  properties: {
    value: { type: 'string' },
    unit: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'warn', 'error', 'idle'] },
    detail: { type: 'string' },
    body: { type: 'string' },
    items: { type: 'array', items: { type: 'string' } },
    series: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          points: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'string' },
                y: { type: 'number' },
              },
              required: ['x', 'y'],
              additionalProperties: false,
            },
          },
        },
        required: ['name', 'points'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

export const WIDGET_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    type: { type: 'string', enum: WIDGET_TYPES },
    config: { type: 'object', additionalProperties: true },
    data: WIDGET_DATA_SCHEMA,
  },
  required: ['title', 'type'],
  additionalProperties: false,
};

export const DASHBOARD_SPEC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    prompt: { type: 'string' },
    intervalMinutes: { type: 'integer' },
    enabled: { type: 'boolean' },
  },
  additionalProperties: false,
};

export const DASHBOARD_CHAT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    spec: DASHBOARD_SPEC_SCHEMA,
    widgets: { type: 'array', items: WIDGET_SCHEMA },
  },
  required: ['reply', 'spec', 'widgets'],
  additionalProperties: false,
};

/** The result of refreshing exactly one widget. */
export const WIDGET_DATA_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    data: WIDGET_DATA_SCHEMA,
  },
  required: ['data'],
  additionalProperties: false,
};

function text(value, field, max = 8000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new LabError('bad_request', `${field} must be a string`, 400);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new LabError('bad_request', `${field} is too long`, 400);
  return trimmed;
}

export function sanitizeDashboardSpec(raw, base = DEFAULT_DASHBOARD_SPEC) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new LabError('bad_request', 'dashboard spec must be an object', 400);
  }
  const interval = raw.intervalMinutes === undefined ? base.intervalMinutes : Number(raw.intervalMinutes);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1440) {
    throw new LabError('bad_request', 'dashboard intervalMinutes must be 1..1440', 400);
  }
  return {
    title: text(raw.title === undefined ? base.title : raw.title, 'dashboard title', 120) || base.title,
    prompt: text(raw.prompt === undefined ? base.prompt : raw.prompt, 'dashboard prompt', 8000),
    intervalMinutes: interval,
    enabled: raw.enabled === undefined ? base.enabled : raw.enabled === true,
  };
}

function widgetId(rawId, index, used) {
  const base = typeof rawId === 'string' && rawId.trim()
    ? rawId.trim().replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64)
    : `widget-${Date.now().toString(36)}-${index}`;
  let id = base || `widget-${index}`;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function defaultLayout(index) {
  const columns = 3;
  return {
    x: 16 + (index % columns) * (DEFAULT_WIDGET_W + 12),
    y: 16 + Math.floor(index / columns) * (DEFAULT_WIDGET_H + 12),
    w: DEFAULT_WIDGET_W,
    h: DEFAULT_WIDGET_H,
  };
}

export function normalizeWidgetData(rawData) {
  const data = rawData && typeof rawData === 'object' ? rawData : {};
  return {
    value: typeof data.value === 'string' ? data.value.slice(0, 240) : (data.value === undefined ? '' : String(data.value).slice(0, 240)),
    unit: typeof data.unit === 'string' ? data.unit.slice(0, 32) : '',
    status: ['ok', 'warn', 'error', 'idle'].includes(data.status) ? data.status : 'idle',
    detail: typeof data.detail === 'string' ? data.detail.slice(0, 2000) : '',
    body: typeof data.body === 'string' ? data.body.slice(0, 8000) : '',
    items: Array.isArray(data.items) ? data.items.slice(0, 50).map((item) => String(item).slice(0, 500)) : [],
    series: Array.isArray(data.series) ? data.series.slice(0, 4).map((series) => ({
      name: typeof series?.name === 'string' ? series.name.slice(0, 80) : 'series',
      points: Array.isArray(series?.points)
        ? series.points.slice(0, 120).map((point) => ({
            x: typeof point?.x === 'string' ? point.x.slice(0, 80) : String(point?.x ?? ''),
            y: Number(point?.y) || 0,
          }))
        : [],
    })).filter((series) => series.points.length > 0) : [],
  };
}

/** Normalize model/script widgets. Existing widgets keep their ids and layout. */
export function normalizeWidgets(rawWidgets, existing = []) {
  if (!Array.isArray(rawWidgets)) throw new LabError('bad_request', 'dashboard widgets must be an array', 400);
  const existingById = new Map(existing.map((widget) => [widget.id, widget]));
  const used = new Set();
  const widgets = [];
  for (const [index, raw] of rawWidgets.slice(0, 30).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const type = WIDGET_TYPES.includes(raw.type) ? raw.type : 'metric';
    const id = widgetId(raw.id, index, used);
    const previous = existingById.get(id);
    const layout = previous?.layout && typeof previous.layout === 'object' ? previous.layout : defaultLayout(index);
    const previousConfig = previous?.config && typeof previous.config === 'object' ? previous.config : {};
    const config = raw.config && typeof raw.config === 'object' ? { ...previousConfig, ...raw.config } : previousConfig;
    widgets.push({
      id,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : 'Widget',
      type,
      config,
      data: normalizeWidgetData(raw.data),
      layout: {
        x: Number.isFinite(Number(layout.x)) ? Number(layout.x) : 16,
        y: Number.isFinite(Number(layout.y)) ? Number(layout.y) : 16,
        w: Math.max(160, Math.min(900, Number(layout.w) || DEFAULT_WIDGET_W)),
        h: Math.max(90, Math.min(700, Number(layout.h) || DEFAULT_WIDGET_H)),
      },
      updatedAt: Date.now(),
    });
  }
  return widgets;
}

/** Preserve layouts for known widget ids after a background/chat update. */
export function applyWidgetLayouts(widgets, layouts) {
  if (!Array.isArray(layouts)) return widgets;
  const byId = new Map(layouts.map((entry) => [entry?.id, entry]));
  return widgets.map((widget) => {
    const layout = byId.get(widget.id);
    if (!layout) return widget;
    return {
      ...widget,
      layout: {
        x: Number.isFinite(Number(layout.x)) ? Number(layout.x) : widget.layout.x,
        y: Number.isFinite(Number(layout.y)) ? Number(layout.y) : widget.layout.y,
        w: Math.max(160, Math.min(900, Number(layout.w) || widget.layout.w)),
        h: Math.max(90, Math.min(700, Number(layout.h) || widget.layout.h)),
      },
    };
  });
}

/** Prompt for refreshing one widget's data only. */
export function buildWidgetPrompt(project, widget, snapshot) {
  const config = widget.config && typeof widget.config === 'object' ? widget.config : {};
  const query = typeof config.query === 'string' ? config.query.trim() : '';
  if (!query) {
    throw new LabError('widget_prompt_required', `widget ${widget.id} has no independent config.query`, 400);
  }
  return [
    'You refresh exactly ONE dashboard widget. Do not change its id, title, type, or config.',
    'Return only its new data through structured_output.',
    '',
    `# Widget\n${JSON.stringify({ id: widget.id, title: widget.title, type: widget.type, config }, null, 2)}`,
    '',
    `# Widget data request\n${query}`,
    '',
    `# Project\n${JSON.stringify({ id: project.id, name: project.name, brief: project.brief, repo: project.repo }, null, 2)}`,
    '',
    `# Snapshot\n${JSON.stringify(snapshot, null, 2)}`,
    '',
    '# Rules',
    '- Use the snapshot first. If you need files, make at most 2 targeted read-only probes.',
    '- Do not inspect every historical node and do not modify files.',
    '- Preserve the widget type and its data shape; chart widgets use data.series with points [{x,y}].',
  ].join('\n');
}

/** Prompt for the dashboard chat that adds/edits/removes widgets. */
export function buildDashboardChatPrompt(project, spec, snapshot, widgets, history, userText) {
  return [
    'You are the dashboard editor of MetaInfer Research Lab. The user talks to you in natural language',
    'to add, modify, remove, or reorganize dashboard widgets and their metric definitions.',
    'Return a short reply, the resulting dashboard-level spec, and the complete widget list through structured_output.',
    'Keep existing widget ids when modifying them. New widgets get ids like widget-<slug>.',
    'Do not set layout coordinates; the Host assigns/retains positions. Do not modify project files.',
    '',
    `# User request\n${userText}`,
    '',
    `# Recent dashboard chat\n${JSON.stringify(history.slice(-12), null, 2)}`,
    '',
    `# Current dashboard spec\n${JSON.stringify(spec, null, 2)}`,
    '',
    `# Current widgets\n${JSON.stringify(widgets, null, 2)}`,
    '',
    `# Project\n${JSON.stringify({ id: project.id, name: project.name, brief: project.brief, repo: project.repo, config: project.config }, null, 2)}`,
    '',
    `# Snapshot\n${JSON.stringify(snapshot, null, 2)}`,
    '',
    '# Widget data ownership',
    '- Every widget must have its OWN data-acquisition logic in config.',
    '- This includes existing widgets: if any returned widget lacks config.query/config.script, add a distinct query for it now.',
    '- Use config.collector: "agent" for an agent-refreshed widget, or "script" for a deterministic command.',
    '- For agent widgets set config.query: a self-contained natural-language request for how to obtain this widget\'s data.',
    '- For script widgets set config.script: a command whose stdout is this widget\'s data.',
    '- Do not make multiple widgets share one collector/query/script. Cross-widget data sharing is not implemented yet.',
    '- Put provenance in config: source, description, and formula/calculation when applicable.',
    '- Widget types: metric, text, list, activity, chart.',
    '- Preserve widget ids when editing; remove ids only when the user asks to delete.',
    '- The Host preserves drag positions for known ids.',
    '- If the user asks to change refresh interval or enable/disable scheduled refresh, include a `spec` object with the changed fields.',
  ].join('\n');
}
