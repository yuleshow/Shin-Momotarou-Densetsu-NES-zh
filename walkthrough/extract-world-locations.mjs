import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rom = fs.readFileSync(process.argv[2]);
assert.equal(createHash('sha256').update(rom).digest('hex'), '6a726fb79df36a21b46a1eeec33409930ec282d110c312e4025e5538af25d470');
const entries = [];
for (let offset = 0x681c9; rom[offset] !== 0; offset += 3) {
  assert.ok(offset < 0x6821e);
  const pointer = 0x60000 + rom.readUInt16LE(offset + 1);
  entries.push({ scene: rom[offset], pointer: `0x${pointer.toString(16)}`, bytes: [...rom.subarray(pointer, pointer + 7)] });
}
assert.deepEqual(entries.find(entry => entry.scene === 0x50).bytes, [0x4c, 54, 237, 2, 0, 0x50, 2]);
const directory = path.dirname(fileURLToPath(import.meta.url));
const names = fs.readFileSync(path.join(directory, '../opening-preview-v37/place-names.md'), 'utf8');
const travelNames = [...names.split('## 飛燕目的地')[1].matchAll(/^\| (\d+) \| (.+?) \| (\d+) \|$/gm)];
assert.equal(travelNames.length, 26);
const locations = travelNames.flatMap(([, index, name, placeIndex]) => {
  const scene = rom[0x59568 + Number(index)];
  const entry = entries.find(candidate => candidate.scene === scene);
  assert.ok(entry, `Missing scene ${scene}`);
  if (entry.bytes[0] !== 0x4c) return [];
  const [world, worldX, worldY] = entry.bytes;
  return [{
    id: Number(index), name, placeIndex: Number(placeIndex), scene, world,
    worldX, worldY, x: Math.floor(worldX / 2), y: Math.floor(worldY / 2),
    pointer: entry.pointer, evidence: 'native-flight-return-coordinate',
    note: scene === 0x78 ? '地下村莊的地面對應位置' : scene === 0x5c ? '大江山內旅館的地面對應位置' : '村外／入口附近',
  }];
});
assert.equal(locations.length, 20);
for (const location of locations) assert.ok(location.x >= 0 && location.x < 128 && location.y >= 0 && location.y < 128);
const dataset = {
  romSha256: createHash('sha256').update(rom).digest('hex'),
  namesSource: '../opening-preview-v37/place-names.md',
  travelSceneTable: '0x59568', coordinateIndex: '0x681c9',
  coordinateReader: 'CPU 86:8163; world coordinates stored at 0x1573/0x157d',
  precision: 'Native flight return positions projected to 128x128 overview; not building-door pixels',
  excluded: travelNames.filter(([, index]) => !locations.some(location => location.id === Number(index))).map(([, index, name]) => ({ id: Number(index), name })),
  locations,
};
const placeNames = [...names.split('## 飛燕目的地')[0].matchAll(/^\| (\d+) \| (.+) \|$/gm)].map(match => match[2].replace('[02a0]', '桃太郎').replace('[09]城', '玩家的城'));
assert.equal(placeNames.length, 87);
function sceneEvents(scene) {
  const root = rom.readUIntLE(0xac000 + scene * 3, 3) - 0xc00000;
  assert.ok(root >= 0xb0000 && root < 0xe0000);
  const bank = root & 0xff0000;
  const lists = [];
  for (let offset = root; rom.readUInt16LE(offset); offset += 2) {
    assert.ok(offset < root + 2048);
    lists.push(bank + rom.readUInt16LE(offset));
  }
  const handlers = [];
  for (const [object, list] of lists.entries()) {
    for (let offset = list; rom[offset]; offset += 3) {
      assert.ok(offset < list + 768);
      handlers.push({ object, event: rom[offset], pointer: bank + rom.readUInt16LE(offset + 1) });
    }
  }
  const boundaries = [...new Set([...lists, ...handlers.map(handler => handler.pointer)])].sort((first, second) => first - second);
  return handlers.map(handler => ({ ...handler, bytes: rom.subarray(handler.pointer, boundaries.find(pointer => pointer > handler.pointer) ?? handler.pointer + 128) }));
}
const sceneNames = new Map();
for (let scene = 0x4c; scene <= 0xee; scene++) {
  for (const handler of sceneEvents(scene).filter(candidate => candidate.object === 0 && [1, 2].includes(candidate.event)).sort((first, second) => second.event - first.event)) {
    for (let offset = 0; offset < handler.bytes.length - 2; offset++) {
      if (handler.bytes[offset] === 0x2b && handler.bytes[offset + 1] < placeNames.length && [0x64, 0x41, 0x6c, 0x74, 0xb0, 0xcf].includes(handler.bytes[offset + 2])) {
        sceneNames.set(scene, { placeIndex: handler.bytes[offset + 1], namePointer: `0x${(handler.pointer + offset).toString(16)}` });
        break;
      }
    }
    if (sceneNames.has(scene)) break;
  }
}
const sharedScenes = new Map([
  [0x98, [15, '無聲洞窟另一側入口']],
  [0xa8, [21, '大江山另一側入口']],
  [0xb0, [32, '雷神洞窟另一側入口']],
  [0x77, [83, '地下水路入口，通往機關村']],
  [0xb6, [34, '鬼族牢獄另一側入口']],
  [0x90, [57, '天樹入口，通往七夕村']],
  [0xe3, [62, '海底裂縫，向下通往奈落洞窟']],
]);
for (const [scene, [placeIndex, note]] of sharedScenes) {
  if (!sceneNames.has(scene)) sceneNames.set(scene, { placeIndex, note, namePointer: null });
}
for (const location of locations) {
  if (sceneNames.has(location.scene)) assert.equal(sceneNames.get(location.scene).placeIndex, location.placeIndex);
}
assert.deepEqual([...rom.subarray(0x4c38a, 0x4c397)], Array.from({ length: 13 }, (_, index) => index + 64));
const entrances = [];
for (const [world, layer] of [[0x4c, 'surface'], [0xdf, 'undersea'], [0xcf, 'moon']]) {
  for (const handler of sceneEvents(world).filter(candidate => [0x77, 0x79].includes(candidate.event))) {
    const bytes = handler.bytes;
    for (let offset = 0; offset < bytes.length - 7; offset++) {
      const opcode = bytes[offset];
      if (![0x69, 0x5d].includes(opcode)) continue;
      const size = opcode === 0x69 ? 3 : 5;
      const conditionEnd = offset + size;
      if (![0xb3, 0xa3].includes(bytes[conditionEnd])) continue;
      let end = bytes.indexOf(0xb0, conditionEnd);
      while (end >= 0 && bytes[end - 1] === 0x53) end = bytes.indexOf(0xb0, end + 1);
      if (end < 0) end = Math.min(bytes.length, conditionEnd + 40);
      end = Math.min(end, conditionEnd + 40);
      let hermit = null;
      for (let cursor = conditionEnd; cursor < end - 2; cursor++) if (bytes[cursor] === 0x3d && bytes[cursor + 1] === 1) hermit = bytes[cursor + 2];
      for (let cursor = conditionEnd; cursor < end - 2; cursor++) {
        if (bytes[cursor] !== 0x53 || bytes[cursor + 1] < 0x4c || bytes[cursor + 1] > 0xee || bytes[cursor + 2] > 0x30) continue;
        if (!(bytes[cursor - 1] === 0xe0 || ([0x05, 0x07].includes(bytes[cursor - 1]) && [0xb2, 0xb3, 0xb4].includes(bytes[cursor - 2])))) continue;
        const scene = bytes[cursor + 1];
        const direct = sceneNames.get(scene);
        const placeIndex = hermit && [0x54, 0x58, 0x67].includes(scene) ? hermit + 63 : direct?.placeIndex ?? null;
        const bounds = { left: bytes[offset + 1], top: bytes[offset + 2], right: bytes[offset + (opcode === 0x69 ? 1 : 3)], bottom: bytes[offset + (opcode === 0x69 ? 2 : 4)] };
        assert.ok(bounds.left <= bounds.right && bounds.top <= bounds.bottom);
        entrances.push({ layer, world, scene, entry: bytes[cursor + 2], placeIndex, name: placeIndex === null ? null : placeNames[placeIndex],
          worldX: bounds.left, worldY: bounds.top, x: Math.floor(bounds.left / 2), y: Math.floor(bounds.top / 2), bounds,
          pointer: `0x${(handler.pointer + offset).toString(16)}`, transitionPointer: `0x${(handler.pointer + cursor).toString(16)}`,
          namePointer: hermit ? `0x${(0x4c389 + hermit).toString(16)}` : direct?.namePointer ?? null, hermit,
          note: direct?.note ?? '原生世界入口',
        });
        break;
      }
    }
  }
}
assert.ok(entrances.some(entrance => entrance.placeIndex === 1 && entrance.worldX === 54 && entrance.worldY === 237));
const points = [...new Map(entrances.map(entrance => [[entrance.layer, entrance.scene, entrance.placeIndex, entrance.worldX, entrance.worldY].join(':'), entrance])).values()];
const knownPoints = points.filter(point => point.placeIndex !== null);
for (const point of knownPoints) point.places = [{ index: point.placeIndex, note: point.note }];
const via = [
  [3, 2, '經滾飯糰洞到飯糰村'], [6, 21, '大江山內的旅館'],
  [12, 14, '花咲村內的洞窟'], [13, 66, '鹿角之里與鹿角仙人同一入口'],
  [16, 17, '金太郎村神社後方'], [19, 18, '浦島村內泉水後方'],
  [23, 22, '寢太郎村內'], [65, 11, '松葉山內；仙人參數 2'],
  [73, 26, '微笑村內；仙人參數 10'], [78, 27, '希望之都內'],
];
for (const [index, parent, note] of via) {
  const parents = knownPoints.filter(point => point.placeIndex === parent && point.layer === 'surface');
  assert.ok(parents.length, `Missing parent ${parent}`);
  for (const point of parents) point.places.push({ index, note });
}
for (const point of points.filter(point => point.scene === 0xea)) {
  point.name = '海底洞窟（勇氣之鎧）';
  point.note = '海底入口；原生場景沒有獨立的87筆地名索引';
  point.places = [];
  knownPoints.push(point);
}
const exceptional = new Map([
  [46, '鬼島地下：三途川'], [47, '鬼島地下：黑繩地獄'],
  [48, '鬼島地下：血池地獄'], [49, '鬼島地下：眾合地獄'],
  [50, '鬼島地下：焦熱地獄'], [51, '鬼島地下：極寒地獄'],
  [52, '鬼島地下：大焦熱地獄'], [53, '鬼島地下：阿鼻地獄'],
  [54, '鬼島地下：伐折羅王之間'],
  [59, '地名表收錄；尚未辨識獨立入口，不與海之仙人庵混稱'],
  [60, '仙人庵共用場景的預設地名；13位仙人另按名稱標註'],
  [77, '玩家的城可移動，沒有固定世界座標'],
  [81, '神仙鄉東方海域；到過七夕村後出現，使用勇氣之鏡尋找；不假定固定落點'],
  [85, '月上世界整個區域；村莊、洞窟和月之祠見月上分圖'],
  [86, '經風暴村內事件進入；不是地面野外入口'],
]);
const catalog = placeNames.map((name, index) => ({
  index, name,
  representation: knownPoints.some(point => point.places.some(place => place.index === index)) ? 'mapped-entrance-or-parent' : 'region-or-special',
  note: exceptional.get(index) ?? null,
}));
for (const entry of catalog) assert.ok(entry.representation === 'mapped-entrance-or-parent' || entry.note, `Unaccounted place ${entry.index}:${entry.name}`);
for (const index of Array.from({ length: 13 }, (_, offset) => offset + 64)) assert.ok(knownPoints.some(point => point.places.some(place => place.index === index)), `Missing hermit ${index}`);
for (const index of Array.from({ length: 7 }, (_, offset) => offset + 4)) assert.ok(knownPoints.some(point => point.places.some(place => place.index === index)), `Missing inn ${index}`);
dataset.atlas = { catalog, sceneNames: Object.fromEntries(sceneNames), points: knownPoints, unclassifiedEntrances: points.filter(point => point.placeIndex === null && point.scene !== 0xea),
  sources: ['ROM native world entrance events and name opcode 0x2b', 'https://onibaka.donburako.com/kouryaku/momo_shin/chart_5.html', 'https://onibaka.donburako.com/kouryaku/momo_shin/chart_6.html'],
};
fs.writeFileSync(path.join(directory, 'world-map-locations.json'), `${JSON.stringify(dataset, null, 2)}\n`);
const layerNames = { surface: '地上', undersea: '海底', moon: '月上' };
const references = entry => {
  if (entry.index === 84) return { grid: '地上與月上各地', detail: '原野是共用區域名稱，未把全部原野小場景擠入總圖。' };
  const matches = knownPoints.filter(point => point.places.some(place => place.index === entry.index));
  const grid = [...new Set(matches.map(point => {
    const cellSize = point.layer === 'moon' ? 8 : 16;
    return `${layerNames[point.layer]} ${String.fromCharCode(65 + Math.floor(point.x / cellSize))}${Math.floor(point.y / cellSize) + 1}`;
  }))].join('、');
  const detail = [...new Set(matches.flatMap(point => point.places.filter(place => place.index === entry.index).map(place => place.note)))].join('；');
  return { grid: grid || '見說明', detail: detail || entry.note };
};
const table = entries => ['| 圖號 | 地名 | 格位／層級 | 入口與說明 |', '| --- | --- | --- | --- |', ...entries.map(entry => {
  const { grid, detail } = references(entry);
  return `| ${String(entry.index + 1).padStart(2, '0')} | ${entry.name} | ${grid} | ${detail} |`;
})].join('\n');
const indexText = [
  '# 完整地名索引',
  '',
  '[回攻略](README.md) · [地上／海底／月上總圖](images/world-map-zh-Hant.png) · [海底入口投影](images/world-map-undersea-zh-Hant.png) · [月上座標圖](images/world-map-moon-zh-Hant.png)',
  '',
  '圖號 01–87 對應 ROM 地名索引加一，與舊20點版不同。總圖直接標示81筆可定位或可歸屬入口的地名：海底入口投影在主圖、地獄各層連到鬼島、臥龍洞窟連到右側月上圖的風暴村。不是87個獨立、已驗證的野外入口。',
  '',
  '其餘6筆為海之庵（獨立入口待核對）、仙人庵（共用預設名）、玩家的城（可移動）、漂泊之島（確切位置待核對）、原野（共用區域）及月亮（整個月上圖）。這些不冒充固定落點。兵具屋島各設施與勇氣岬的精確事件格亦未完成核對，因此不宣稱所有地標已定位。',
  '',
  '固定入口來自原生事件資料，格位是概覽投影而非步行座標；同名洞窟可有多個入口。海底使用地上海岸線作投影參考，月上分圖只有座標格線，不是月面地形。',
  '',
  '## 七間麻雀旅館', '', table(catalog.slice(4, 11)),
  '', '## 十三位仙人', '', table(catalog.slice(64, 77)),
  '', '另有大太郎庵、左源內庵、鹿角之里等，見下方全表。「海之庵」與「海之仙人庵」是不同索引，前者尚未辨識獨立入口，沒有合併或猜位置。',
  '', '## 全部87筆', '', table(catalog),
  '', '## 補充地點與條件',
  '', '- 海底洞窟（勇氣之鎧）：海底原生入口範圍 X=104–107、Y=26–29，見海底分圖；這個場景沒有另外套用未確認的地名表名稱。',
  '- 漂泊之島：神仙鄉東方海域，到過七夕村後出現，使用勇氣之鏡尋找；不把神仙鄉座標充作島的位置。',
  '- 月之祠：月上三個入口分別保留；地面與海底的祠堂在龍宮城、鬼族牢獄及黃泉之塔路線內，不畫成同一個野外點。',
  '- 機關村：總圖標的是鬼之爪痕地下水路的兩個入口，需船才能進入，不是從地上直接走進村莊。',
  '- 兵具屋島：金太郎村西北方島嶼，另有兵具屋、茶店、旅館；不是七間麻雀旅館之一。三個共用場景入口已保存在未分類入口資料中，尚未把每間商店強配為地名表名稱。',
  '- 勇氣岬：麻雀旅館七號店西北方、兩尊地藏之間，依主線使用勇氣之劍；此表不以附近旅館的位置替代精確事件格。',
  '', '## 來源與驗證',
  '', '[座標與事件來源 JSON](world-map-locations.json) · [地形與排版驗證](world-map-verification.json) · [詳細來源說明](world-map.md)',
  '', '特殊進入條件參考：[海上與海底](https://onibaka.donburako.com/kouryaku/momo_shin/chart_5.html)、[竹取村與月上](https://onibaka.donburako.com/kouryaku/momo_shin/chart_6.html)。未複製外站地圖。',
  '',
].join('\n');
fs.writeFileSync(path.join(directory, 'world-map-index.md'), indexText);
console.log(`PASS: ${locations.length} native flight destinations; ${knownPoints.length} unique mapped entrances; all 87 names accounted for; all 13 hermits and 7 inns included`);
console.log('Unclassified scenes:', [...new Set(dataset.atlas.unclassifiedEntrances.map(entrance => entrance.scene.toString(16)))].join(', '));