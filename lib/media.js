import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MAX_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_FRAMES = 24;
export const DEFAULTS = Object.freeze({ frameCount: 12, maxSide: 960 });
export const EXTENSIONS = /\.(mp4|m4v|mov|mkv|webm|avi|mpeg|mpg|ts|m2ts|wmv|flv|ogv|gif)$/i;
const FORMATS = 'mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,gif,flv,asf,ogg';
const BIN = fileURLToPath(new URL('../vendor/ffmpeg/bin/', import.meta.url));

export function normalizeSettings(value = {}) {
  const integer = (v, min, max, fallback) => Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  return { frameCount: integer(value.frameCount, 1, MAX_FRAMES, DEFAULTS.frameCount), maxSide: integer(value.maxSide, 320, 1536, DEFAULTS.maxSide) };
}

export function runBinary(executable, args, { signal, timeout = 60000, maxOutput = 4 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = [], stderr = '', bytes = 0, failure;
    const fail = error => { failure ||= error; child.kill(); };
    const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('操作已取消。'));
    const timer = setTimeout(() => fail(new Error('媒体处理超时；请缩短片段或减少抽帧数量。')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutput) fail(new Error('媒体索引过大，超过本次读取上限。')); else stdout.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-128 * 1024); });
    child.on('error', error => { failure = new Error('无法运行随包提供的抽帧组件：' + error.message); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error('媒体无法解码，可能损坏、受保护或格式不受支持。' + (stderr.match(/[^\r\n]+(?:Invalid|Error|error|failed)[^\r\n]*/)?.[0] || '')), { exitCode: code, diagnostic: stderr.slice(-4000) }));
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr });
    });
    if (signal?.aborted) abort();
  });
}

export function binaries(directory = BIN) {
  return { ffmpeg: path.join(directory, 'ffmpeg.exe'), ffprobe: path.join(directory, 'ffprobe.exe') };
}
const inputArgs = source => ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS, '-i', source];

export async function probeMedia(source, { signal, bin = binaries() } = {}) {
  const result = await runBinary(bin.ffprobe, ['-v', 'error', ...inputArgs(source), '-show_format', '-show_streams', '-of', 'json'], { signal, timeout: 30000 });
  const data = JSON.parse(result.stdout);
  const stream = data.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!stream) throw new Error('文件里没有可读取的视频画面。音频文件不属于本插件的读取范围。');
  if (!(stream.width > 0 && stream.height > 0) || stream.width * stream.height > 64e6 || Math.max(stream.width, stream.height) > 16384) throw new Error('媒体画面尺寸超出安全解码范围（最多 6400 万像素）。');
  const duration = Number(stream.duration ?? data.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86400) throw new Error('无法确定有效时长，或媒体超过 24 小时；请先截取较短的完整片段。');
  const info = { duration, width: stream.width, height: stream.height, streamIndex: stream.index, codec: stream.codec_name, startTime: Number(stream.start_time) || 0, gif: stream.codec_name === 'gif', format: data.format?.format_name || '' };
  if (info.gif) {
    const index = await runBinary(bin.ffprobe, ['-v', 'error', ...inputArgs(source), '-select_streams', String(info.streamIndex), '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time', '-of', 'json'], { signal, timeout: 30000, maxOutput: 4 * 1024 * 1024 });
    info.frameTimes = JSON.parse(index.stdout).frames.map(f => Number(f.best_effort_timestamp_time) - info.startTime).filter(t => Number.isFinite(t) && t >= 0);
    if (!info.frameTimes.length || info.frameTimes.length > 30000) throw new Error('GIF 帧索引为空或超过 30000 帧上限。');
  }
  return info;
}

export function planFrames(info, request = {}, settings = DEFAULTS, cap = MAX_FRAMES) {
  const limit = Math.max(1, Math.min(MAX_FRAMES, cap));
  const count = request.frame_count ?? settings.frameCount;
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) throw new Error('抽帧数量必须是 1–24 的整数。');
  const start = request.start_seconds ?? 0, end = request.end_seconds ?? info.duration;
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > info.duration + .001) throw new Error('片段起止时间无效；结束时间必须大于开始时间，且不能超过媒体时长。');
  let requested;
  if (request.timestamps_seconds !== undefined) {
    if (!Array.isArray(request.timestamps_seconds) || !request.timestamps_seconds.length || request.timestamps_seconds.length > MAX_FRAMES || !request.timestamps_seconds.every(t => Number.isFinite(t) && t >= start && t < end)) throw new Error('指定时间点须为 1–24 个有效秒数，并位于所选片段内（不包含结束点）。');
    if (request.timestamps_seconds.length > limit) throw new Error('指定时间点数量超过当前 DSH 的图片数量限制，请拆分读取。');
    requested = [...new Set(request.timestamps_seconds)].sort((a, b) => a - b);
  } else {
    const n = Math.min(count, limit);
    requested = Array.from({ length: n }, (_, i) => start + (end - start) * (i + .5) / n);
  }
  const frames = requested.map(time => {
    // A GIF frame is held until its next presentation time, including unequal delays.
    const seek = info.gif ? info.frameTimes.reduce((v, t) => t <= time + .000001 ? t : v, 0) : time;
    return { requested: time, seek };
  });
  return { frames, start, end, capped: !request.timestamps_seconds && count > limit };
}

export function parseFrameTime(stderr, startTime = 0) {
  const value = /\bn:\s*0\s+pts:\s*[^\s]+\s+pts_time:\s*([-+\deE.]+)/.exec(stderr)?.[1];
  const time = Number(value);
  if (value === undefined || !Number.isFinite(time)) throw new Error('解码器没有返回可核验的画面时间点。');
  return Math.max(0, time - startTime);
}

export async function extractFrames(source, info, plan, directory, { signal, bin = binaries(), maxSide = 960, maxImageBytes = 2 * 1024 * 1024, maxTotalBytes = 24 * 1024 * 1024 } = {}) {
  const frames = [], seen = new Set();
  let totalBytes = 0;
  for (const target of plan.frames) {
    signal?.throwIfAborted();
    let actualSeek = target.seek;
    if (!info.gif) {
      // Seek to the preceding keyframe, index through the requested instant,
      // then choose the displayed frame. This also covers long-held VFR frames.
      const window = await runBinary(bin.ffprobe, ['-v', 'error', '-read_intervals', `${(target.seek + info.startTime).toFixed(6)}%${(Math.min(info.duration, target.seek + 1) + info.startTime).toFixed(6)}`, ...inputArgs(source), '-select_streams', String(info.streamIndex), '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json'], { signal, timeout: 30000, maxOutput: 2 * 1024 * 1024 });
      const times = JSON.parse(window.stdout).frames.map(f => Number(f.best_effort_timestamp_time) - info.startTime).filter(Number.isFinite).sort((a,b) => a-b);
      if (!times.length) throw new Error('指定时间附近没有可索引画面。');
      actualSeek = times.filter(t => t <= target.requested + .000001).at(-1) ?? times[0];
    }
    let frame;
    for (let attempt = 0; attempt < 4; attempt++) {
      const side = Math.max(160, Math.floor(maxSide / (1.45 ** attempt)));
      const filename = path.join(directory, `frame-${frames.length}-${attempt}.png`);
      // copyts preserves the decoded frame PTS. Input seeking is used only for
      // videos; GIF always decodes from its start so disposal/composition is correct.
      const seek = info.gif ? [] : ['-ss', Math.max(0, actualSeek - .00001).toFixed(6)];
      const select = info.gif ? `select='gte(t,${target.seek.toFixed(6)})',` : '';
      const filter = `${select}showinfo,scale=w='min(${side},iw)':h='min(${side},ih)':force_original_aspect_ratio=decrease,setsar=1,format=rgba`;
      const args = ['-hide_banner', '-nostdin', '-y', '-threads', '2', '-max_pixels', '64000000', '-copyts', ...seek, ...(info.gif ? ['-ignore_loop', '1'] : []), ...inputArgs(source), '-map', `0:${info.streamIndex}`, '-an', '-sn', '-dn', '-vf', filter, '-frames:v', '1', '-fps_mode', 'passthrough', '-threads', '2', filename];
      const result = await runBinary(bin.ffmpeg, args, { signal });
      const exists = await fs.stat(filename).catch(() => undefined);
      if (!exists?.size) throw new Error('指定时间附近没有可解码画面；请选择更早的时间点。');
      const time = parseFrameTime(result.stderr, info.startTime);
      if (exists.size > maxImageBytes) { await fs.unlink(filename); continue; }
      frame = { filename, time, requested: target.requested, bytes: exists.size };
      break;
    }
    if (!frame) throw new Error('单帧图像超过当前 DSH 的图片大小限制；请降低画面尺寸。');
    const key = frame.time.toFixed(6);
    if (seen.has(key)) { await fs.unlink(frame.filename); continue; }
    if (totalBytes + frame.bytes > maxTotalBytes) throw new Error('抽帧结果超过本次图片总量限制；请减少帧数或降低画面尺寸。');
    seen.add(key); totalBytes += frame.bytes; frames.push(frame);
  }
  if (!frames.length) throw new Error('没有取得画面。');
  return frames.sort((a,b) => a.time - b.time);
}
