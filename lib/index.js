import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULTS, MAX_INPUT_BYTES, EXTENSIONS, normalizeSettings, probeMedia, planFrames, extractFrames, binaries } from './media.js';

export const name = 'dsh-media-reader';
export const inject = ['tools', 'attachments', 'fs', 'workingDirectory', 'llm', 'connection', 'agents'];
const imageSchema = { type: 'object', additionalProperties: true, properties: { attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, name: { type: 'string' } }, required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'] };

function messageFiles(event) {
  if (event?.type !== 'user/message') return [];
  const files = new Map();
  for (const block of event.data?.content || []) {
    const ref = block.type === 'file' ? block.attachment : undefined;
    if (ref && typeof ref.attachmentId === 'string' && typeof ref.name === 'string' && Number.isSafeInteger(ref.bytes) && EXTENSIONS.test(ref.name)) files.set(ref.attachmentId, { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes });
  }
  return [...files.values()];
}

export function sessionFiles(session) {
  const files = new Map();
  for (const event of session?.snapshotEvents?.() || []) {
    for (const ref of messageFiles(event)) files.set(ref.attachmentId, ref);
  }
  return [...files.values()];
}

/** Uploaded file blocks become text handles before a model receives them.
 * Resolve a requested original name against one latest matching user message,
 * so a newly imported file does not require the model to invent a full digest. */
export function sessionFileByName(session, name) {
  const events = session?.snapshotEvents?.() || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const matches = messageFiles(events[i]).filter(ref => ref.name === name);
    if (!matches.length) continue;
    if (matches.length !== 1) throw new Error('最近一条包含该名称的消息有多个同名媒体，请改用明确的 attachment_id，或给文件改名后重新导入。');
    return matches[0];
  }
  return undefined;
}

export async function assertVision(ctx, agent, signal) {
  const current = agent?.session.requestHeader()?.config;
  const provider = current?.provider ?? agent?.options.provider;
  const model = current?.model ?? agent?.options.model;
  if (!provider || !model) throw new Error('无法确认当前会话的模型；请先选择支持图片输入的模型。');
  const info = await ctx.llm.resolveModelInfo(provider, model, signal);
  if (!info?.inputModalities?.includes('image')) throw new Error(`当前模型“${model}”未声明看图能力。请切换到支持图片输入的模型后重试视频/GIF读取。`);
  return { provider, model };
}

export async function copySource(ctx, args, exec, destination) {
  const hasPath = typeof args.file_path === 'string' && args.file_path.trim() !== '';
  const hasId = typeof args.attachment_id === 'string' && args.attachment_id !== '';
  const hasName = typeof args.attachment_name === 'string' && args.attachment_name !== '';
  if ([hasPath, hasId, hasName].filter(Boolean).length !== 1) throw new Error('请且仅提供 file_path、attachment_id 或 attachment_name 其中一项。');
  let label, data, observation;
  if (hasId || hasName) {
    const ref = hasName ? sessionFileByName(exec.agent?.session, args.attachment_name) : sessionFiles(exec.agent?.session).find(f => f.attachmentId === args.attachment_id);
    if (!ref) throw new Error('该媒体不是当前会话中的原始文件附件。普通图片上传的 GIF 可能已变成首帧，请从扩展口袋重新导入原始 GIF。');
    if (ref.bytes > MAX_INPUT_BYTES) throw new Error('媒体超过 512 MB 上限；请先截取片段。');
    label = ref.name;
    data = ctx.attachments.readFileStream(ref, exec.signal);
  } else {
    if (!EXTENSIONS.test(args.file_path)) throw new Error('本地路径须指向常见视频或 GIF 文件。');
    const cwd = exec.agent ? await ctx.workingDirectory.ensure(exec.agent, exec.signal) : undefined;
    const target = await ctx.fs.resolve(args.file_path, { ...(cwd ? { cwd } : {}), signal: exec.signal });
    const info = await ctx.fs.stat(target, exec.signal);
    if (info?.type !== 'file') throw new Error('路径不存在，或不是普通文件。');
    if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > MAX_INPUT_BYTES) throw new Error('文件为空、大小未知，或超过 512 MB 上限。');
    label = path.basename(target.displayPath);
    data = (async function* () {
      for (let offset = 0; offset < info.size; offset += 1024 * 1024) {
        exec.signal.throwIfAborted();
        const length = Math.min(1024 * 1024, info.size - offset);
        const bytes = await ctx.fs.readByteRange(target, { offset, length }, exec.signal);
        if (bytes.length !== length) throw new Error('读取时源文件发生变化，请等文件写入完成后重试。');
        yield bytes;
      }
      const after = await ctx.fs.stat(target, exec.signal);
      if (after?.version !== info.version || after?.size !== info.size) throw new Error('读取时源文件发生变化，请重试。');
    })();
    observation = () => ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
  }
  let bytes = 0;
  const handle = await fs.open(destination, 'wx');
  try {
    for await (const chunk of data) {
      exec.signal.throwIfAborted(); bytes += chunk.byteLength;
      if (bytes > MAX_INPUT_BYTES) throw new Error('媒体超过 512 MB 上限。');
      await handle.writeFile(chunk);
    }
  } finally { await handle.close(); }
  if (!bytes) throw new Error('媒体文件为空。');
  observation?.();
  return { label, bytes };
}

export function renderResult(_args, value) {
  const notes = ['这些是稀疏抽样画面，不是完整视频。只描述画面支持的事实，不推断音频；不能据此断言未抽到的事件没有发生。', '需要细节时，对同一来源使用 timestamps_seconds 或 start_seconds/end_seconds 补抽。'];
  if (value.capped) notes.push('帧数已按当前 DSH 的图片数量限制缩减。');
  return [{ type: 'text', text: JSON.stringify({ source: value.source, duration_seconds: value.duration_seconds, original_size: [value.width, value.height], range_seconds: [value.start_seconds, value.end_seconds], frame_count: value.frames.length, notes }, null, 2) }, ...value.frames.flatMap((frame, i) => [
    { type: 'text', text: `画面 ${i + 1}：实际时间 ${frame.time_seconds.toFixed(3)} 秒；请求时间 ${frame.requested_time_seconds.toFixed(3)} 秒。` },
    { type: 'image', attachment: frame.image },
  ])];
}

export function createTool(ctx, settings, lifecycle = new AbortController(), options = {}) {
  let busy = false;
  const tempRoot = options.tempRoot || path.join(os.tmpdir(), 'dsh-media-reader');
  return {
    name: 'read_media',
    description: 'Read local videos or original GIF/video file attachments as timestamped images using the CURRENT image-capable model. Provide exactly one source: file_path (filesystem access policy applies), attachment_id (an exact full ID in this session), or attachment_name (exact original filename; resolves the latest user message containing that name and refuses ambiguous duplicates). Uploaded file blocks become text handles, so use attachment_name for a newly imported file rather than inventing a digest. Default: 12 uniformly spaced frames, no audio transcription. GIF unequal frame delays, disposal and one-loop composition are respected. Use timestamps_seconds or start_seconds/end_seconds for follow-up details; sparse frames cannot prove an event is absent. Do not use read_image for animated GIF or install media tools: this tool includes its decoder.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      file_path: { type: 'string', description: 'Local video/GIF path, resolved in the current session filesystem.' },
      attachment_id: { type: 'string', description: 'Exact attachmentId of an ORIGINAL file block in this session; never an image block.' },
      attachment_name: { type: 'string', description: 'Exact original filename of a GIF/video uploaded in this session. Uses the latest user message containing that name and rejects multiple distinct same-name files in that message.' },
      frame_count: { type: 'integer', description: 'Uniform frame count, integer 1–24; default configured by the user (12 initially).' },
      start_seconds: { type: 'number', description: 'Non-negative range start in seconds, default 0.' }, end_seconds: { type: 'number', description: 'Range end in seconds; must exceed start and not exceed media duration.' },
      timestamps_seconds: { type: 'array', items: { type: 'number' }, description: '1–24 non-negative explicit times relative to media start, each within the selected range and before its end; replaces uniform sampling.' },
    } },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      source: { type: 'string' }, duration_seconds: { type: 'number' }, width: { type: 'integer' }, height: { type: 'integer' },
      start_seconds: { type: 'number' }, end_seconds: { type: 'number' }, capped: { type: 'boolean' },
      frames: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { time_seconds: { type: 'number' }, requested_time_seconds: { type: 'number' }, image: imageSchema }, required: ['time_seconds','requested_time_seconds','image'] } },
    }, required: ['source','duration_seconds','width','height','start_seconds','end_seconds','capped','frames'] }, render: renderResult },
    timeoutMs: 240000,
    isConcurrencySafe: () => false,
    presentCall: args => ({ card: 'generic', title: '读取视频/GIF画面', kind: 'read', ...(args.file_path ? { locations: [{ path: args.file_path }] } : {}) }),
    async execute(args, exec) {
      if (busy) throw new Error('正在处理另一个媒体文件，请等当前抽帧完成后再试。');
      const signal = AbortSignal.any([exec.signal, lifecycle.signal, AbortSignal.timeout(210000)]);
      signal.throwIfAborted();
      busy = true;
      let directory;
      try {
        await assertVision(ctx, exec.agent, signal);
        if (!ctx.attachments.imageLimits.mediaTypes.includes('image/png')) throw new Error('当前 DSH 不接收 PNG 图片，无法返回抽帧画面。');
        await fs.mkdir(tempRoot, { recursive: true });
        directory = await fs.mkdtemp(path.join(tempRoot, 'job-'));
        const source = path.join(directory, 'source.media');
        const original = await copySource(ctx, args, { ...exec, signal }, source);
        const info = await probeMedia(source, { signal, ...options });
        const config = await settings();
        const limits = ctx.attachments.imageLimits;
        const plan = planFrames(info, args, config, limits.maxImagesPerMessage);
        const images = await extractFrames(source, info, plan, directory, { ...options, signal, maxSide: Math.min(config.maxSide, limits.maxImageDimension, Math.floor(Math.sqrt(limits.maxImagePixels))), maxImageBytes: Math.min(limits.maxImageBytes, 2 * 1024 * 1024), maxTotalBytes: Math.min(limits.maxMessageImageBytes, 24 * 1024 * 1024) });
        const frames = [];
        for (let i = 0; i < images.length; i++) {
          signal.throwIfAborted();
          const frame = images[i];
          const image = await ctx.attachments.saveImage({ data: await fs.readFile(frame.filename), mediaType: 'image/png', name: `media-frame-${i + 1}-${frame.time.toFixed(3)}s.png` });
          frames.push({ time_seconds: frame.time, requested_time_seconds: frame.requested, image });
        }
        signal.throwIfAborted();
        return { source: original.label, duration_seconds: info.duration, width: info.width, height: info.height, start_seconds: plan.start, end_seconds: plan.end, capped: plan.capped, frames };
      } finally {
        try {
          if (directory && path.dirname(path.resolve(directory)) === path.resolve(tempRoot) && !(await fs.lstat(directory)).isSymbolicLink()) await fs.rm(directory, { recursive: true, force: true });
        } finally { busy = false; }
      }
    },
  };
}

export function apply(ctx) {
  const lifecycle = new AbortController();
  const configPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-media-reader.json');
  const settings = async () => {
    try { return normalizeSettings(JSON.parse(await fs.readFile(configPath, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { ...DEFAULTS }; throw new Error('视频/GIF配置无法读取，请在插件配置中重新保存。'); }
  };
  ctx.effect(() => ctx.tools.register(createTool(ctx, settings, lifecycle)));
  const route = '/api/plugins/media-reader';
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  ctx.effect(() => ctx.connection.fetch.register({ path: route, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: async request => {
    try {
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: '需要 JSON 配置。' }, 415);
        const body = await request.text();
        if (body.length > 4096) return json({ error: '配置内容过大。' }, 413);
        const input = JSON.parse(body), value = normalizeSettings(input);
        if (input.frameCount !== value.frameCount || input.maxSide !== value.maxSide) return json({ error: '配置范围无效。' }, 400);
        const tmp = configPath + '.tmp-' + randomUUID();
        try { await fs.writeFile(tmp, JSON.stringify(value, null, 2), { flag: 'wx' }); await fs.rename(tmp, configPath); }
        finally { await fs.unlink(tmp).catch(() => {}); }
        return json({ settings: value });
      }
      const sessionId = new URL(request.url).searchParams.get('sessionId');
      if (sessionId) {
        const agent = ctx.agents.get(sessionId);
        if (!agent) return json({ error: '当前会话尚未就绪，请先打开会话后重试。' }, 404);
        let model;
        try { model = { ...await assertVision(ctx, agent, request.signal), imageCapable: true }; }
        catch (error) { model = { imageCapable: false, message: error.message }; }
        return json({ files: sessionFiles(agent.session), model, settings: await settings() });
      }
      const bin = binaries();
      const available = await Promise.all(Object.values(bin).map(file => fs.access(file).then(() => true, () => false)));
      return json({ settings: await settings(), decoderReady: available.every(Boolean), version: '1.0.1' });
    } catch (error) { return json({ error: error.message || '媒体插件请求失败。' }, 400); }
  } }));
  ctx.effect(() => () => lifecycle.abort(new Error('视频/GIF插件已停用。')));
}
export default { name, inject, apply };
