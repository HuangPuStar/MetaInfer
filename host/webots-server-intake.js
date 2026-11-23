import { randomBytes } from 'node:crypto';
import path from 'node:path';

const FIELDS = { name: '项目名称', repoPath: '已有 Git 仓库绝对路径', brief: '研究目标', initialPrompt: '根节点任务' };
const USAGE = '请提供项目名称、这台服务器上已有的 Git 仓库绝对路径、研究目标和根节点任务。我会先发草稿，确认后才建项目和项目群，不启动节点。';
const DRAFT_TTL_MS = 15 * 60_000;

async function extractDraft(text, previous) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('服务器尚未配置 DeepSeek 官方 API。');
  let response;
  try {
    response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 1800,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: 'Extract a proposal for one MetaInfer project. Return a JSON object with name, repoPath, brief, initialPrompt (strings, or null if missing), or {} for unrelated requests. Merge corrections into the previous draft. Preserve the exact absolute path and never invent it. Do not execute or confirm any action. A human will separately review and confirm all four fields.',
        }, { role: 'user', content: JSON.stringify({ previous, text }) }],
      }),
      signal: AbortSignal.timeout(40_000),
    });
  } catch {
    throw new Error('DeepSeek 官方 API 暂时不可达。');
  }
  if (!response.ok) throw new Error(`DeepSeek 官方 API 请求失败（HTTP ${response.status}）。`);
  try {
    return JSON.parse((await response.json()).choices[0].message.content);
  } catch {
    throw new Error('DeepSeek 官方 API 没有返回有效草稿，请按四个字段重试。');
  }
}

// Use inbox metadata from WeBots, never a user name or signature in the body.
export function assertServerSender(binding, item) {
  const sender = item?.message?.sender_id;
  if (item?.room_id !== binding.roomId || item?.recipient_id !== binding.actorId
    || item?.message?.sender_kind !== 'human' || !binding.operatorIds.includes(sender)) {
    throw new Error('此 Bridge 只在绑定群里接受已授权的人类账号请求。');
  }
  return sender;
}

export function createServerIntake({ service, provision, extract = extractDraft }) {
  const drafts = new Map();
  return async (binding, item, text) => {
    const sender = assertServerSender(binding, item);
    const key = `${binding.actorId}:${binding.roomId}:${sender}`;
    const now = Date.now();
    for (const [id, draft] of drafts) if (draft.expiresAt <= now) drafts.delete(id);
    const draft = drafts.get(key);
    const confirmation = text.match(/^确认创建\s+([a-f0-9]{8})$/i);
    if (confirmation) {
      if (draft?.code !== confirmation[1].toLowerCase()) return '确认编号不存在或已过期，请先提交建项目草稿。';
      if (draft.reply) return draft.reply;
      if (!draft.projectId) {
        try {
          const { project } = await service.createProject(draft.fields);
          draft.projectId = project.id;
        } catch {
          return '未能确认项目创建成功。请检查本机仓库、默认分支和项目列表；若没有新项目，再重发原确认码。';
        }
      }
      try {
        const { actorId, roomId } = await provision(draft.projectId, draft.fields.name);
        draft.reply = `已在本机创建 MetaInfer 项目「${draft.fields.name}」(${draft.projectId})；根节点未启动。\n项目代理：${actorId}\n项目群：${roomId}\n已将预设联系人加入项目群。`;
        return draft.reply;
      } catch {
        return `项目 ${draft.projectId} 已创建，项目群尚未配置完成。可重发「确认创建 ${draft.code}」只补配置，不会重建项目。`;
      }
    }
    if (text === '取消创建') {
      if (draft?.projectId) return `项目 ${draft.projectId} 已创建，取消草稿不会撤销它。`;
      drafts.delete(key);
      return '已取消建项目草稿。';
    }
    if (text.startsWith('确认创建')) return '请使用草稿中的完整确认编号。';
    if (text.length > 8000) return '请求过长，请在 8000 字以内填写项目字段。';
    if (draft?.projectId && !draft.reply) return `项目 ${draft.projectId} 已创建，请先重发「确认创建 ${draft.code}」补齐项目群。`;

    const previous = draft?.reply ? {} : draft?.fields ?? {};
    drafts.delete(key); // Never let an old approval code approve a revised draft.
    const result = await extract(text, previous);
    const fields = {};
    for (const name of Object.keys(FIELDS)) {
      const value = typeof result?.[name] === 'string' ? result[name].trim() : '';
      if (!value || value.length > (name === 'name' ? 120 : 4096)) continue;
      if (name === 'repoPath' && (!path.isAbsolute(value) || /[\r\n\0]/.test(value)
        || (previous.repoPath !== value && !text.includes(value)))) continue;
      if (name === 'initialPrompt' && value.length < 10) continue;
      fields[name] = value;
    }
    if (!Object.keys(fields).length) return USAGE;
    const missing = Object.keys(FIELDS).filter((name) => !fields[name]);
    const code = missing.length ? null : randomBytes(4).toString('hex');
    drafts.set(key, { fields, code, expiresAt: Date.now() + DRAFT_TTL_MS });
    const preview = Object.entries(fields).map(([name, value]) => `${FIELDS[name]}：${value}`).join('\n');
    return `本机项目草稿（还没创建）：\n${preview}\n${missing.length
      ? `还需补充：${missing.map((name) => FIELDS[name]).join('、')}。`
      : `确认后创建项目、项目代理和项目群，并拉入预设联系人；不启动节点。15 分钟内发送：确认创建 ${code}`}`;
  };
}
