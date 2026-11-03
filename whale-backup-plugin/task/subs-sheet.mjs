// 字幕带切片：把「烧在画面里」的字幕，按固定间隔烘成可读的长图。
//
// 为什么要有它：番剧大多是硬字幕，B 站没有字幕轨；video_read 的 OCR 认中文
// 会认成「把亻尔给开除了丬」，所以我改成「裁字幕带 → 拼图 → 我自己看」。
// 10 秒一帧会漏八成（一行字幕只活 2–3 秒），4 秒一帧才勉强够。
//
// 用法：
//   node task/subs-sheet.mjs <视频> --interval 4 --from 0 --to 300 --out <目录>
//   输出 sheet-000.jpg / sheet-001.jpg …，每张 4 列 × 6 行 = 24 帧。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const input = argv[0];
if (!input) {
  console.error('usage: node task/subs-sheet.mjs <video> [--interval 4] [--from 0] [--to 300] [--out dir]');
  process.exit(2);
}
const opt = {};
for (let i = 1; i < argv.length; i++) {
  const k = argv[i];
  if (k.startsWith('--')) opt[k.slice(2)] = argv[++i];
}
const interval = Number(opt.interval ?? 4);
const from = Number(opt.from ?? 0);
const to = opt.to === undefined ? null : Number(opt.to);
const outDir = opt.out ?? path.join(path.dirname(input), 'subs-sheets');
fs.mkdirSync(outDir, { recursive: true });

const FF = process.env.DSH_FFMPEG_PATH || 'ffmpeg';
const SHEET_SECONDS = interval * 24; // 4 列 × 6 行
const total = to === null ? null : to - from;
const count = total === null ? 1 : Math.ceil(total / SHEET_SECONDS);

console.log(`video=${input}`);
console.log(`interval=${interval}s  sheet=${SHEET_SECONDS / 60}min  sheets=${count}`);
for (let i = 0; i < count; i++) {
  const ss = from + i * SHEET_SECONDS;
  const dur = total === null ? SHEET_SECONDS : Math.min(SHEET_SECONDS, total - i * SHEET_SECONDS);
  const file = path.join(outDir, `sheet-${String(i).padStart(3, '0')}.jpg`);
  execFileSync(FF, [
    '-hide_banner', '-loglevel', 'error',
    '-ss', String(ss), '-t', String(dur), '-i', input,
    '-vf', `fps=1/${interval},crop=iw:120:0:ih-140,scale=iw*1.5:-1,tile=4x6`,
    '-frames:v', '1', '-q:v', '3', file, '-y',
  ]);
  console.log(`${file}  ${ss}s–${ss + dur}s`);
}
