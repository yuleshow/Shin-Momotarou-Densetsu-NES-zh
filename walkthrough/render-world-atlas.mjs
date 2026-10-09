import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function renderWorldAtlas({ data, nativeFile, font, outputDirectory }) {
  const { catalog, points } = data.atlas;
  assert.equal(catalog.length, 87);
  const run = (args, binary = false) => {
    const result = spawnSync('magick', args, { encoding: binary ? undefined : 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return binary ? result.stdout : result.stdout.trim();
  };
  const dimensions = new Map();
  const measure = (value, size) => {
    const key = `${size}:${value}`;
    if (!dimensions.has(key)) dimensions.set(key, run(['-font', font, '-pointsize', String(size), `label:${value}`, '-format', '%w %h', 'info:']).split(' ').map(Number));
    return dimensions.get(key);
  };
  const collides = (first, second) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
  const files = [];
  const layouts = [];
  const layerNames = { surface: '地上', undersea: '海底', moon: '月上' };
  const grid = point => {
    const cellSize = point.layer === 'moon' ? 8 : 16;
    return `${String.fromCharCode(65 + Math.floor(point.x / cellSize))}${Math.floor(point.y / cellSize) + 1}`;
  };
  const reference = entry => {
    if (entry.index === 84) return '原野散佈各地';
    const references = points.filter(point => point.places.some(place => place.index === entry.index)).map(point => `${layerNames[point.layer]} ${grid(point)}`);
    if (references.length) return [...new Set(references)].join('、');
    if (entry.index >= 46 && entry.index <= 54) return '鬼島地下；由 46 鬼島進入';
    return { 59: '地名表收錄；獨立入口尚待核對', 60: '13 位仙人的共用預設名稱', 77: '可移動；無固定座標', 81: '神仙鄉東方海域；條件出現', 85: '見月上分圖', 86: '風暴村內事件入口' }[entry.index];
  };
  for (const layer of ['surface', 'undersea', 'moon']) {
    const main = layer === 'surface';
    const width = main ? 4400 : 3400;
    const height = 3020;
    const extent = layer === 'moon' ? 64 : 128;
    const scale = 2560 / extent;
    const origin = { x: 120, y: 230 };
    const mapSize = extent * scale;
    const bounds = { left: origin.x, top: origin.y, right: origin.x + mapSize, bottom: origin.y + mapSize };
    const args = ['-size', `${width}x${height}`, 'xc:#f7f9f8'];
    if (layer !== 'moon') args.push('(', nativeFile, '-filter', 'point', '-resize', '2000%', ')', '-geometry', `+${origin.x}+${origin.y}`, '-composite');
    else args.push('-fill', '#e6eceb', '-draw', `rectangle ${bounds.left},${bounds.top} ${bounds.right},${bounds.bottom}`);
    const boxes = [];
    const text = (value, left, top, size, color = '#243e43') => {
      const [textWidth, textHeight] = measure(value, size);
      assert.ok(left >= 0 && top >= 0 && left + textWidth <= width - 24 && top + textHeight <= height - 24, `Text outside atlas: ${value}`);
      args.push('(', '-background', 'none', '-font', font, '-fill', color, '-stroke', 'none', '-pointsize', String(size), `label:${value}`, ')', '-geometry', `+${Math.round(left)}+${Math.round(top)}`, '-composite');
      return { left, top, right: left + textWidth, bottom: top + textHeight };
    };
    const title = { surface: '新桃太郎傳說｜地上・海底・月上地名總圖', undersea: '新桃太郎傳說｜海底入口・地上投影', moon: '新桃太郎傳說｜月上入口座標圖' }[layer];
    text(title, 70, 32, 62);
    const subtitle = { surface: '七間麻雀旅館・13 位仙人・村里山洞直接標名 / 海底入口另註層級 / 月上見右側定位圖', undersea: '底圖為地上海岸線，定位點來自海底事件；不是海底地形或潛航路線圖', moon: '原生月上入口 X、Y 各除以 2；此圖是座標格線，不是月面地形圖' }[layer];
    text(subtitle, 74, 128, 31, '#54676c');
    for (let index = 0; index <= 8; index++) {
      const distance = index * mapSize / 8;
      args.push('-stroke', layer === 'moon' ? '#a4b7b5' : '#ffffff66', '-strokewidth', '1', '-draw', `line ${origin.x + distance},${origin.y} ${origin.x + distance},${bounds.bottom} line ${origin.x},${origin.y + distance} ${bounds.right},${origin.y + distance}`);
      if (index < 8) {
        text(String.fromCharCode(65 + index), origin.x + distance + 145, 185, 28);
        text(String(index + 1), 63, origin.y + distance + 142, 28);
      }
    }
    const groups = new Map();
    for (const point of points.filter(candidate => (candidate.layer === layer || (main && candidate.layer === 'undersea')) && candidate.placeIndex !== 84)) {
      const key = `${point.layer}:${point.x}:${point.y}`;
      if (!groups.has(key)) {
        const places = [...point.places];
        if (point.placeIndex === 45) for (let placeIndex = 46; placeIndex <= 54; placeIndex++) places.push({ index: placeIndex });
        if (point.placeIndex === 44) places.push({ index: 86 });
        groups.set(key, { ...point, places });
      }
      else for (const place of point.places) if (!groups.get(key).places.some(existing => existing.index === place.index)) groups.get(key).places.push(place);
    }
    const groupList = [...groups.values()].sort((first, second) => first.y - second.y || first.x - second.x);
    const pointBoxes = groupList.map(point => ({ left: origin.x + point.x * scale - 8, top: origin.y + point.y * scale - 8, right: origin.x + point.x * scale + 8, bottom: origin.y + point.y * scale + 8 }));
    const labels = [];
    const leaders = [];
    for (const [index, point] of groupList.entries()) {
      const left = origin.x + point.x * scale;
      const top = origin.y + point.y * scale;
      const prefix = main && point.layer === 'undersea' ? '【海底入口投影】\n'
        : point.note?.startsWith('地下水路') ? '鬼之爪痕・地下水路入口\n'
          : point.note?.startsWith('天樹入口') ? '天樹入口\n' : '';
      const value = prefix + (point.places.length ? point.places.map(place => `${String(place.index + 1).padStart(2, '0')} ${catalog[place.index].name}${place.index !== point.placeIndex ? '（內）' : ''}`).join('\n') : point.name);
      const [labelWidth, labelHeight] = measure(value, 27);
      const color = point.places.some(place => place.index >= 64 && place.index <= 76) ? '#67412a' : point.name?.startsWith('麻雀旅館') ? '#903f36' : '#174963';
      const candidates = [];
      for (const distance of [18, 42, 70, 110, 160, 230, 310, 420]) {
        for (const [offsetX, offsetY] of [[distance, -labelHeight / 2], [-labelWidth - distance, -labelHeight / 2], [-labelWidth / 2, distance], [-labelWidth / 2, -labelHeight - distance], [distance, distance], [-labelWidth - distance, -labelHeight - distance]]) {
          const box = { left: Math.round(left + offsetX - 6), top: Math.round(top + offsetY - 3), right: Math.round(left + offsetX + labelWidth + 6), bottom: Math.round(top + offsetY + labelHeight + 3) };
          const endX = Math.max(box.left, Math.min(left, box.right));
          const endY = Math.max(box.top, Math.min(top, box.bottom));
          const leader = { left: Math.min(left, endX) - 1, top: Math.min(top, endY) - 1, right: Math.max(left, endX) + 1, bottom: Math.max(top, endY) + 1 };
          if (box.left >= bounds.left + 5 && box.right <= bounds.right - 5 && box.top >= bounds.top + 5 && box.bottom <= bounds.bottom - 5
            && ![...boxes, ...pointBoxes, ...leaders].some(other => collides(box, other))
            && ![...boxes, ...pointBoxes.filter((_, pointIndex) => pointIndex !== index)].some(other => collides(leader, other))) candidates.push({ box, leader, endX, endY });
        }
      }
      assert.ok(candidates.length, `No room for ${value}`);
      const { box, leader, endX, endY } = candidates[0];
      boxes.push(box);
      leaders.push(leader);
      args.push('-stroke', '#ffffff', '-strokewidth', '5', '-draw', `line ${left},${top} ${endX},${endY}`, '-stroke', color, '-strokewidth', '2', '-draw', `line ${left},${top} ${endX},${endY}`);
      labels.push({ box, value, color, point, index });
    }
    for (const { box, value, color } of labels) {
      args.push('-fill', '#f7f9f8f4', '-stroke', color, '-strokewidth', '1', '-draw', `rectangle ${box.left},${box.top} ${box.right},${box.bottom}`);
      text(value, box.left + 6, box.top + 3, 27, color);
    }
    for (const { point, color } of labels) {
      const left = origin.x + point.x * scale;
      const top = origin.y + point.y * scale;
      args.push('-fill', color, '-stroke', '#ffffff', '-strokewidth', '2', '-draw', `circle ${left},${top} ${left + 7},${top}`);
    }
    const legend = main ? [] : catalog.filter(entry => points.some(point => point.layer === layer && point.places.some(place => place.index === entry.index)) || (layer === 'moon' && [85, 86].includes(entry.index)));
    text(main ? '86 月亮 / 月上入口定位圖' : `${layerNames[layer]}地名索引`, 2760, 220, 38);
    if (main) {
      text('獨立座標系；不是地上海域，也不是月面地形。', 2760, 280, 27);
      text('村落、月之祠、各洞口與臥龍洞窟直接標在右圖。', 2760, 325, 27);
      text('不能當作固定入口的地名', 2760, 2150, 36);
      text('60 海之庵：獨立入口尚未確認，未猜填座標。\n61 仙人庵：共用預設名，13 位仙人已分別標在主圖。\n78 玩家的城：可移動，沒有固定地點。\n82 漂泊之島：神仙鄉東方海域，條件出現；確切點待核對。\n85 原野：地上與月上的區域共用名稱。', 2760, 2230, 27);
      text('鬼島旁各層名稱表示由鬼島進入，\n不是各層在地表的座標或迷宮平面圖。\n海底標記表示下潛入口投影，不能從地上直接走入。', 2760, 2530, 27);
    }
    for (const [index, entry] of legend.entries()) {
      const column = main ? Math.floor(index / 44) : 0;
      const row = main ? index % 44 : index;
      const left = 2760 + column * 810;
      const top = 300 + row * 57;
      text(`${String(entry.index + 1).padStart(2, '0')}  ${entry.name}`, left, top, 29);
      text(reference(entry), left + 47, top + 34, 18, '#576c70');
    }
    if (!main) {
      const top = 300 + legend.length * 57 + 50;
      text(layer === 'moon' ? '同名洞窟保留不同入口。\n臥龍洞窟由風暴村內進入。\n格位與地上圖分開使用。' : '奈落洞窟：先進海底裂縫。\n海底洞窟：勇氣之鎧所在地。\n位置相同不代表陸上可進入。', 2760, top, 26);
    }
    text('（內）表示經所屬村莊或山洞進入，不是另一個野外落點；同名多入口分別保留。', 74, 2830, 29);
    text('地獄各層在鬼島地下；漂泊之島是條件地點；玩家的城可移動。完整路徑與證據見地名索引。', 74, 2880, 29);
    text('來源：v65 原生事件座標、地名指令、仙人參數表；地上地形為原生月之鏡背景。', 74, 2930, 25, '#54676c');
    const filename = path.join(outputDirectory, layer === 'surface' ? 'world-map-zh-Hant.png' : `world-map-${layer}-zh-Hant.png`);
    run([...args, filename]);
    assert.equal(run([filename, '-format', '%wx%h', 'info:']), `${width}x${height}`);
    for (const [index, box] of boxes.entries()) assert.ok(!boxes.slice(index + 1).some(other => collides(box, other)));
    files.push(filename);
    layouts.push({ layer, width, height, points: groupList.length, placeIndexes: [...new Set(groupList.flatMap(point => point.places.map(place => place.index)))], labels: labels.map(({ value, point }) => ({ text: value, layer: point.layer, x: point.x, y: point.y, placeIndexes: point.places.map(place => place.index) })), labelBoxes: boxes, textOverlap: false });
  }
  const inset = { left: 2760, top: 430, width: 1600, height: 1600 };
  const combined = path.join(outputDirectory, 'world-map-combined.tmp.png');
  const insetArgs = [files[2], '-crop', '2680x2790+0+0', '+repage', '-resize', `${inset.width}x${inset.height}`];
  const [insetWidth, insetHeight] = run([...insetArgs, '-format', '%w %h', 'info:']).split(' ').map(Number);
  run([files[0], '(', ...insetArgs, ')', '-geometry', `+${inset.left}+${inset.top}`, '-composite', combined]);
  assert.ok(run([combined, '-crop', `${insetWidth}x${insetHeight}+${inset.left}+${inset.top}`, '+repage', '-depth', '8', 'rgb:-'], true).equals(run([...insetArgs, '-depth', '8', 'rgb:-'], true)), 'Moon inset RGB pixels differ from resized source');
  fs.renameSync(combined, files[0]);
  layouts[0].inset = { ...inset, width: insetWidth, height: insetHeight, sourceLayer: 'moon', placeIndexes: layouts[2].placeIndexes, pixelsMatch: true };
  const located = new Set([...layouts[0].placeIndexes, ...layouts[2].placeIndexes]);
  const notFixed = [59, 60, 77, 81, 84, 85];
  assert.deepEqual(catalog.filter(entry => !located.has(entry.index)).map(entry => entry.index), notFixed);
  return { files, layouts, catalogNames: catalog.length, hermits: 13, inns: 7 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(fs.readFileSync(path.join(directory, 'world-map-locations.json'), 'utf8'));
  const result = renderWorldAtlas({ data, nativeFile: path.join(directory, 'images/world-map-native.png'), font: process.argv[2], outputDirectory: path.join(directory, 'images') });
  console.log(JSON.stringify(result.layouts.map(({ layer, points, placeIndexes }) => ({ layer, points, names: placeIndexes.length }))));
}