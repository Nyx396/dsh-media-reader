window.__ModuleLoader__.load({ id: 'dsh-media-reader', factory(require) {
  const React = require('react'), { createPortal } = require('react-dom');
  const h = React.createElement;
  const ROUTE = 'api/plugins/media-reader';
  const EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|ts|m2ts|wmv|flv|ogv|gif)$/i;
  const ACCEPT = '.mp4,.m4v,.mov,.mkv,.webm,.avi,.mpeg,.mpg,.ts,.m2ts,.wmv,.flv,.ogv,.gif';
  const CSS = `
.dmr-root{font-family:inherit;color:var(--dsw-alias-label-primary,#25252a);font-size:14px;line-height:1.55}.dmr-overlay{position:fixed;inset:0;z-index:10000;background:#0006;display:grid;place-items:center;padding:20px}.dmr-dialog{box-sizing:border-box;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:16px;box-shadow:0 20px 70px #0003;width:min(640px,100%);max-height:calc(100dvh - 40px);overflow:auto;padding:24px}.dmr-root h2{font-size:20px;margin:0 0 8px}.dmr-root p{margin:8px 0 16px}.dmr-muted{color:var(--dsw-alias-label-secondary,#6a6a72);font-size:13px}.dmr-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.dmr-root button,.dmr-root input,.dmr-root textarea,.dmr-root select{font:inherit;color:inherit;box-sizing:border-box}.dmr-root button{border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;padding:8px 12px;background:transparent;cursor:pointer}.dmr-root button:disabled{opacity:.5;cursor:default}.dmr-root button:focus-visible,.dmr-root input:focus-visible,.dmr-root textarea:focus-visible,.dmr-root select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#6559c7);outline-offset:3px}.dmr-tabs{display:flex;gap:8px;margin:16px 0}.dmr-tabs button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover-solid,#f0effa);border-color:var(--dsw-alias-brand-primary,#6559c7)}.dmr-source{border:1px dashed var(--dsw-alias-border-l2,#ccc);border-radius:10px;padding:18px;margin-bottom:16px}.dmr-source input[type=file]{max-width:100%;display:block;margin-top:10px}.dmr-field{display:grid;gap:6px;margin:14px 0}.dmr-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.dmr-root input:not([type=file]),.dmr-root textarea,.dmr-root select{width:100%;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:8px;background:transparent;padding:9px 10px}.dmr-root textarea{resize:vertical;min-height:72px}.dmr-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.dmr-root .dmr-primary{background:var(--dsw-alias-label-primary,#25252a);border-color:transparent;color:var(--dsw-alias-bg-layer-2,#fff)}.dmr-error{border:1px solid #c75b5b;color:var(--dsw-alias-label-primary,#8c2727);background:#c75b5b12;border-radius:8px;padding:10px;overflow-wrap:anywhere}.dmr-status{padding:10px 0;font-size:13px}.dmr-root code{overflow-wrap:anywhere}.dmr-file-label{display:block;margin-top:10px;overflow-wrap:anywhere}.dmr-settings{max-width:640px}.dmr-check{border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:10px;padding:12px;margin:16px 0}@media(max-width:520px){.dmr-overlay{padding:10px}.dmr-dialog{padding:18px;max-height:calc(100dvh - 20px)}.dmr-row{grid-template-columns:1fr}.dmr-tabs button{flex:1;padding:8px}}@media(forced-colors:active){.dmr-root .dmr-primary{color:ButtonText;border:1px solid ButtonText}.dmr-tabs button[aria-pressed=true]{outline:2px solid Highlight}}
`;

  async function api(sessionId, options = {}) {
    const response = await fetch(ROUTE + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''), { credentials: 'include', ...options });
    let value;
    try { value = await response.json(); }
    catch { throw new Error('插件连接暂未就绪，请重启 DSH 后重试（' + response.status + '）。'); }
    if (!response.ok || value.error) throw new Error(value.error || '插件请求失败。');
    return value;
  }
  function field(label, props) { return h('label', { className: 'dmr-field' }, h('span', null, label), h('input', props)); }
  function createController() {
    let current = null;
    const listeners = new Set();
    const publish = () => { for (const fn of listeners) fn(); };
    const close = () => { if (!current) return; const old = current; current = null; old.context.signal.removeEventListener('abort', close); publish(); old.resolve(); };
    return {
      getSnapshot: () => current, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, close,
      open(context) {
        close(); context.signal.throwIfAborted();
        return new Promise(resolve => { current = { context, resolve }; context.signal.addEventListener('abort', close, { once: true }); publish(); });
      },
    };
  }
  function readOptions(count, start, end, stamps) {
    const options = { frame_count: Number(count) };
    if (!Number.isInteger(options.frame_count) || options.frame_count < 1 || options.frame_count > 24) throw new Error('抽帧数量须为 1–24 的整数。');
    if (start !== '') options.start_seconds = Number(start);
    if (end !== '') options.end_seconds = Number(end);
    if (stamps.trim()) {
      options.timestamps_seconds = stamps.trim().split(/[,，\s]+/).map(Number);
      if (options.timestamps_seconds.length > 24 || !options.timestamps_seconds.every(t => Number.isFinite(t) && t >= 0)) throw new Error('时间点请填写最多 24 个非负秒数，用逗号隔开。');
    }
    if (options.start_seconds !== undefined && (!Number.isFinite(options.start_seconds) || options.start_seconds < 0)) throw new Error('开始时间无效。');
    if (options.end_seconds !== undefined && (!Number.isFinite(options.end_seconds) || options.end_seconds <= (options.start_seconds ?? 0))) throw new Error('结束时间须大于开始时间。');
    return options;
  }
  function makePrompt(source, options, question) {
    const target = source.kind === 'attachment' ? { attachment_id: source.id } : source.kind === 'path' ? { file_path: source.path } : { attachment_name: source.name };
    return '\n请用 read_media 读取' + (source.kind === 'upload' ? '本条消息中名为 ' + JSON.stringify(source.name) + ' 的原始文件附件' : '以下视频/GIF') + '，参数：' + JSON.stringify({ ...target, ...options }) + '。' + (question.trim() ? '\n我关注：' + question.trim() : '\n请按时间顺序描述主要画面与变化。') + '\n请区分画面证据与推测；如抽样不足，请补抽相关时间点。\n';
  }
  function stageDraft(conversation, context, source, options, question) {
    context.signal.throwIfAborted();
    const actions = context.inputActions;
    if (typeof actions?.captureInsertion !== 'function' || typeof actions?.insertText !== 'function') throw new Error('当前输入框尚未就绪，请先进入一个普通聊天会话。');
    let drafts = [];
    try {
      if (source.kind === 'upload') {
        if (!EXTENSIONS.test(source.file.name)) throw new Error('请选择常见视频或 GIF 文件。');
        if (!source.file.size || source.file.size > 512 * 1024 * 1024) throw new Error('文件为空或超过 512 MB；请先截取片段。');
        // Force the original-byte file route. Native image/GIF normalization
        // intentionally must not run before this plugin sees the animation.
        const original = new File([source.file], source.file.name, { type: 'application/octet-stream', lastModified: source.file.lastModified });
        drafts = conversation.createDrafts(context.sessionId, [original]);
        if (!actions.addAttachments(drafts.map(d => d.id))) throw new Error('输入框正在发送或确认，请稍后再导入。');
      }
      const span = actions.captureInsertion();
      if (!actions.insertText(makePrompt(source, options, question), span)) throw new Error('输入框正在变化，本次未插入读取请求，请重试。');
      actions.persistDraft?.();
    } catch (error) {
      for (const draft of drafts) actions.removeAttachment?.(draft.id);
      if (drafts.length) conversation.releaseDraftAttachments(drafts);
      throw error;
    }
  }

  function ImportDialog({ controller, request, conversation }) {
    const { context } = request;
    const [tab, setTab] = React.useState('upload'), [file, setFile] = React.useState(null), [sourceId, setSourceId] = React.useState(''), [localPath, setLocalPath] = React.useState('');
    const [count, setCount] = React.useState(12), [start, setStart] = React.useState(''), [end, setEnd] = React.useState(''), [stamps, setStamps] = React.useState(''), [question, setQuestion] = React.useState('');
    const [data, setData] = React.useState(null), [error, setError] = React.useState(''), [loading, setLoading] = React.useState(true);
    const dialog = React.useRef(null);
    React.useEffect(() => {
      const cancel = new AbortController();
      api(context.sessionId, { signal: AbortSignal.any([cancel.signal, context.signal]) }).then(value => { setData(value); setCount(value.settings.frameCount); setLoading(false); }, cause => { if (!cancel.signal.aborted && !context.signal.aborted) { setError(cause.message); setLoading(false); } });
      return () => cancel.abort();
    }, [context]);
    React.useEffect(() => {
      const previous = document.activeElement;
      dialog.current?.querySelector('button')?.focus();
      return () => {
        if (previous?.isConnected && previous !== document.body && previous !== document.documentElement && previous.matches?.('button,input,textarea,select,a[href],[tabindex]:not([tabindex="-1"])')) previous.focus();
        else document.querySelector('[data-plugin-hub-pocket]')?.focus();
      };
    }, []);
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); controller.close(); }
      if (event.key === 'Tab') {
        const nodes = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')];
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const add = () => {
      try {
        const options = readOptions(count, start, end, stamps);
        let source;
        if (tab === 'upload') { if (!file) throw new Error('请先选择视频或 GIF。'); source = { kind: 'upload', file, name: file.name }; }
        if (tab === 'attachment') { if (!data?.files.some(f => f.attachmentId === sourceId)) throw new Error('请选择当前会话的原始文件附件。'); source = { kind: 'attachment', id: sourceId }; }
        if (tab === 'path') { const value = localPath.trim().replace(/^"(.*)"$/, '$1'); if (!EXTENSIONS.test(value)) throw new Error('请输入常见视频或 GIF 的本地路径。'); source = { kind: 'path', path: value }; }
        stageDraft(conversation, context, source, options, question);
        controller.close();
      } catch (cause) { setError(cause.message); }
    };
    const changeTab = value => { setTab(value); setError(''); };
    return createPortal(h('div', { className: 'dmr-root dmr-overlay', onKeyDown: key, onPointerDown: event => { if (event.target === event.currentTarget) controller.close(); } },
      h('section', { className: 'dmr-dialog', ref: dialog, role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dmr-title' },
        h('div', { className: 'dmr-head' }, h('div', null, h('h2', { id: 'dmr-title' }, '读取视频 / GIF'), h('p', { className: 'dmr-muted' }, '保留原始媒体，抽取带时间点的画面。')), h('button', { type: 'button', onClick: controller.close, 'aria-label': '关闭媒体导入' }, '关闭')),
        h('div', { className: 'dmr-tabs', 'aria-label': '媒体来源' }, [['upload','选择文件'],['attachment','聊天附件'],['path','本地路径']].map(([id,label]) => h('button', { type: 'button', key: id, 'aria-pressed': tab === id, onClick: () => changeTab(id) }, label))),
        h('div', { className: 'dmr-source' },
          tab === 'upload' ? h('label', null, '选择一个视频或原始 GIF（最多 512 MB）', h('input', { type: 'file', accept: ACCEPT, 'aria-label': '选择视频或GIF', onChange: event => { setFile(event.target.files?.[0] || null); setError(''); } }), file ? h('strong', { className: 'dmr-file-label' }, file.name) : null) : null,
          tab === 'attachment' ? loading ? '正在读取当前会话附件…' : data?.files.length ? h('label', { className: 'dmr-field' }, '选择当前会话的原始媒体附件', h('select', { value: sourceId, onChange: event => setSourceId(event.target.value), 'aria-label': '选择聊天媒体附件' }, h('option', { value: '' }, '请选择附件'), data.files.map(f => h('option', { key: f.attachmentId, value: f.attachmentId }, f.name)))) : h('p', { className: 'dmr-muted' }, '当前会话没有原始视频/GIF文件附件。普通图片上传的GIF可能只留下首帧，请改用“选择文件”重新导入。') : null,
          tab === 'path' ? field('本地文件路径', { value: localPath, onChange: event => setLocalPath(event.target.value), placeholder: '例如 D:\\视频\\演示.mp4' }) : null),
        h('div', { className: 'dmr-row' }, field('均匀抽帧数量', { type: 'number', min: 1, max: 24, value: count, onChange: event => setCount(event.target.value) }), field('指定时间点（秒，可选）', { value: stamps, onChange: event => setStamps(event.target.value), placeholder: '例如 0, 1.5, 3' })),
        h('div', { className: 'dmr-row' }, field('片段开始（秒，可选）', { type: 'number', min: 0, step: 'any', value: start, onChange: event => setStart(event.target.value), placeholder: '从头开始' }), field('片段结束（秒，可选）', { type: 'number', min: 0, step: 'any', value: end, onChange: event => setEnd(event.target.value), placeholder: '到媒体结尾' })),
        h('label', { className: 'dmr-field' }, '希望关注什么（可选）', h('textarea', { value: question, onChange: event => setQuestion(event.target.value), placeholder: '例如：找出按钮出现的时间，并说明操作过程。' })),
        h('p', { className: 'dmr-muted' }, '指定时间点会替代均匀抽样。只读取画面，不转写声音；实际画面时间由解码器核验。'),
        data?.model && !data.model.imageCapable ? h('p', { className: 'dmr-check' }, data.model.message) : null,
        error ? h('div', { className: 'dmr-error', role: 'alert' }, error) : null,
        h('p', { className: 'dmr-muted' }, '加入草稿后，可检查或补充问题，再由你发送。原始附件仅存入DSH，抽出的画面交给当前看图模型。'),
        h('div', { className: 'dmr-actions' }, h('button', { type: 'button', onClick: controller.close }, '取消'), h('button', { type: 'button', className: 'dmr-primary', onClick: add, disabled: loading }, '加入聊天草稿')))), document.body);
  }
  function DialogLayer({ controller, conversation, sessionId }) {
    const request = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    return request && request.context.sessionId === sessionId ? h(ImportDialog, { key: sessionId, controller, conversation, request }) : null;
  }
  function SettingsPanel() {
    const [config, setConfig] = React.useState({ frameCount: 12, maxSide: 960 }), [ready, setReady] = React.useState(false), [saving, setSaving] = React.useState(false), [status, setStatus] = React.useState(''), [error, setError] = React.useState(''), [decoder, setDecoder] = React.useState(null);
    const alive = React.useRef(true);
    React.useEffect(() => {
      alive.current = true; const cancel = new AbortController();
      api(null, { signal: cancel.signal }).then(value => { setConfig(value.settings); setDecoder(value.decoderReady); setReady(true); }, cause => { if (!cancel.signal.aborted) setError(cause.message); });
      return () => { alive.current = false; cancel.abort(); };
    }, []);
    const save = async () => {
      setSaving(true); setError(''); setStatus('');
      try { const result = await api(null, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frameCount: Number(config.frameCount), maxSide: Number(config.maxSide) }) }); if (alive.current) { setConfig(result.settings); setStatus('已保存，下次读取生效。'); } }
      catch (cause) { if (alive.current) setError(cause.message); }
      finally { if (alive.current) setSaving(false); }
    };
    return h('section', { className: 'dmr-root dmr-settings' }, h('p', { className: 'dmr-muted' }, '从输入框的方框加号进入。使用当前会话的看图模型，无需额外配置模型账号。'),
      h('div', { className: 'dmr-check', role: 'status' }, decoder === null ? '正在检查抽帧组件…' : decoder ? '随包抽帧组件已就绪，可离线提取画面。' : '抽帧组件缺失，请重新安装完整插件包。'),
      field('默认均匀抽帧数量（1–24）', { type: 'number', min: 1, max: 24, disabled: !ready || saving, value: config.frameCount, onChange: event => setConfig({ ...config, frameCount: event.target.value }) }),
      h('label', { className: 'dmr-field' }, '画面最长边', h('select', { disabled: !ready || saving, value: config.maxSide, onChange: event => setConfig({ ...config, maxSide: event.target.value }) }, [[640,'640 像素 · 更省用量'],[960,'960 像素 · 默认'],[1280,'1280 像素 · 更多细节'],[1536,'1536 像素 · 细节优先']].map(([value,label]) => h('option', { key: value, value }, label)))),
      h('p', { className: 'dmr-muted' }, '实际数量和尺寸还会受DSH图片上限约束。单个原文件最多512 MB，时长最多24小时；每次最多24帧、24 MB画面。GIF读取一轮，并按实际帧延时取样。'),
      h('p', { className: 'dmr-muted' }, '抽样可能遗漏快速变化，可指定时间点或片段补抽。本插件不转写音频，也不会替你发送聊天。'),
      error ? h('div', { role: 'alert', className: 'dmr-error' }, error) : null, status ? h('p', { role: 'status' }, status) : null,
      h('button', { type: 'button', className: 'dmr-primary', disabled: !ready || saving, onClick: save }, saving ? '正在保存…' : '保存设置'));
  }
  function apply(ctx) {
    const controller = createController(), conversation = ctx.conversation;
    ctx.effect(() => { const tag = document.createElement('style'); tag.dataset.plugin = 'dsh-media-reader'; tag.textContent = CSS; document.head.appendChild(tag); return () => tag.remove(); });
    ctx.effect(() => ctx.pluginHub.registerAction({ id: 'media-reader:open', label: '视频 / GIF', description: '导入原始媒体并按时间抽帧读取', order: 10, enabled: context => !!context.sessionId && !!context.inputActions, async run(context) { context.closeMenu(); await controller.open(context); } }));
    ctx.effect(() => ctx.pluginHub.registerSettings({ id: 'media-reader', label: '视频 / GIF 读取', description: '抽帧数量、画面尺寸与组件状态', keywords: ['视频','gif','抽帧','读取','media','frame'], order: 30 }, SettingsPanel));
    ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'media-reader:dialog', order: -99, inject: () => ({ controller, conversation }) }, DialogLayer));
    ctx.effect(() => () => controller.close());
  }
  return { inject: ['pluginHub', 'conversation', 'slots'], apply, stageDraft, readOptions, makePrompt, createController, ImportDialog, SettingsPanel };
} });
