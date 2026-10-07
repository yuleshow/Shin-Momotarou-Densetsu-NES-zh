import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const font = process.argv[2];
assert.ok(font && fs.existsSync(font), 'Supply a Traditional Chinese font file');
const index = fs.readFileSync(path.join(root, 'opening-preview-v37/place-names.md'), 'utf8');
const names = new Map([...index.split('## 飛燕目的地')[0].matchAll(/^\| (\d+) \| (.+) \|$/gm)].map(match => [Number(match[1]), match[2]]));
names.set(0, '桃太郎的老家');
const panels = [
  { title: '01  花木地區', color: '#22734b', rows: [
    [[11, '通往花咲村'], [65, '松葉山頂'], [15, '花咲村北方']],
    [[4, '滾飯糰洞北方'], [14, '松葉山出口東南'], [12, '花咲村事件']],
    [[2, '供奉飯糰後進入'], [69, '一號店東南'], [3, '洞窟事件後形成']],
    [[0, '啟程村西北'], [64, '啟程村北方'], [1, '冒險起點']],
  ], links: [[0, 4], [4, 2], [6, 3], [9, 11]], note: '主線：啟程村 → 滾飯糰洞 → 松葉山\n再經花咲村，前往無聲洞窟。' },
  { title: '02  冬雪與星辰地區', color: '#226e91', rows: [
    [[25, '浮游仙人庵北方'], [24, '寢太郎村西北'], [22, '大江山出口東北']],
    [[72, '大太郎庵西南'], [6, '大江山頂'], [21, '需要隊員與月之鏡']],
    [[68, '金太郎村北方'], [5, '避鬼仙人庵南方'], [70, '二號店東北']],
    [[13, '金太郎村西方'], [67, '金太郎村北方'], [71, '二號店南方']],
    [[17, '無聲洞窟出口北方'], [16, '村內神社後方入口'], [18, '避魔仙人庵南方']],
  ], links: [[3, 0], [2, 1], [7, 5], [12, 13]], note: '目前建議：先回金太郎村，從神社後方進足柄山救出金太郎。' },
  { title: '03  微笑與希望地區', color: '#8d4564', rows: [
    [[30, '伸長怪森林北方'], [7, '風神谷東方'], [26, '寢太郎村東南']],
    [[28, '眾神之里西南'], [31, '四號店南方'], [73, '微笑村內']],
    [[29, '希望之都北方'], [32, '伏龍洞窟南方'], [80, '微笑村附近；方位待核']],
    [[27, '微笑區南橋的東北'], [8, '雷神洞窟出口西南'], [74, '五號店北方']],
    [[78, '希望之都事件'], [61, '鬼之爪痕南方'], [34, '新村東南']],
  ], links: [[3, 0], [1, 4], [4, 7], [6, 9], [9, 12], [13, 14]], note: '這是相鄰地點與主線的參考圖；連線不代表可直線穿越地形。' },
  { title: '04  南方與勇氣地區', color: '#a24b36', rows: [
    [[37, '金瘡仙人庵北方'], [36, '鬼族牢獄出口西方'], [35, '鬼族牢獄出口南方']],
    [[75, '猴蟹村西南'], [39, '竹取村西北'], [10, '奈落南出口以北']],
    [[38, '七號店西方'], [62, '由深海通往南方'], [45, '後期主線目的地']],
  ], links: [[3, 0], [1, 3], [6, 4], [7, 5]], note: '猴蟹村取得船後展開海上探索；奈落洞窟南出口通往竹林地區。' },
  { title: '05  海上、島嶼與海底', color: '#237e83', rows: [
    [[9, '猴蟹村北方島嶼'], [40, '花咲村東北島嶼'], [56, '寢太郎村東北島嶼']],
    [[76, '鬼族牢獄東方列島'], [57, '仙人庵南島；天樹種子'], [81, '神仙鄉東方；事件後']],
    [[20, '浦島村海邊乘龜'], [33, '兵具屋島附近海底'], [63, '啟程村西方海底']],
    [[83, '鬼之爪痕地下水路'], [62, '鬼島東北海底裂縫'], [19, '浦島村泉水後方入口']],
  ], links: [[3, 4], [2, 5]], note: '海上與海底分層列示；島嶼與入口的精確格子未在此圖標定。' },
  { title: '06  月亮與最終區域', color: '#65528c', rows: [
    [[41, '龍宮城傳送後；祠西北'], [55, '各傳送入口'], [58, '牢獄傳送後；祠西方']],
    [[43, '月之洞窟出口西方'], [79, '風暴村西方'], [44, '黃泉塔傳送後；祠西南']],
    [[42, '月上村莊；座標待核'], [46, '鬼島後的地獄區域'], [54, '最終區域']],
  ], links: [[5, 4], [4, 3]], note: '月之祠有不同事件入口，不能把各次傳送視為同一座標。' },
];
const width = 3000;
const height = 2380;
const args = ['-size', `${width}x${height}`, 'xc:#f5f8fa', '-font', font, '-encoding', 'UTF-8'];
const text = (value, left, top, size, color = '#20323a') => args.push('-fill', color, '-stroke', 'none', '-pointsize', String(size), '-gravity', 'NorthWest', '-annotate', `+${left}+${top}`, value);
const draw = (fill, stroke, strokeWidth, shape) => args.push('-fill', fill, '-stroke', stroke, '-strokewidth', String(strokeWidth), '-draw', shape);
text('新桃太郎傳說  世界地名參考圖', 65, 35, 62);
text('繁體中文地名  /  區域示意・不按比例・非遊戲逐格地圖', 68, 123, 31, '#52636c');
text('地點按區域分組；每個名稱下方標示可核對的入口或相對方位。沒有標記未確認的玩家位置。', 68, 178, 25, '#52636c');
const rectangles = [];
const locationIds = new Set();
for (const [panelIndex, panel] of panels.entries()) {
  const left = 45 + (panelIndex % 3) * 980;
  const top = 265 + Math.floor(panelIndex / 3) * 950;
  const points = panel.rows.flat().map((entry, entryIndex) => ({ entry, left: left + 20 + (entryIndex % 3) * 308, top: top + 85 + Math.floor(entryIndex / 3) * 146 }));
  draw(panel.color, 'none', 0, `rectangle ${left},${top} ${left + 940},${top + 5}`);
  text(panel.title, left + 18, top + 19, 36, panel.color);
  for (const [from, to] of panel.links) {
    const start = points[from];
    const end = points[to];
    assert.ok(start && end);
    draw('none', '#b9c9cf', 4, `line ${start.left + 142},${start.top + 52} ${end.left + 142},${end.top + 52}`);
  }
  for (const point of points) {
    const [locationId, hint] = point.entry;
    const name = names.get(locationId);
    assert.ok(name, `Unknown location ${locationId}`);
    locationIds.add(locationId);
    const highlighted = locationId === 17 || locationId === 16;
    const bounds = { left: point.left, top: point.top, right: point.left + 286, bottom: point.top + 112 };
    rectangles.push(bounds);
    assert.ok(name.length * 27 <= 266, `Name too wide: ${name}`);
    assert.ok(hint.length * 18 <= 268, `Hint too wide: ${hint}`);
    draw(highlighted ? '#fff0dc' : '#ffffff', highlighted ? '#ba6722' : '#d1dce1', highlighted ? 3 : 1, `roundrectangle ${bounds.left},${bounds.top} ${bounds.right},${bounds.bottom} 5,5`);
    draw(panel.color, 'none', 0, `circle ${point.left + 17},${point.top + 27} ${point.left + 22},${point.top + 27}`);
    text(name, point.left + 32, point.top + 9, name.length > 8 ? 25 : 27);
    text(hint, point.left + 12, point.top + 67, 18, '#52636c');
  }
  const noteLines = panel.note.split('\n').flatMap(line => line.match(/.{1,31}/gu) ?? []);
  for (const [lineIndex, line] of noteLines.entries()) text(line, left + 20, top + 844 + lineIndex * 31, 23, panel.color);
}
for (const [rectangleIndex, rectangle] of rectangles.entries()) {
  assert.ok(rectangle.left >= 0 && rectangle.right < width && rectangle.bottom < height);
  for (const other of rectangles.slice(rectangleIndex + 1)) assert.ok(rectangle.right <= other.left || other.right <= rectangle.left || rectangle.bottom <= other.top || other.bottom <= rectangle.top, 'Overlapping labels');
}
draw('#e4edf1', 'none', 0, 'rectangle 45,2195 2940,2335');
text('橙框：目前建議目的地  金太郎村 → 足柄山     |     此圖包含後期地名，可能涉及劇透。', 70, 2214, 29);
text('地名：本專案 v37 索引   位置依據：onibaka.donburako.com 攻略 1–6；tvgamedb.com 攻略 2–3。', 70, 2266, 24);
text('原創整理示意；未重製攻略網站圖片。完整來源、限制與未定位名稱見 maps/world-map-notes.md。', 70, 2303, 21, '#52636c');
const output = path.join(root, 'maps/world-map-zh-Hant.png');
args.push(output);
const result = spawnSync('magick', args, { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
assert.ok(fs.statSync(output).size > 50000);
console.log(JSON.stringify({ output, width, height, labels: rectangles.length, distinctLocations: locationIds.size, schematic: true, labelBoundsChecked: true }, null, 2));