import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeHuffman, decodeLz, encodeHuffman, encodeLzLiterals, huffmanCodes, readLzTextBlock } from './text-codec.mjs';
import { compileTextDraft, splitRecords } from './text-catalog.mjs';
import { isGlyphPrefix } from './chinese-font.mjs';
import { screenshotDialogueCases } from './screenshot-dialogue-cases.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [runner, core, previewDirectory, outputDirectory] = process.argv.slice(2);
const screenshotOnly = process.env.MOMOTARO_DIALOGUE_SCREENSHOTS === '1';
const draftPlan = process.env.MOMOTARO_DIALOGUE_PLAN;
const draftFiles = draftPlan ? JSON.parse(fs.readFileSync(path.resolve(root, draftPlan))).drafts : undefined;
assert.ok(!(screenshotOnly && draftFiles), 'Select screenshots or a draft plan, not both');
const isolatedRecords = screenshotOnly || Boolean(draftFiles);
const dictionaryReference = process.env.MOMOTARO_DIALOGUE_DICTIONARY_REFERENCE === '1';
assert.ok(!dictionaryReference || isolatedRecords, 'Dictionary reference probes require an isolated draft or screenshot selection');
const cleanup = process.env.MOMOTARO_DIALOGUE_CLEANUP === '1';
const resume = process.env.MOMOTARO_DIALOGUE_RESUME === '1';
assert.ok(runner && core && previewDirectory && outputDirectory, 'Usage: node tools/verify-dialogue.mjs RUNNER CORE PREVIEW_DIRECTORY NEW_OUTPUT_DIRECTORY');
const metadata = JSON.parse(fs.readFileSync(path.join(previewDirectory, 'build.json')));
const target = fs.readFileSync(path.join(previewDirectory, metadata.romFilename));
const original = fs.readFileSync(path.join(root, 'assets/Shin Momotarou Densetsu (Japan) (Rev 1).sfc'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(target), metadata.targetSha256);
assert.equal(sha256(original), metadata.sourceSha256);
if (resume) assert.ok(fs.statSync(outputDirectory).isDirectory());
else fs.mkdirSync(outputDirectory);

function writeProbe(name, pointer, relocatedOriginal, replacement) {
  const rom = Buffer.from(target);
  if (relocatedOriginal) original.subarray(relocatedOriginal.sourceStart, relocatedOriginal.sourceEnd).copy(rom, Number(relocatedOriginal.relocatedOffset));
  if (replacement) replacement.copy(rom, pointer);
  rom.writeUIntLE(pointer + 0xc00000, 0x702c4, 3);
  rom.writeUInt16LE(65535, 0xffdc);
  rom.writeUInt16LE(0, 0xffde);
  const sum = rom.reduce((total, byte) => (total + byte) & 65535, 0);
  rom.writeUInt16LE(sum ^ 65535, 0xffdc);
  rom.writeUInt16LE(sum, 0xffde);
  const filename = path.join(outputDirectory, `${name}.sfc`);
  fs.writeFileSync(filename, rom, { flag: 'wx' });
  return filename;
}

function run(rom, name, frames, inputs, state) {
  const destination = path.join(outputDirectory, name);
  const args = [core, rom, destination, String(frames), inputs];
  if (state) args.push(state);
  const result = spawnSync(runner, args, { encoding: 'utf8', env: { ...process.env, MOMOTARO_CAPTURE_EVERY: '60' } });
  assert.equal(result.status, 0, `Dialogue playback failed: ${name}\n${result.stderr}\n${result.stdout}`);
  return destination;
}

const inputs = ['1:2:a', ...Array.from({ length: 34 }, (_, index) => `${1800 + index * 600}:3:a`)].join(',');
function renderedWords(directory, words, required = true) {
  const matches = {};
  const masks = new Map(words.map(word => {
    const points = [];
    [...word].forEach((character, characterIndex) => {
      const index = metadata.glyphs.findIndex(glyph => glyph.character === character);
      assert.ok(index >= 0, `Missing dialogue glyph: ${character}`);
      const offset = metadata.glyphs[index].offset ?? parseInt(metadata.newFontGroupOffset, 16) + Math.floor(index / 64) * (1 + 64 * 46) + 1 + index % 64 * 46;
      for (let row = 0; row < 15; row++) for (let column = 0; column < 12; column++) {
        const bit = plane => column < 8 ? (target[offset + plane * 23 + row] >> (7 - column)) & 1
          : (target[offset + plane * 23 + 15 + (row >> 1)] >> ((row % 2 ? 0 : 4) + 11 - column)) & 1;
        if (bit(0)) points.push({ row: row + 1, column: characterIndex * 12 + column, foreground: bit(1) });
      }
    });
    return [word, points];
  }));
  for (const filename of fs.readdirSync(directory).filter(name => /^frame-\d+\.ppm$/.test(name)).sort((first, second) => Number(first.match(/\d+/)[0]) - Number(second.match(/\d+/)[0]))) {
    if (Object.keys(matches).length === words.length) break;
    const image = fs.readFileSync(path.join(directory, filename));
    const header = /^P6\n(\d+) (\d+)\n255\n/.exec(image.subarray(0, 64).toString('ascii'));
    assert.ok(header);
    const width = Number(header[1]), height = Number(header[2]);
    const pixels = image.subarray(header[0].length);
    assert.equal(pixels.length, width * height * 3);
    const brightness = Uint8Array.from({ length: width * height }, (_, index) => Math.max(pixels[index * 3], pixels[index * 3 + 1], pixels[index * 3 + 2]));
    for (const [word, points] of masks) {
      if (matches[word]) continue;
      for (let row = 0; row <= height - 16 && !matches[word]; row++) for (let column = 0; column <= width - [...word].length * 12; column++) {
        if (points.every(point => point.foreground ? brightness[(row + point.row) * width + column + point.column] >= 140 : brightness[(row + point.row) * width + column + point.column] <= 80)) {
          matches[word] = { frame: filename, x: column, y: row };
          break;
        }
      }
    }
  }
  if (required) for (const word of words) {
    if (matches[word]) continue;
    const characters = renderedWords(directory, [...new Set(word)], false);
    assert.fail(`Dialogue word never rendered: ${word}; individual glyph matches: ${JSON.stringify(characters)}`);
  }
  return matches;
}
const report = { targetSha256: metadata.targetSha256, synthetic: true, actualStoryRouteVerified: false, scenes: [] };
const manifestPath = process.env.MOMOTARO_MANIFEST
  ? path.resolve(root, process.env.MOMOTARO_MANIFEST) : path.join(root, 'translations/menu.zh-Hant.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath));
report.manifest = path.relative(root, manifestPath);
manifest.textBlocks.push(...(manifest.textDrafts ?? []).map(filename => compileTextDraft(original, JSON.parse(fs.readFileSync(path.join(root, 'translations', filename))))));
if (isolatedRecords) {
  manifest.textBlocks.push(...(manifest.nameBlocks ?? []));
  metadata.textBlocks.push(...(metadata.nameBlocks ?? []));
}
const mainStart = original.readUIntLE(0x70003, 3) - 0xc00000;
const mainEnd = original.readUIntLE(0x70006, 3) - 0xc00000;
const mainEntries = manifest.entries;
const mainStoredBytes = mainEnd - mainStart + mainEntries.reduce((total, entry) => total - entry.originalHex.length / 2
  + (entry.segments ? entry.segments.reduce((length, segment) => length + (segment.hex ? segment.hex.length / 2 : [...segment.text].length * 2), 0)
    : [...entry.translation].length * 2), 0);
const mainBefore = splitRecords(original.subarray(mainStart + 1, mainEnd));
const mainAfter = splitRecords(target.subarray(0x210001, 0x210000 + mainStoredBytes));
assert.equal(mainAfter.length, mainBefore.length, 'Main message indexes changed');
for (const record of mainBefore) if (!mainEntries.some(entry => Number(entry.offset) === mainStart + 1 + record.decodedOffset)) {
  assert.equal(mainAfter[record.index].originalHex, record.originalHex, `Unselected main message changed: ${record.index}`);
}
manifest.textBlocks.push({ name: 'main-messages', entries: mainEntries });
metadata.textBlocks.push({ name: 'main-messages', sourceStart: mainStart, sourceEnd: mainEnd,
  sourceType: 0, relocatedOffset: '0x210000', storedBytes: mainStoredBytes, strings: mainBefore.length });
function rotatedProbe(name, block, fromOriginal, firstIndex, offset) {
  const definition = manifest.textBlocks.find(entry => entry.name === block.name);
  const rom = fromOriginal ? original : target;
  const start = fromOriginal ? block.sourceStart : Number(block.relocatedOffset);
  const end = fromOriginal ? block.sourceEnd : start + block.storedBytes;
  const bytes = block.sourceType === 0 ? rom.subarray(start + 1, end)
    : block.sourceType === 2 ? decodeHuffman(rom, rom.subarray(start + 1, end), fromOriginal ? definition.decodedBytes : block.decodedBytes).bytes
    : fromOriginal ? readLzTextBlock(original, Number(definition.pointerOffset)).bytes : decodeLz(rom.subarray(start + 1, end)).bytes;
  const records = [];
  let begin = 0;
  for (let cursor = 0; cursor < bytes.length; cursor++) {
    if (isGlyphPrefix(bytes[cursor]) || bytes[cursor] === 2) cursor++;
    else if (bytes[cursor] === 0) { records.push(bytes.subarray(begin, cursor + 1)); begin = cursor + 1; }
  }
  assert.equal(begin, bytes.length);
  assert.equal(records.length, block.strings);
  if (dictionaryReference) {
    assert.equal(block.sourceStart, original.readUIntLE(0x70000, 3) - 0xc00000);
    assert.ok(Number.isInteger(firstIndex) && firstIndex >= 0 && firstIndex < records.length && firstIndex + 0xa0 <= 0xff);
    const reference = Buffer.concat([Buffer.from([0, 2, firstIndex + 0xa0, 0]), Buffer.alloc(64)]);
    return writeProbe(name, offset, fromOriginal ? block : undefined, reference);
  }
  const rotated = Buffer.concat([...(isolatedRecords ? records.slice(firstIndex, firstIndex + 1)
    : [...records.slice(firstIndex), ...records.slice(0, firstIndex)]), Buffer.alloc(64)]);
  const encoded = block.sourceType === 0 ? rotated : block.sourceType === 2 ? encodeHuffman(rotated, huffmanCodes(rom)).bytes : encodeLzLiterals(rotated);
  assert.ok((offset & 65535) + encoded.length + 1 <= 65536, 'Dialogue probe crosses a ROM bank');
  return writeProbe(name, offset, undefined, Buffer.concat([Buffer.from([block.sourceType]), encoded]));
}
const cases = [
  { name: 'enemy-readings', firstIndex: 1, frames: 1620, words: ['赤鬼'] },
  { name: 'enemy-readings', firstIndex: 43, frames: 1620, words: ['殺殺餓鬼'] },
  { name: 'enemy-readings', firstIndex: 94, frames: 1620, words: ['烏魯曼托'] },
  { name: 'enemy-readings', firstIndex: 147, frames: 1620, words: ['大哈奇托庫瑪'] },
  { name: 'enemy-readings', firstIndex: 221, frames: 1620, words: ['迦樓羅'] },
  { name: 'enemy-readings', firstIndex: 230, frames: 1620, words: ['夜叉姬'] },
  { name: 'enemy-readings', firstIndex: 239, frames: 1620, words: ['金丹仙人'] },
  { name: 'enemy-readings', firstIndex: 247, frames: 1620, words: ['嗚喲'] },
  { name: 'screenshot-locations', firstIndex: 16, frames: 1620, words: ['足柄山'] },
  { name: 'screenshot-locations', firstIndex: 17, frames: 1620, words: ['金太郎村'] },
  { name: 'screenshot-locations', firstIndex: 15, frames: 1620, words: ['無聲洞窟'] },
  ...[
    ['ashigara-mine', [
      [1620, ['孩子們都平安無事']], [1620, ['整個村子都在辦祭典']],
      [6600, ['止咳藥的事', '我是那個萬吉', '就被抓到']], [1620, ['快要成親', '可憐的人']],
      [1620, ['什麼人']], [11400, ['我沒有偷懶', '請去找金太郎', '都還沒回來']],
      [1620, ['連手臂都抬不起來']], [1620, ['留在村裡的孩子']], [1620, ['與其把這些黃金', '囂張的鬼']],
      [1620, ['我是做煙火的', '花了一整年']], [1620, ['金太郎村的煙火']], [1620, ['少了我的太鼓']],
      [1620, ['要是反抗那些鬼']], [10200, ['保住孩子的命', '賞我想要的一切']],
      [1620, ['又不是地鼠']], [1620, ['連白天黑夜都分不清']], [1620, ['不停地工作']],
      [1620, ['金太郎保護孩子們', '快去救救他']],
    ]],
    ['kintarou-rescue', [
      [1620, ['孩子們都平安無事']], [1620, ['全村都在辦祭典']], [1620, ['做成的止咳藥']],
      [1620, ['金太郎也在那裡']], [1620, ['什麼人']],
      ...Array.from({ length: 4 }, () => [1620, ['看不到太陽', '死在這裡']]),
      ...Array.from({ length: 4 }, () => [1620, ['乾脆殺了我']]),
      ...Array.from({ length: 4 }, () => [1620, ['金太郎也在那裡']]),
      [10200, ['保住孩子的命', '賞我想要的一切']], [6600, ['來了啊', '見到金太郎']],
      [3000, ['金太郎', '絕不放開這塊岩石']], [1620, ['眼睛都花了']], [1620, ['使不上力', '真好吃']],
      [1620, ['真的是']], [1620, ['百人之力']], [1620, ['看我這樣收拾你']],
      [10200, ['廉價的戲', '精神百倍', '達伊達王子', '曾與王子交手']], [3000, ['小的們']],
      [15000, ['達伊達王子失望', '龍燈鬼', '交給你掌管', '這座金礦']],
      [7800, ['龍燈鬼', '太光榮', '漂亮地打倒']],
      [12600, ['養到今天', '花了多少錢', '恩將仇報', '回到土裡']],
      [3000, ['你的夥伴']], [3000, ['鬼族的事', '小蟲哪裡懂']], [3000, ['振作一點', '睜開眼睛']],
      [10800, ['伐折羅王大人', '真的好嗎', '龍燈鬼斷氣']],
      [5400, ['吹笛子的是誰', '吹得更快樂']], [1620, ['好好玩吧', '要辦祭典']], [1620, ['先去準備祭典']],
      [12600, ['承受了我的攻擊', '我很高興', '更有骨氣', '與強者戰鬥']],
      [3000, ['真沒意思', '我要回去']], [3000, ['振作一點', '睜開眼睛']],
      [10800, ['伐折羅王大人', '真的好嗎', '龍燈鬼斷氣']],
      [1620, ['我想回家']], [1620, ['我想回家']], [1620, ['好可怕']], [1620, ['好可怕']],
      [1620, ['不用再勉強自己']], [1620, ['不用再勉強自己']],
    ]],
    ['soundless-cave', [
      [10200, ['天賊鬼', '武藝高強', '替猴子當保母', '這座洞窟送給我', '活動筋骨']],
      [4200, ['我好想見你', '我是猴子', '陪你一起旅行']],
      [1620, ['把黍糰', '交給了猴子']], [1620, ['請給我一個黍糰']], [1620, ['先生真小氣']],
      [5400, ['老天保佑', '這個給您']], [1620, ['好好懲治']],
      [4200, ['剛才聽到的叫聲', '盡一份心力', '讓它派上用場']], [1620, ['都能安心旅行']],
    ]],
    ['cave-route-hints', [
      [4200, ['提起什麼水牢', '牆壁怎麼樣', '幫上您的忙']],
      [1620, ['請在旅途中', '好好利用']], [1620, ['穿過無聲洞窟', '三間仙人庵']],
    ]],
    ['pheasant-rescue', [
      [6600, ['你來啦', '吃掉這隻雉雞', '連你也要吃掉']],
      [6600, ['我是雉雞', '一直都相信著', '陪您一起旅行']],
      [1620, ['把黍糰', '交給了雉雞']], [1620, ['請給我一個黍糰']], [1620, ['先生真小氣']],
    ]],
    ['netarou-village', [
      [4200, ['積雪深得能埋住房屋', '冰之塔的醜女']], [4200, ['躲進洞裡', '禿頭']],
      [4200, ['遇到下雪會流失體力', '請多照顧他']], [4200, ['村子恢復原狀', '防雪準備']],
      [4200, ['一起打雪仗', '重要工作']], [1620, ['男子漢之間的約定']],
      [4200, ['最討厭冷天', '溫暖的國家']], [1620, ['人心比南國還溫暖']],
      [4200, ['橋頭那裡', '還在睡覺']], [1620, ['雪球越滾越大']],
      [1620, ['風聲就會改變']], [1620, ['像桃子一樣溫柔的風']],
      [4200, ['暴風雪中喪命', '艱辛的旅途']], [1620, ['旅行見聞']],
      [1620, ['徹底改過自新', '守護神']], [4200, ['微笑村', '用言語逗人笑']],
      [1620, ['非得鏟雪', '好收成']], [4200, ['手受傷了', '冷笑話大會']],
      [1620, ['寢太郎先生', '老爺爺']], [1620, ['寢太郎', '唔喵唔喵']],
      [1620, ['冰室袋裡取出', '冰室刨冰', '眼睛上']], [4200, ['寢太郎', '好冰']],
      [1620, ['晚', '唔喵唔喵']], [1620, ['寢太郎又', '睡著了']],
      [1620, ['冰室袋裡取出', '冰室刨冰', '眼睛上']], [4200, ['寢太郎', '好冰']],
      [12600, ['天上掉冰柱', '擋住大家過橋', '對']],
      [1620, ['寢太郎', '唔喵唔喵']], [1620, ['寢太郎又', '睡著了']],
    ]],
    ['urashima-aging', [
      [1620, ['攻擊和防禦', '格外小心']], [1620, ['恢復原狀', '真辛苦']],
      [1620, ['大江山十分險峻', '多爬幾次']], [1620, ['老夫還老']],
      [1620, ['來接你的海龜', '龍宮城']], [4200, ['飛燕之術', '北邊的橋', '半島的盡頭']],
      [1620, ['白髮蒼蒼']], [1620, ['變年輕了', '養老瀑布']],
      [4200, ['很吃力', '黍糰上路']], [1620, ['當成累贅']],
      [4200, ['養老瀑布的水', '送水過去']], [4200, ['不太對勁', '這個給你']],
      [1620, ['與月亮有關', '祕密']], [1620, ['去過月亮']],
      [5400, ['送瀑布水', '使喚別人']], [1620, ['魚叉', '連續攻擊兩次']],
      [4200, ['救了乙姬', '趁新鮮']], [1620, ['靠捕魚維生', '守護這片大海']],
      [4200, ['源頭', '滑溜溜', '老人家']], [4200, ['是親戚', '襲擊龍宮城']],
      [4200, ['浦島回來', '撐不住']], [4200, ['勇氣', '可不敢上戰場']],
      [1620, ['代表我們村']], [1620, ['全村的人', '掛心']],
      [1620, ['三隻鬼', '養老瀑布']], [4200, ['往返地面', '那條路']],
      [1620, ['和月亮相通']], [6000, ['赤松葉', '煎煮成茶']],
      [4200, ['沒有任何效果', '還是不行']], [4200, ['長翅膀的鬼', '好東西']],
      [5400, ['改過自新', '部下的刀', '裝作沒事']], [6000, ['南瓜', '十到十五年', '老化']],
      [4200, ['沒有任何效果', '還是不行']], [1620, ['乙姬大人', '海邊']],
      [1620, ['最珍貴的寶物']], [1620, ['再拿起刀', '早點到來']],
      [4200, ['一視同仁', '閻魔大人']], [1620, ['仰慕浦島']],
      [5400, ['胡作非為', '一直欺騙大家']], [1620, ['騙得團團轉']],
      [4200, ['搬到這個村子', '心曠神怡']], [1620, ['太害怕', '不敢說出口']],
      [1620, ['迦樓羅', '找到好東西']], [10200, ['玉手箱', '鬼族卻不會', '陪本大爺玩玩', '老人']],
      [1620, ['一行人']], [6600, ['煙霧籠罩', '老爺爺']],
      [6600, ['煙霧籠罩', '老爺爺', '上山砍柴', '回春之泉']],
      [9000, ['怪鬼', '魅鬼', '魃鬼三兄弟', '瀑布弄乾', '恢復年輕', '過活']],
      [4200, ['不服老爺爺', '沖水']], [1620, ['平安順利', '澆上']],
      [1620, ['隨時都可以來']], [6600, ['恢復生機', '出海討生活', '沖一沖']],
      [6600, ['部下們來了', '登月之路', '我在海邊等你']],
      [1620, ['出發去龍宮城']], [1620, ['隨時來找我']],
    ]],
    ['moon-crystal-guidance', [
      [1620, ['老夫是天之仙人', '有件事要告訴你']],
      [13800, ['月之水晶', '也就是', '新月', '三日月', '上弦', '下弦', '臥待', '居待', '十六夜', '滿月', '八顆', '鬼族都不知道的力量']],
      [1620, ['還想再聽一次', '月之水晶']], [1620, ['一面鏡子', '八顆水晶的所在']],
      [1620, ['變成老爺爺', '比我還慢']], [1620, ['這個給你']],
      [1620, ['討伐惡鬼要加油']], [4200, ['腰痛得很', '瀑布竟然停了', '其他村的人']],
      [4200, ['武器也弱', '認真努力', '討伐惡鬼結束']], [1620, ['什麼都別說', '帶上吧']],
      [1620, ['沒有', '祈求你們平安']], [1620, ['神明', '救出都城']],
    ]],
    ['sparrow-inn-crossroads', [
      [4200, ['往南是浦島村', '多來打聽']], [4200, ['往南是浦島村', '多來打聽']],
      [1620, ['山勢險峻', '記熟山路']], [1620, ['趁浦島先生不在', '下手了']],
      [4200, ['龍宮城', '更狡猾']], [4200, ['不熟悉山路', '慢慢記住山路']],
      [4200, ['北方的橋', '邀浦島先生同行']], [1620, ['你在找水晶', '沒見過']],
      [4200, ['長著翅膀的鬼', '麻雀朋友們']], [4200, ['設置機關', '好像是猜拳']],
      [4200, ['浦島剛才', '天之仙人', '一臉凶相']], [1620, ['果然被騙', '太老實']],
      [1620, ['大江山對吧', '這個帶著']], [1620, ['體力不夠', '沒問題']],
      [1620, ['浦島村有個', '請小心']], [1620, ['變成老爺爺', '打了一場']],
      [4200, ['世界說不定', '囉哩囉唆']], [1620, ['男子氣概', '光說不練']],
      [4200, ['迎面卻又是雪國', '築起堡壘']], [1620, ['憑我的腦袋', '辦不到']],
      [1620, ['路上小心', '一路順風']], [4200, ['避鬼仙人庵', '群山環繞']],
      [4200, ['天之仙人的塔', '半島的盡頭']],
    ]],
    ['rokkaku-village', [
      [4200, ['疏於向仙人修行', '金太郎村東北方', '解毒仙人庵']],
      [4200, ['正等著您', '戒掉最愛的將棋', '鹿角之術']],
      [4200, ['梅木杖', '不可思議的力量']], [1620, ['梅花真香', '跑哪去了']],
      [1620, ['白蝴蝶翩翩飛舞', '老頭子']], [4200, ['梅樹很漂亮', '驅除邪氣']],
      [1620, ['討些梅乾', '對身體很好']],
    ]],
    ['ooeyama-puzzles', [
      [9000, ['鬼族設下的陷阱', '三個人與三隻夥伴', '平安穿越大江山', '通往二樓']],
      [4200, ['只能幫到這裡', '保佑你們平安']],
      [6600, ['尚未完成的事情', '切莫心急', '再回到這裡']],
      [23400, ['當作敵人對待', '連小孩都會玩', '就會出現新的樓梯', '配對文字', '翻開兩塊石板', '還想再聽一次']],
      [4200, ['我們之間的較量', '愚蠢的生物']], [1620, ['還在逞強', '都不會告訴你']],
      [6600, ['調查了石板', '配對相同的文字', '消除所有石板']],
      [11400, ['小試身手', '龍勝虎', '虎勝龜', '龜勝龍', '還想知道更多']],
      [1620, ['誰要告訴你']], [1620, ['乖乖回答想知道']],
      [13800, ['龍為水', '龜為風', '火能喚起風', '風能聚集水', '逐一移動藍色石板']],
    ]],
    ['festival-village', [
      [1620, ['話裡隱藏的意思']], [4200, ['沿山邊', '避鬼仙人庵', '麻雀旅館二號店']],
      [4200, ['見過鹿角仙人', '盡頭的半島', '更鋒利']], [1620, ['今天天氣真好']],
      [1620, ['一起來跳舞', '閃到腰']], [1620, ['秋刀魚', '買菜']],
      [4200, ['鹿角之里', '全體鬼族奏效']], [1620, ['忙死了', '沒空聊天']],
      [1620, ['嘿呀', '好呀']], [1620, ['田裡耕作', '請讓個路']],
      [1620, ['射靶遊戲', '頭暈']], [1620, ['天氣真好', '洗衣服']],
      [1620, ['祭典攤位', '祭後一場空']], [1620, ['曬太陽', '你還在這裡']],
      [1620, ['夜市攤位', '打鬼的疲勞']], [4200, ['真擔心那些孩子', '今天要吃什麼飯']],
      [6600, ['要去浦島村', '沿森林往南走', '實力練好']], [1620, ['這麼見外', '待人親切']],
      [1620, ['開心享受祭典']], [1620, ['沒有什麼鬼', '別的村子']],
      [1620, ['喝呀', '嘿咻']], [1620, ['嘿啦啦', '來咻']],
      [1620, ['一邊打鬼', '夥伴們培養']], [1620, ['站穩腳步']],
      [4200, ['可以前往龍宮城', '還能上月亮']], [1620, ['唷嘿呀']],
      [1620, ['嘿唷呀']], [1620, ['拿過來']], [1620, ['來吧', '嘿唷嘿唷']],
      [1620, ['祭典的吆喝聲']], [4200, ['要不要看煙火', '慶祝您打鬼', '大煙火上天']],
      [1620, ['這裡危險', '請退後一點']], [1620, ['想看煙火時', '再叫我一聲']],
      [5400, ['迦樓羅', '祭典真好玩', '餘興節目', '一起算進去']],
      [7800, ['西來咪嗦', '一起來跳舞', '要不要一起跳舞', '原來還在打鬼途中', '雖然捨不得']],
    ]],
    ['hanasaka-village', [
      [1620, ['花咲爺爺的家', '策劃什麼']], [1620, ['想懲治迦樓羅', '快去見閻魔']],
      [1620, ['二十年以上']], [1620, ['真不愧是花咲爺爺']], [1620, ['才在田裡插秧']],
      [4200, ['賣力插秧', '送到飯糰村']], [4200, ['一座水牢', '水漲到天花板', '人就會淹死']],
      [1620, ['足柄山遭鬼襲擊']], [1620, ['做櫻餅給我吃']], [1620, ['連葉子都能吃']],
      [1620, ['花咲爺爺', '怎麼樣了']], [1620, ['旅行時用得上']], [1620, ['天賊鬼', '擋住了大家']],
      [1620, ['止咳藥', '這副模樣']], [1620, ['治好我娘的咳嗽']], [1620, ['鬼們闖進了']],
      [1620, ['平安無事', '一起喝茶']], [4200, ['村子就活不下去', '一定要活著']],
      [4200, ['若世間從無櫻花', '古今和歌集', '在原業平']], [1620, ['一起被抓了嗎']],
      [1620, ['最珍貴的寶物']], [1620, ['無聲洞窟', '解咒藥']],
      [11400, ['迦樓羅', '欣賞什麼櫻花', '把一切都燒光', '就賞給你們', '愛怎麼改造']],
      [1620, ['純淨一點', '櫻花好美']], [1620, ['骯髒不堪', '好可悲']], [1620, ['願意接納我們']],
      [1620, ['一起生活', '鬼族今後的路']], [3000, ['花咲爺爺', '讓枯木開花']],
      [13800, ['京城的阿修羅', '這有什麼難的', '美麗的櫻花樹']],
      [5400, ['最美麗的山櫻', '請您帶走']], [1620, ['得到了櫻花樹']],
      [9000, ['讓枯木開花', '重新綻放花朵', '傳達給鬼們']],
      [6600, ['我是狗兒', '打鬼之旅', '陪您一起旅行']], [1620, ['先生真小氣']],
      [1620, ['交給了狗兒']], [1620, ['請給我一個黍糰']],
    ]],
    ['hanasaka-prison-entrance', [
      [10200, ['名叫巴坎鬼', '村子就是我的', '待會兒再慢慢收拾', '就跟我來']],
      [1620, ['不准跟老頭', '說話']], [1620, ['不准跟老頭', '說話']], [1620, ['不准跟老頭', '說話']],
      [10200, ['真過意不去', '什麼也回報不了', '重新開花', '好好欣賞']],
    ]],
    ['hanasaka-water-prison', [
      [11400, ['巴坎鬼的聲音', '比比智慧', '灌進你所在', '天花板以前逃出來', '才有資格']],
      [1620, ['我在這裡']], [1620, ['我在這裡']], [1620, ['我在這裡']],
      [3000, ['迦樓羅', '真是頑強']], [4200, ['巴坎鬼', '就照約定']],
      [3000, ['巴坎鬼', '為迦樓羅大人而戰']], [3000, ['沒用的東西']],
      [6600, ['你們都聽好了', '自行了斷', '伐折羅王大人']],
      [13800, ['盡心效力', '到底算什麼', '巴坎鬼斷氣了']], [1620, ['悲傷的人究竟是誰']],
    ]],
  ].flatMap(([name, scenes]) => scenes.map(([frames, words], firstIndex) => ({ name, firstIndex, frames, words }))),
  { name: 'hanasaka-visitors', firstIndex: 11, frames: 4200, words: ['櫻花木製成的衣櫃', '大受好評', '櫻花木都沒了'] },
  { name: 'hanasaka-visitors', firstIndex: 12, frames: 1620, words: ['櫻花樹苗', '二十年'] },
  { name: 'hanasaka-visitors', firstIndex: 13, frames: 4200, words: ['祕密地圖', '真是對不起'] },
  { name: 'hanasaka-visitors', firstIndex: 14, frames: 1620, words: ['改過自新', '幫村民做事'] },
  ...[
    [1620, ['交給了']],
    [1620, ['汪汪', '真是太好吃了']], [1620, ['汪汪', '剛才吃得好滿足']],
    [1620, ['吱吱', '真是太好吃了']], [1620, ['吱吱', '剛才吃得好滿足']],
    [1620, ['啾啾', '真是太好吃了']], [1620, ['啾啾', '剛才吃得好滿足']],
    [1620, ['好吃得快融化了']], [1620, ['好吃得停不下來']], [1620, ['滋味真是高雅極了']],
    [1620, ['剛才給誰了']], [4200, ['提升了一點', '變為']], [1620, ['學會了']],
    [1620, ['已達到最高值', '無法再提升了']], [1620, ['能長大到今天', '一直細心養育', '賜給你吧']],
    [1620, ['已經無法再提升了']], [1620, ['並沒有帶', '同行']],
    [1620, ['人氣低於三十', '已經不肯吃了']], [1620, ['人氣低於三十', '不肯聽從指示了']],
    [1620, ['先生的壞話', '不想聽你的命令']], [1620, ['充滿愛與勇氣', '跑到哪裡去了']],
    [1620, ['最近是不是忘了', '討伐惡鬼']],
  ].map(([frames, words], index) => ({ name: 'field-messages', firstIndex: 24 + index, frames, words })),
  ...[
    [1620, ['沒有潛伏的鬼']], [6600, ['嗅嗅嗅', '埋著什麼東西', '挖開了腳邊']],
    [1620, ['地下竟埋著']], [1620, ['嗅嗅嗅']], [1620, ['沒有埋任何東西']],
    [1620, ['請看這個']], [1620, ['實在太危險']], [1620, ['游個泳']],
    [1620, ['不能游泳']], [1620, ['做個記號']], [1620, ['嘩']],
    [1620, ['會不好意思']], [1620, ['太危險']], [1620, ['讓我去撿']],
    [1620, ['重要的東西', '丟出去']], [1620, ['丟了出去']], [1620, ['拚命找過', '還是找不到']],
    [1620, ['撿回來了']], [1620, ['撿回來了', '咦']], [1620, ['可以探索的地方']],
    [1620, ['去探索']], [1620, ['挖這裡']], [1620, ['往西']], [1620, ['往東']],
    [1620, ['往北', '步的地方']], [1620, ['往南', '步的地方']], [1620, ['似乎埋著什麼東西']],
    [4200, ['挖這裡', '沒有埋任何東西']], [1620, ['請看這個']], [1620, ['太危險']],
    [4200, ['找點東西回來', '尋找東西去了']], [1620, ['找回來了']], [1620, ['到處都找過', '什麼也沒找到']],
    [6600, ['夥伴們叫來', '背著籃子', '順利逃到了外面']], [4200, ['我的夥伴']],
    [1620, ['去偵察']], [1620, ['沒有必要偵察']], [1620, ['目前持有', '要到幾兩時通知你']],
    [1620, ['我就通知你']], [1620, ['你現在已經有', '在身上了']],
    [4200, ['去請大夫過來', '振翅飛走了']], [1620, ['我把大夫請來了']],
    [1620, ['那我就送大夫']], [1620, ['帶著大夫', '振翅飛走了']], [1620, ['送回去了']],
    [1620, ['調查寶箱的數量']], [1620, ['這裡的寶箱']], [4200, ['我知道了', '尚未打開']],
    [4200, ['我知道了', '似乎已經全部']], [1620, ['看看前面的情況']],
    [1620, ['看不到前面的情況']], [1620, ['沒辦法出門跑腿']], [1620, ['要去哪裡買']],
    [1620, ['要到哪間店']], [1620, ['要買什麼回來']], [1620, ['對吧']],
    [4200, ['錢都不夠了', '跟老闆殺價']], [4200, ['去跑腿了', '出門跑腿去了']],
    [1620, ['還要買其他東西']], [1620, ['我買完東西回來了']], [1620, ['從空中看看']],
    [1620, ['沒辦法瞭望']], [6600, ['攻擊力下降三點', '防禦力下降二點', '速度下降三點']],
    [1620, ['恢復原狀了']], [6600, ['攻擊力下降二點', '防禦力下降十點', '速度下降二點']],
    [1620, ['恢復原狀了']], [1620, ['吃了一個黍糰']], [1620, ['沒有帶黍糰']],
    [4200, ['雉雞', '剩下的是這些']],
  ].map(([frames, words], index) => ({ name: 'field-messages', firstIndex: 123 + index, frames, words })),
  { name: 'field-messages', firstIndex: 61, frames: 1620, words: ['的人氣提升了'] },
  { name: 'field-messages', firstIndex: 62, frames: 5400, words: ['人氣達到一百', '崑崙之玉', '不能再提升'] },
  { name: 'field-messages', firstIndex: 63, frames: 1620, words: ['超過八十', '好事發生'] },
  { name: 'field-messages', firstIndex: 64, frames: 1620, words: ['的人氣下降了'] },
  { name: 'field-messages', firstIndex: 65, frames: 4200, words: ['降到三十以下', '快去做好事'] },
  { name: 'field-messages', firstIndex: 66, frames: 1620, words: ['的人氣變為'] },
  ...['狗兒', '猴子', '雉雞'].map((word, index) => ({ name: 'field-messages', firstIndex: 76 + index, frames: 1620, words: [word, '加入了隊伍'] })),
  { name: 'field-messages', firstIndex: 122, frames: 6600, words: ['有了夥伴', '攻擊力提升了', '防禦力提升了', '速度提升了'] },
  { name: 'rice-ball-offering', firstIndex: 0, frames: 1620, words: ['飯糰村終於建好了', '請您一定要來看看'] },
  { name: 'rice-ball-offering', firstIndex: 5, frames: 4200, words: ['蜥蜴尾巴', '體力剩下一半', '逃走'] },
  { name: 'screenshot-locations', firstIndex: 12, frames: 1620, words: ['花咲村洞窟'] },
  { name: 'screenshot-locations', firstIndex: 14, frames: 1620, words: ['花咲村'] },
  { name: 'spell-chants', firstIndex: 14, frames: 1620, words: ['稻妻啊啊啊'] },
  { name: 'spell-chants', firstIndex: 15, frames: 1620, words: ['轟隆轟隆轟隆'] },
  { name: 'spell-chants', firstIndex: 16, frames: 1620, words: ['轟隆轟隆閃光'] },
  { name: 'spell-chants', firstIndex: 17, frames: 1620, words: ['轟隆閃光'] },
  { name: 'sparrow-inn-one', firstIndex: 0, frames: 10200, words: ['天氣與法術', '雷雨時', '更多技力', '好好記住'] },
  { name: 'sparrow-inn-one', firstIndex: 1, frames: 1620, words: ['東南方', '脫身仙人'] },
  { name: 'sparrow-inn-one', firstIndex: 2, frames: 1620, words: ['松葉山', '大門', '去路'] },
  { name: 'sparrow-inn-one', firstIndex: 3, frames: 1620, words: ['松葉山的門', '已經打開'] },
  { name: 'sparrow-inn-one', firstIndex: 4, frames: 1620, words: ['滾飯糰洞', '飯糰村'] },
  { name: 'sparrow-inn-one', firstIndex: 5, frames: 4200, words: ['麻雀旅館', '飼料的店', '學會特技', '加入戰鬥'] },
  { name: 'matsuba-gate', firstIndex: 0, frames: 4200, words: ['果然厲害', '獨自旅行', '先行一步', '打聽消息'] },
  { name: 'matsuba-gate', firstIndex: 1, frames: 1620, words: ['扒手銀次', '各自踏上旅程'] },
  { name: 'matsuba-gate', firstIndex: 2, frames: 1620, words: ['要是放你過去', '迦樓羅大人'] },
  { name: 'matsuba-gate', firstIndex: 3, frames: 1620, words: ['蠻力', '放馬過來'] },
  { name: 'matsuba-gate', firstIndex: 4, frames: 1620, words: ['要是放你過去', '迦樓羅大人'] },
  { name: 'matsuba-gate', firstIndex: 5, frames: 1620, words: ['反抗鬼族', '鮮血'] },
  { name: 'matsuba-gate', firstIndex: 6, frames: 1620, words: ['要是放你過去', '迦樓羅大人'] },
  { name: 'lightning-hermit', firstIndex: 0, frames: 4200, words: ['稻妻仙人', '稻妻之術', '你的本事'] },
  { name: 'lightning-hermit', firstIndex: 1, frames: 4200, words: ['松葉山的密道', '跟著老夫來'] },
  { name: 'lightning-hermit', firstIndex: 2, frames: 1620, words: ['小機關'] },
  { name: 'lightning-hermit', firstIndex: 3, frames: 4200, words: ['再加把勁', '期待你的表現'] },
  { name: 'lightning-hermit', firstIndex: 4, frames: 1620, words: ['還差得遠', '再變強一點'] },
  { name: 'lightning-rock-trial', firstIndex: 0, frames: 1620, words: ['時間到了'] },
  { name: 'lightning-rock-trial', firstIndex: 1, frames: 1620, words: ['時間就要不夠'] },
  { name: 'lightning-rock-trial', firstIndex: 2, frames: 12600, words: ['八塊岩石', '數到一百', '五塊以上', '連按Ａ鈕', '硬度不同', '用心判斷', '開始吧'] },
  ...['滾飯糰洞', '飯糰村', '麻雀旅館一號店', '麻雀旅館二號店', '麻雀旅館三號店', '麻雀旅館四號店', '麻雀旅館五號店', '麻雀旅館六號店', '麻雀旅館七號店', '松葉山'].map((word, index) => ({ name: 'screenshot-locations', firstIndex: index + 2, frames: 1620, words: [word] })),
  { name: 'screenshot-locations', firstIndex: 65, frames: 1620, words: ['稻妻仙人庵'] },
  ...[
    [1, '啟程村'], [18, '浦島村'], [22, '寢太郎村'], [26, '微笑村'], [27, '希望之都'],
    [36, '猴蟹村'], [38, '竹取村'], [41, '寧靜村'], [42, '豐饒村'], [43, '月之宮殿'],
    [44, '風暴村'], [45, '鬼島'], [57, '七夕村'], [58, '夢之村'], [61, '新村'], [83, '機關村'],
  ].map(([firstIndex, word]) => ({ name: 'screenshot-locations', firstIndex, frames: 1620, words: [word] })),
  { name: 'ryotetsu-encounter', firstIndex: 0, frames: 1620, words: ['地蜘蛛襲擊過來了'] },
  { name: 'ryotetsu-encounter', firstIndex: 1, frames: 1620, words: ['土蜘蛛襲擊過來了'] },
  { name: 'ryotetsu-encounter', firstIndex: 2, frames: 7800, words: ['咕呵呵呵', '光靠土蜘蛛', '迦樓羅大人', '輕而易舉', '越強越好', '酒才更好喝', '就讓我兩鐵', '親手收拾你'] },
  { name: 'ryotetsu-encounter', firstIndex: 3, frames: 6600, words: ['我是甚八', '向您道謝', '建好飯糰村', '盡一份心力'] },
  { name: 'ryotetsu-encounter', firstIndex: 4, frames: 1620, words: ['現在旅行', '真的輕鬆多了'] },
  { name: 'ryotetsu-encounter', firstIndex: 5, frames: 1620, words: ['輕鬆旅行的日子', '早點到來'] },
  { name: 'battle-messages', firstIndex: 23, frames: 1620, words: ['襲擊過來了'] },
  { name: 'battle-messages', firstIndex: 24, frames: 1620, words: ['襲擊過來了'] },
  { name: 'main-messages', firstIndex: 101, frames: 1620, words: ['發現了'] },
  { name: 'equipment-effects', firstIndex: 16, frames: 1620, words: ['菜刀的光芒讓', '體力回復了'] },
  { name: 'battle-effects', firstIndex: 86, frames: 1620, words: ['的攻擊力', '下降了'] },
  { name: 'field-messages', firstIndex: 11, frames: 1620, words: ['的體力', '全部回復了'] },
  { name: 'field-messages', firstIndex: 53, frames: 1620, words: ['進入了絕佳狀態'] },
  { name: 'battle-messages', firstIndex: 33, frames: 1620, words: ['寶箱裡竟然有', '埋伏著'] },
  { name: 'battle-messages', firstIndex: 34, frames: 1620, words: ['寶箱裡竟然有', '埋伏著'] },
  { name: 'battle-messages', firstIndex: 35, frames: 1620, words: ['從寶箱裡找到了'] },
  { name: 'battle-messages', firstIndex: 156, frames: 1620, words: ['的體力', '全部回復了'] },
  { name: 'battle-messages', firstIndex: 157, frames: 1620, words: ['的體力', '全部回復了'] },
  { name: 'battle-messages', firstIndex: 159, frames: 1620, words: ['的技力', '全部回復了'] },
  { name: 'battle-messages', firstIndex: 160, frames: 1620, words: ['的技力', '全部回復了'] },
  { name: 'item-descriptions', firstIndex: 188, frames: 1620, words: ['的體力', '全部回復了'] },
  { name: 'item-descriptions', firstIndex: 190, frames: 1620, words: ['的體力', '全部回復了'] },
  { name: 'item-descriptions', firstIndex: 191, frames: 1620, words: ['的技力', '全部回復了'] },
  { name: 'item-descriptions', firstIndex: 193, frames: 1620, words: ['的技力', '全部回復了'] },
  { name: 'spell-chants', firstIndex: 1, frames: 1620, words: ['金丹啊啊啊'] },
  { name: 'spell-chants', firstIndex: 2, frames: 1620, words: ['千金丹啊啊啊'] },
  { name: 'spell-chants', firstIndex: 3, frames: 1620, words: ['萬金丹啊啊啊'] },
  { name: 'spell-chants', firstIndex: 4, frames: 1620, words: ['全體金丹啊啊啊'] },
  ...[
    [6, 1620, ['試圖使用', '無法施展的法術']], [7, 1620, ['無法對鬼族使用']],
    [8, 1620, ['請聯絡', '三上']], [24, 1620, ['什麼也沒發生']],
    [25, 1620, ['解除一位夥伴的麻痺']], [26, 1620, ['召來小浪', '全體鬼族造成傷害']],
    [27, 1620, ['召來巨浪', '全體鬼族造成大量傷害']], [28, 1620, ['召來海嘯', '造成重創']],
    [29, 1620, ['降下閃電', '可擊碎岩石', '造成傷害']],
    [30, 1620, ['召來雷電', '隻鬼造成傷害']], [31, 1620, ['雷擊', '造成大量傷害']],
    [32, 1620, ['雷擊', '造成重創']], [33, 1620, ['掀起旋風', '全體鬼族造成傷害']],
    [34, 1620, ['掀起突風', '全體鬼族造成大量傷害']], [35, 1620, ['掀起烈風', '造成重創']],
    [36, 1620, ['召來烈焰', '鬼族造成傷害']], [37, 1620, ['召來火焰', '造成大量傷害']],
    [38, 1620, ['火焰奔流', '鬼族造成重創']], [39, 1620, ['玫瑰吹雪之術', '必須在體力極低']],
    [40, 1620, ['玫瑰吹雪', '造成大量傷害']], [41, 1620, ['湧出數萬朵玫瑰', '朝著鬼族飛射']],
    [42, 1620, ['忍冬之術', '必須尚有體力與技力']], [43, 1620, ['犧牲幾乎全部', '造成重創']],
    [44, 4200, ['就是奉獻', '用盡所有潛能', '獻出了自身']],
    [45, 1620, ['約消耗技力上限', '召來流星', '造成重創']],
    [46, 4200, ['萬千繁星', '請賜予我力量', '增添了流星的力量']],
    [47, 1620, ['約消耗技力上限', '使出會心一擊']],
    [49, 1620, ['偷取全體鬼族的金錢', '並對鬼族造成傷害']], [50, 1620, ['身上', '偷到了']],
    [51, 1620, ['偷取全體鬼族的大筆金錢', '並造成大量傷害']],
    [52, 1620, ['全體鬼族造成猛烈重創']], [53, 4200, ['渾身使不出力氣', '凝聚全身的力量', '向鬼族猛擊']],
    [54, 1620, ['削弱鬼族', '回復少量體力']], [55, 1620, ['攻擊力', '防禦力與速度', '全都下降']],
    [56, 1620, ['全體金丹之術', '竟然有這種法術']], [57, 1620, ['技力上限的一半', '造成猛烈重創']],
    [58, 1620, ['達達達達', '吉吉吉吉', '咚咚咚咚']],
    [59, 1620, ['提升一位夥伴的攻擊力', '戰鬥中可反覆使用']],
    [60, 1620, ['提升全體夥伴的防禦力', '戰鬥中可反覆使用']],
    [61, 1620, ['提升全體夥伴的速度', '戰鬥中可反覆使用']],
    [62, 1620, ['解除全體夥伴', '睡眠與混亂']], [63, 1620, ['減輕鬼族法術造成的傷害']],
    [64, 1620, ['一段時間內', '可使出連續攻擊']], [65, 1620, ['創造自己的分身', '讓分身參與戰鬥']],
    [66, 1620, ['分身只能有', '無法再增加']], [67, 4200, ['發出了純白的光芒', '的分身', '出現了']],
    [68, 1620, ['無法攻擊', '但也完全不會受到', '鬼族的攻擊']], [69, 1620, ['什麼也沒發生']],
    [70, 4200, ['巨大的玫瑰', '包裹住了', '鬼族無法對', '發動攻擊了']],
    [71, 1620, ['放出臭屁', '降低全體鬼族的攻擊力', '戰鬥中可反覆使用']],
    [72, 1620, ['先生', '好臭啊']], [73, 1620, ['降低全體鬼族的防禦力', '戰鬥中可反覆使用']],
    [74, 1620, ['降低全體鬼族的速度']], [75, 1620, ['封住全體鬼族的法術']],
    [76, 1620, ['隻鬼的少量技力', '化為自己的技力']], [77, 1620, ['身上', '偷取了', '點技力']],
    [78, 1620, ['隻鬼只能揮拳攻擊']], [79, 1620, ['隻鬼', '的決鬥']],
    [80, 1620, ['什麼也沒發生']], [81, 1620, ['帶進了變幻的世界']],
    [82, 1620, ['降低全體敵我雙方的防禦力', '戰鬥中可反覆使用']],
    [83, 1620, ['讓自身以外', '所有敵人與夥伴', '暫時無法動彈']],
    [84, 1620, ['不論是敵人還是夥伴', '全都停止了動作']], [85, 1620, ['讓所有人陷入睡眠']],
    [86, 1620, ['飛往曾經造訪的村莊']], [87, 1620, ['現在無法使用']],
    [88, 1620, ['脫離洞窟或塔內']], [89, 1620, ['在這裡什麼也沒發生']],
    [90, 1620, ['比自己弱的敵人不會出現']], [91, 1620, ['就算做了料理', '也已經拿不下']],
    [92, 1620, ['製作飯糰']], [93, 1620, ['做出了飯糰']], [94, 1620, ['料理失敗']],
    [95, 1620, ['做出了飯糰']], [96, 1620, ['在整場戰鬥中', '防止鬼族的詛咒攻擊']],
    [97, 1620, ['什麼也沒發生']], [98, 1620, ['能驅除邪惡力量', '光芒包圍']],
    [99, 1620, ['讓身體浮空', '即使身在毒沼也不怕']], [100, 1620, ['身體浮到了空中']],
    [101, 1620, ['身體浮到了空中']], [102, 1620, ['從這場戰鬥的途中重新來過']],
    [103, 1620, ['什麼也沒發生']], [104, 1620, ['一切都化為泡影', '消失在遙遠的彼方']],
    [105, 1620, ['妖異之術', '無法在這裡使用']], [106, 1620, ['不在海上', '無法掀起海上風暴']],
    [107, 1620, ['在洞窟與塔外', '可隨心所欲', '改變天氣']], [108, 1620, ['出門泡澡']],
    [109, 1620, ['竟然這麼悠閒', '露肚怪', '出發去泡溫泉']],
    [110, 1620, ['體力變成了']], [111, 1620, ['體力變成了']],
    [112, 1620, ['熱霧瀰漫', '變得難以命中']], [113, 1620, ['什麼也沒發生']],
    [114, 1620, ['周圍的景色', '逐漸扭曲']], [115, 1620, ['技力不足']],
    [116, 1620, ['剩餘技力']], [117, 1620, ['客倌', '您的錢不夠']], [118, 1620, ['技力不足']],
    [119, 1620, ['技力不足']], [120, 1620, ['技力耗盡']], [121, 1620, ['客倌', '您的錢不夠']],
    [122, 1620, ['會心之術']], [123, 1620, ['抵消了']], [124, 1620, ['威力增強了']],
    [125, 1620, ['試圖施展', '之術']], [126, 1620, ['詭異光芒的影響', '卻施展了']],
    [127, 6600, ['老夫是天之仙人', '還想悠哉地做什麼', '快點準備妥當', '迦樓羅']],
    [128, 1620, ['無法使用', '之術']],
  ].map(([firstIndex, frames, words]) => ({ name: 'spell-messages', firstIndex, frames, words })),
  { name: 'spell-messages', firstIndex: 48, frames: 1620, words: ['刀變得更加鋒利'] },
  { name: 'boss-battle-dialogue', firstIndex: 247, frames: 1620, words: ['漂亮地拿下一分'] },
  { name: 'boss-battle-dialogue', firstIndex: 248, frames: 4200, words: ['鹿角之術有多厲害', '鹿角啊啊啊啊'] },
  { name: 'boss-battle-dialogue', firstIndex: 249, frames: 1620, words: ['漂亮地拿下一分'] },
  ...[
    '別忘了這份光芒', '連老夫都吃不消', '這小子進步得真快', '完全打不中',
    '竟然也能走到這裡', '打鬼可不是鬧著玩的', '恐怕辦不到', '居然越來越強',
    '一點也不見衰弱', '真是一副堅毅的神情', '都願意跟隨你', '只顧著看自己的體力',
    '可是不斷在恢復', '老夫也得加把勁', '你還是稍微休息一下',
  ].map((word, index) => ({ name: 'prince-and-karura-dialogue', firstIndex: 216 + index, frames: 1620, words: [word] })),
  ...[
    [0, '的老家'], [19, '養老瀑布'], [20, '龍宮城'], [21, '大江山'], [23, '寢太郎之穴'],
    [24, '大太郎庵'], [25, '冰之塔'], [28, '伸長怪森林'], [29, '眾神之里'], [30, '風神谷'],
    [31, '伏龍洞窟'], [32, '雷神洞窟'], [33, '左源內庵'], [34, '鬼族牢獄'], [35, '露肚怪之里'],
    [37, '山姥洞窟'], [39, '黃泉之塔'], [40, '彩虹洞窟'], [46, '地獄・三途川'],
    [47, '地獄・黑繩地獄'], [48, '地獄・血池地獄'], [49, '地獄・眾合地獄'],
    [50, '地獄・焦熱地獄'], [51, '地獄・極寒地獄'], [52, '地獄・大焦熱地獄'],
    [53, '地獄・阿鼻地獄'], [54, '伐折羅王之間'], [55, '月之祠'], [56, '神仙鄉'],
    [59, '海之庵'], [60, '仙人庵'], [62, '奈落洞窟'], [63, '人魚村'],
    [67, '解毒仙人庵'], [68, '避鬼仙人庵'], [69, '脫身仙人庵'], [70, '天之仙人塔'],
    [71, '避魔仙人庵'], [72, '浮游仙人庵'], [73, '放屁仙人庵'], [74, '萬金仙人庵'],
    [75, '金瘡仙人庵'], [76, '海之仙人庵'], [77, '城'], [78, '五重塔'], [79, '月之洞窟'],
    [80, '怨恨洞窟'], [81, '漂泊之島'], [82, '雪原'], [84, '原野'], [85, '月亮'], [86, '臥龍洞窟'],
  ].map(([firstIndex, word]) => ({ name: 'screenshot-locations', firstIndex, frames: 1620, words: [word] })),
  { name: 'screenshot-locations', firstIndex: 13, frames: 1620, words: ['鹿角之里'] },
  { name: 'screenshot-locations', firstIndex: 66, frames: 1620, words: ['鹿角仙人庵'] },
  { name: 'golden-buddha', firstIndex: 4, frames: 1620, words: ['好漂亮的黃金佛像'] },
  { name: 'spell-messages', firstIndex: 0, frames: 1620, words: ['施展了', '之術'] },
  { name: 'spell-messages', firstIndex: 2, frames: 1620, words: ['施展了', '之術'] },
  { name: 'spell-messages', firstIndex: 4, frames: 1620, words: ['什麼也沒發生'] },
  { name: 'spell-messages', firstIndex: 5, frames: 1620, words: ['現在無法使用'] },
  { name: 'spell-messages', firstIndex: 9, frames: 1620, words: ['無法出聲的詛咒', '不能施展法術'] },
  { name: 'spell-messages', firstIndex: 10, frames: 1620, words: ['身受重傷', '不能施展法術'] },
  { name: 'spell-messages', firstIndex: 11, frames: 1620, words: ['消耗', '少量回復一位夥伴的體力'] },
  { name: 'spell-messages', firstIndex: 12, frames: 1620, words: ['大量回復一位夥伴的體力'] },
  { name: 'spell-messages', firstIndex: 13, frames: 1620, words: ['完全回復一位夥伴的體力'] },
  { name: 'spell-messages', firstIndex: 14, frames: 1620, words: ['少量回復全體夥伴的體力'] },
  { name: 'spell-messages', firstIndex: 15, frames: 1620, words: ['大量回復全體夥伴的體力'] },
  { name: 'spell-messages', firstIndex: 16, frames: 1620, words: ['完全回復全體夥伴的體力'] },
  { name: 'spell-messages', firstIndex: 17, frames: 1620, words: ['逐漸回復全體夥伴的體力'] },
  { name: 'spell-messages', firstIndex: 18, frames: 1620, words: ['香氣包圍了'] },
  { name: 'spell-messages', firstIndex: 19, frames: 1620, words: ['治好一位夥伴的重傷', '體力回復至上限的一半'] },
  { name: 'spell-messages', firstIndex: 20, frames: 1620, words: ['什麼也沒發生'] },
  { name: 'spell-messages', firstIndex: 21, frames: 1620, words: ['站起來了'] },
  { name: 'spell-messages', firstIndex: 22, frames: 1620, words: ['恢復了意識'] },
  { name: 'spell-messages', firstIndex: 23, frames: 1620, words: ['解除一位夥伴的中毒'] },
  { name: 'item-descriptions', firstIndex: 3, frames: 1620, words: ['使用了'] },
  { name: 'item-descriptions', firstIndex: 13, frames: 1620, words: ['竹水筒裡的水喝光了'] },
  { name: 'item-descriptions', firstIndex: 17, frames: 1620, words: ['如意小槌壞掉了'] },
  { name: 'item-descriptions', firstIndex: 27, frames: 1620, words: ['就能原地復活'] },
  { name: 'item-descriptions', firstIndex: 28, frames: 1620, words: ['背包裡的崑崙之玉', '發出了耀眼光芒'] },
  { name: 'item-descriptions', firstIndex: 29, frames: 1620, words: ['毒就會消失'] },
  { name: 'item-descriptions', firstIndex: 30, frames: 1620, words: ['麻痺', '就會解除'] },
  { name: 'item-descriptions', firstIndex: 31, frames: 1620, words: ['詛咒就會解除'] },
  { name: 'item-descriptions', firstIndex: 32, frames: 1620, words: ['從混亂中恢復'] },
  { name: 'item-descriptions', firstIndex: 33, frames: 1620, words: ['頭腦清醒了', '從混亂中恢復了'] },
  { name: 'item-descriptions', firstIndex: 34, frames: 1620, words: ['立刻痊癒'] },
  { name: 'item-descriptions', firstIndex: 35, frames: 1620, words: ['全部恢復'] },
  { name: 'item-descriptions', firstIndex: 36, frames: 1620, words: ['恢復精神了'] },
  { name: 'item-descriptions', firstIndex: 37, frames: 1620, words: ['已經喝光了'] },
  { name: 'item-descriptions', firstIndex: 38, frames: 1620, words: ['會稍微回復'] },
  { name: 'item-descriptions', firstIndex: 39, frames: 1620, words: ['只能丟掉'] },
  { name: 'item-descriptions', firstIndex: 41, frames: 1620, words: ['吃壞了肚子', '體力下降了'] },
  { name: 'item-descriptions', firstIndex: 42, frames: 1620, words: ['修城工具', '才能使用'] },
  { name: 'item-descriptions', firstIndex: 43, frames: 1620, words: ['城堡耐久度'] },
  { name: 'item-descriptions', firstIndex: 44, frames: 1620, words: ['術法攻擊'] },
  { name: 'item-descriptions', firstIndex: 45, frames: 1620, words: ['就會代你承受'] },
  { name: 'item-descriptions', firstIndex: 46, frames: 5400, words: ['背包裡的替身地藏', '讓我來替你承受吧', '替身地藏碎裂了'] },
  { name: 'item-descriptions', firstIndex: 47, frames: 1620, words: ['鬼道'] },
  { name: 'item-descriptions', firstIndex: 48, frames: 1620, words: ['獲得的金錢變為'] },
  { name: 'item-descriptions', firstIndex: 49, frames: 1620, words: ['作用不明'] },
  { name: 'item-descriptions', firstIndex: 50, frames: 1620, words: ['打擊反彈一半'] },
  { name: 'main-messages', firstIndex: 103, frames: 1620, words: ['竟然', '寶箱裡藏著'] },
  { name: 'main-messages', firstIndex: 104, frames: 1620, words: ['拉進了', '寶箱裡'] },
  { name: 'main-messages', firstIndex: 105, frames: 1620, words: ['從寶箱裡取出了'] },
  { name: 'main-messages', firstIndex: 106, frames: 1620, words: ['放回了寶箱裡'] },
  { name: 'main-messages', firstIndex: 109, frames: 1620, words: ['但是寶箱裡空空如也'] },
  { name: 'field-messages', firstIndex: 67, frames: 1620, words: ['發現背包', '已經裝滿了'] },
  { name: 'field-messages', firstIndex: 68, frames: 1620, words: ['要丟棄背包裡的道具嗎'] },
  { name: 'field-messages', firstIndex: 69, frames: 1620, words: ['要丟棄誰的背包裡的道具'] },
  { name: 'field-messages', firstIndex: 70, frames: 1620, words: ['放棄了'] },
  { name: 'field-messages', firstIndex: 71, frames: 1620, words: ['不能丟棄'] },
  { name: 'field-messages', firstIndex: 72, frames: 1620, words: ['丟棄了', '得到了'] },
  { name: 'field-messages', firstIndex: 73, frames: 1620, words: ['得到了'] },
  { name: 'field-messages', firstIndex: 74, frames: 1620, words: ['要丟棄', '確定嗎'] },
  { name: 'item-descriptions', firstIndex: 147, frames: 1620, words: ['帶在身上就能挖土', '繼續前進', '永久'] },
  { name: 'item-descriptions', firstIndex: 186, frames: 1620, words: ['這裡不能使用'] },
  { name: 'rice-ball-cave-depths', firstIndex: 0, frames: 4200, words: ['操縱土蜘蛛', '兩鐵', '迦樓羅大人'] },
  { name: 'rice-ball-cave-depths', firstIndex: 1, frames: 4200, words: ['長著翅膀的鬼', '非常害怕'] },
  { name: 'rice-ball-cave-depths', firstIndex: 2, frames: 1620, words: ['根本不在乎', '破壞這個地方'] },
  { name: 'rice-ball-cave-depths', firstIndex: 3, frames: 1620, words: ['土蜘蛛', '突然出現'] },
  { name: 'rice-ball-cave-depths', firstIndex: 4, frames: 1620, words: ['我們要蓋飯糰村', '嘿咻'] },
  { name: 'rice-ball-cave-depths', firstIndex: 5, frames: 1620, words: ['飯糰村', '令人期待'] },
  { name: 'field-messages', firstIndex: 0, frames: 3000, words: ['升到了', '體力變為'] },
  { name: 'field-messages', firstIndex: 1, frames: 1620, words: ['升到了'] },
  { name: 'field-messages', firstIndex: 2, frames: 1620, words: ['技力變為'] },
  { name: 'field-messages', firstIndex: 4, frames: 1620, words: ['攻擊力提升了'] },
  { name: 'field-messages', firstIndex: 6, frames: 1620, words: ['防禦力提升了'] },
  { name: 'field-messages', firstIndex: 8, frames: 1620, words: ['速度提升了'] },
  { name: 'boss-battle-dialogue', firstIndex: 0, frames: 1620, words: ['發動攻擊'] },
  { name: 'boss-battle-dialogue', firstIndex: 2, frames: 1620, words: ['鋼鐵身軀', '打擊加倍反彈'] },
  { name: 'boss-battle-dialogue', firstIndex: 3, frames: 1620, words: ['鬼道吸收術'] },
  { name: 'boss-battle-dialogue', firstIndex: 4, frames: 1620, words: ['被吸走了一半'] },
  { name: 'boss-battle-dialogue', firstIndex: 5, frames: 4200, words: ['縮小了', '攻擊力恢復原狀', '防禦力恢復原狀'] },
  { name: 'boss-battle-dialogue', firstIndex: 6, frames: 1620, words: ['熊熊怒火'] },
  { name: 'boss-battle-dialogue', firstIndex: 7, frames: 3000, words: ['攻擊力變成兩倍', '防禦力變成兩倍'] },
  { name: 'boss-battle-dialogue', firstIndex: 8, frames: 1620, words: ['從口中吐出蜘蛛絲'] },
  { name: 'boss-battle-dialogue', firstIndex: 9, frames: 1620, words: ['武器', '黏稠的蜘蛛絲纏住了'] },
  { name: 'boss-battle-dialogue', firstIndex: 10, frames: 1620, words: ['從口中吐出蜘蛛絲'] },
  { name: 'boss-battle-dialogue', firstIndex: 11, frames: 1620, words: ['耀眼的光芒'] },
  { name: 'boss-battle-dialogue', firstIndex: 12, frames: 1620, words: ['詭異的光芒'] },
  { name: 'boss-battle-dialogue', firstIndex: 13, frames: 3000, words: ['體力與技力', '互相交換了'] },
  { name: 'boss-battle-dialogue', firstIndex: 14, frames: 1620, words: ['鬼道解咒術'] },
  { name: 'boss-battle-dialogue', firstIndex: 214, frames: 4200, words: ['本大爺', '實力相差太遠了', '要施展哪種術', '就讓你來選吧'] },
  { name: 'boss-battle-dialogue', firstIndex: 215, frames: 1620, words: ['選的是', '接招吧'] },
  { name: 'battle-messages', firstIndex: 54, frames: 1620, words: ['沒有睡著'] },
  { name: 'battle-messages', firstIndex: 55, frames: 1620, words: ['正在沉睡'] },
  { name: 'battle-messages', firstIndex: 56, frames: 1620, words: ['從睡夢中醒來了'] },
  { name: 'battle-messages', firstIndex: 57, frames: 1620, words: ['身體', '黏稠的蜘蛛絲纏住了'] },
  { name: 'battle-messages', firstIndex: 58, frames: 1620, words: ['蜘蛛絲被甩開了'] },
  { name: 'rice-ball-entrance', firstIndex: 0, frames: 1620, words: ['地藏菩薩', '哪裡出去'] },
  { name: 'rice-ball-entrance', firstIndex: 3, frames: 1620, words: ['會噴毒的青鬼', '請小心'] },
  { name: 'rice-ball-offering', firstIndex: 1, frames: 1620, words: ['飯糰', '供品'] },
  { name: 'rice-ball-offering', firstIndex: 2, frames: 5400, words: ['供上了飯糰', '滾進了洞裡', '也跟著進去了', '咚咚跳'] },
  { name: 'rice-ball-offering', firstIndex: 3, frames: 1620, words: ['根本就沒帶', '冒失傢伙'] },
  { name: 'rice-ball-offering', firstIndex: 4, frames: 1620, words: ['敬重神明', '天譴'] },
  { name: 'screenshot-locations', firstIndex: 64, frames: 1620, words: ['金丹仙人庵'] },
  { name: 'field-messages', firstIndex: 10, frames: 1620, words: ['體力與技力', '全部回復了'] },
  { name: 'field-messages', firstIndex: 56, frames: 1620, words: ['調查了眼前'] },
  { name: 'item-descriptions', firstIndex: 195, frames: 1620, words: ['體力與技力', '全部回復了'] },
  { name: 'rice-ball-cave', firstIndex: 0, frames: 4200, words: ['危險', '沒帶耙鋤', '地裂'] },
  { name: 'rice-ball-cave', firstIndex: 3, frames: 10200, words: ['甚八', '旅人', '土蜘蛛'] },
  { name: 'rice-ball-cave', firstIndex: 9, frames: 1620, words: ['好可怕', '地裂的底下'] },
  { name: 'rice-ball-cave', firstIndex: 11, frames: 1620, words: ['蓋村莊', '回不了家'] },
  { name: 'rice-ball-cave', firstIndex: 12, frames: 1620, words: ['解毒藥', '土蜘蛛的毒'] },
  { name: 'rice-ball-cave', firstIndex: 13, frames: 1620, words: ['女人家', '獨自一人旅行', '行不通'] },
  { name: 'hidden-passage-training', firstIndex: 0, frames: 4200, words: ['限時五分鐘', '隱藏的通道'] },
  { name: 'hidden-passage-training', firstIndex: 4, frames: 1620, words: ['不用著急', '時間好像不多'] },
  { name: 'avoid-encounters-training', firstIndex: 0, frames: 1620, words: ['最裡面', '大樹'] },
  { name: 'avoid-encounters-training', firstIndex: 1, frames: 1620, words: ['一路避開鬼'] },
  { name: 'poison-escort-training', firstIndex: 0, frames: 1620, words: ['千萬別讓', '老夫死掉'] },
  { name: 'poison-escort-training', firstIndex: 1, frames: 1620, words: ['老夫這條命', '快要不保'] },
  { name: 'poison-escort-training', firstIndex: 2, frames: 1620, words: ['你走路時', '顧慮老夫'] },
  { name: 'poison-escort-training', firstIndex: 3, frames: 1620, words: ['可別忘了', '老夫也在這裡'] },
  { name: 'poison-escort-training', firstIndex: 4, frames: 3000, words: ['毒藥', '喝下去'] },
  { name: 'poison-escort-training', firstIndex: 5, frames: 5400, words: ['已經中毒', '卷軸', '降到零點', '修行就失敗'] },
  { name: 'golden-buddha', firstIndex: 0, frames: 4200, words: ['背後的佛像', '不少錢'] },
  { name: 'golden-buddha', firstIndex: 1, frames: 3000, words: ['金太郎', '天之仙人', '不客氣'] },
  { name: 'golden-buddha', firstIndex: 2, frames: 1620, words: ['阿修羅', '千萬不能輸'] },
  { name: 'golden-buddha', firstIndex: 3, frames: 1620, words: ['得到了黃金佛像'] },
  { name: 'spell-teachers', firstIndex: 0, frames: 3000, words: ['解毒仙人', '解毒之術'] },
  { name: 'spell-teachers', firstIndex: 2, frames: 4200, words: ['脫身仙人', '回到地面'] },
  { name: 'spell-teachers', firstIndex: 3, frames: 4200, words: ['避魔仙人', '瞭若指掌'] },
  { name: 'spell-teachers', firstIndex: 5, frames: 4200, words: ['中毒的次數', '避魔之術'] },
  { name: 'spell-teachers', firstIndex: 9, frames: 3000, words: ['五十隻以上的野槌'] },
  { name: 'spell-teachers', firstIndex: 14, frames: 6000, words: ['放屁仙人', '洞察力', '查字典'] },
  { name: 'spell-teachers', firstIndex: 15, frames: 3000, words: ['美妙旋律', '放了幾次屁'] },
  { name: 'spell-teachers', firstIndex: 17, frames: 3000, words: ['屁股會痛', '快點通過'] },
  { name: 'spell-teachers', firstIndex: 30, frames: 3000, words: ['避鬼仙人', '跟著老夫'] },
  { name: 'spell-teachers', firstIndex: 33, frames: 5400, words: ['天之仙人', '月亮都能飛', '飛燕卷軸'] },
  { name: 'spell-teachers', firstIndex: 38, frames: 3000, words: ['海之仙人', '沒用仙人'] },
  { name: 'spell-teachers', firstIndex: 49, frames: 1620, words: ['阿闍世王子', '輝夜姬'] },
  { name: 'spell-teachers', firstIndex: 54, frames: 1620, words: ['歐洲共同體', '區域主義'] },
  { name: 'spell-teachers', firstIndex: 68, frames: 1620, words: ['文件磁片'] },
  { name: 'spell-teachers', firstIndex: 70, frames: 1620, words: ['從頭到尾'] },
  { name: 'spell-teachers', firstIndex: 71, frames: 1620, words: ['派得上用場'] },
  { name: 'spell-teachers', firstIndex: 74, frames: 3000, words: ['金丹仙人', '打贏老夫'] },
  { name: 'spell-teachers', firstIndex: 75, frames: 6000, words: ['鹿角之里', '梅花香', '鹿角之術'] },
  { name: 'spell-teachers', firstIndex: 76, frames: 4200, words: ['浮游仙人', '毒沼澤', '陷阱'] },
  { name: 'spell-teachers', firstIndex: 77, frames: 4200, words: ['萬金仙人', '萬金丹之術'] },
  { name: 'spell-teachers', firstIndex: 78, frames: 5400, words: ['金瘡仙人', '救助夥伴'] },
  { name: 'spell-teachers', firstIndex: 80, frames: 3000, words: ['第一次', '順利通過'] },
  { name: 'spell-teachers', firstIndex: 84, frames: 3000, words: ['金丹', '恢復', '點體力'] },
  { name: 'spell-teachers', firstIndex: 86, frames: 6600, words: ['小岩石', '天氣影響', '雷雨', '乾旱'] },
  { name: 'spell-teachers', firstIndex: 87, frames: 4200, words: ['鹿角', '重創所有敵人'] },
  { name: 'spell-teachers', firstIndex: 90, frames: 4200, words: ['毒素消失', '劇毒'] },
  { name: 'spell-teachers', firstIndex: 94, frames: 4200, words: ['比你弱小', '多餘的戰鬥'] },
  { name: 'spell-teachers', firstIndex: 95, frames: 4200, words: ['詛咒攻擊', '你的努力'] },
  { name: 'spell-teachers', firstIndex: 96, frames: 3000, words: ['飛燕', '返回曾去過的村莊'] },
  { name: 'spell-teachers', firstIndex: 100, frames: 3000, words: ['村民讓路', '降低鬼的力量'] },
  { name: 'spell-teachers', firstIndex: 102, frames: 3000, words: ['萬金丹', '體力完全恢復'] },
  { name: 'spell-teachers', firstIndex: 104, frames: 3000, words: ['金瘡', '重傷的夥伴'] },
  { name: 'rice-ball-village', firstIndex: 0, frames: 3000, words: ['飯糰滾呀滾', '請享用'] },
  { name: 'rice-ball-village', firstIndex: 2, frames: 1620, words: ['村長甚八'] },
  { name: 'rice-ball-village', firstIndex: 3, frames: 1620, words: ['人氣低於三十', '兩倍'] },
  { name: 'rice-ball-village', firstIndex: 4, frames: 3000, words: ['麻雀旅館', '藤箱'] },
  { name: 'rice-ball-village', firstIndex: 6, frames: 1620, words: ['雷鬼', '雷鳴術'] },
  { name: 'rice-ball-village', firstIndex: 13, frames: 1620, words: ['不會遇到鬼'] },
  { name: 'rice-ball-village', firstIndex: 15, frames: 4200, words: ['招待過路旅人', '地裂上架橋'] },
  { name: 'rice-ball-village', firstIndex: 16, frames: 3000, words: ['報答', '大恩'] },
  { name: 'rice-ball-village', firstIndex: 23, frames: 1620, words: ['啟程村', '白米'] },
  { name: 'companions-and-villagers', firstIndex: 0, frames: 1620, words: ['雉雞', '名字'] },
  { name: 'companions-and-villagers', firstIndex: 4, frames: 4200, words: ['夥伴', '狗的名字'] },
  { name: 'companions-and-villagers', firstIndex: 5, frames: 1620, words: ['猴子的名字'] },
  { name: 'companions-and-villagers', firstIndex: 6, frames: 1620, words: ['雉雞的名字'] },
  { name: 'companions-and-villagers', firstIndex: 8, frames: 1620, words: ['昆布'] },
  { name: 'companions-and-villagers', firstIndex: 11, frames: 1620, words: ['寧靜村', '月宮', '輝夜姬'] },
  { name: 'companions-and-villagers', firstIndex: 13, frames: 1620, words: ['泡泡'] },
  { name: 'companions-and-villagers', firstIndex: 14, frames: 1620, words: ['假冒'] },
  { name: 'companions-and-villagers', firstIndex: 15, frames: 3000, words: ['阿健', '終於不哭'] },
  { name: 'companions-and-villagers', firstIndex: 20, frames: 6000, words: ['沒聽清楚', '裁判', '閃到腰'] },
  { name: 'companions-and-villagers', firstIndex: 22, frames: 4200, words: ['挨家挨戶', '巡迴唱歌'] },
  { name: 'companions-and-villagers', firstIndex: 29, frames: 4200, words: ['黃泉之塔', '麻雀旅館'] },
  { name: 'regional-village-residents', firstIndex: 0, frames: 1620, words: ['閻魔大人'] },
  { name: 'regional-village-residents', firstIndex: 2, frames: 1620, words: ['浦島', '天之仙人'] },
  { name: 'regional-village-residents', firstIndex: 6, frames: 1620, words: ['養老瀑布'] },
  { name: 'regional-village-residents', firstIndex: 11, frames: 1620, words: ['寢太郎'] },
  { name: 'regional-village-residents', firstIndex: 13, frames: 3000, words: ['冰之塔', '黍糰', '飯糰'] },
  { name: 'regional-village-residents', firstIndex: 18, frames: 4200, words: ['聽不清楚', '真猿'] },
  { name: 'regional-village-residents', firstIndex: 19, frames: 1620, words: ['木屐'] },
  { name: 'regional-village-residents', firstIndex: 23, frames: 4200, words: ['皮膚', '乾巴巴'] },
  { name: 'regional-village-residents', firstIndex: 24, frames: 3000, words: ['雙關語大會', '定音'] },
  { name: 'regional-village-residents', firstIndex: 25, frames: 1620, words: ['伊志目料理亭'] },
  { name: 'starting-village-residents', firstIndex: 0, frames: 1620, words: ['銀次', '裝備'] },
  { name: 'starting-village-residents', firstIndex: 1, frames: 1620, words: ['狛犬'] },
  { name: 'starting-village-residents', firstIndex: 2, frames: 1620, words: ['滾飯糰洞'] },
  { name: 'starting-village-residents', firstIndex: 6, frames: 1620, words: ['井水'] },
  { name: 'starting-village-residents', firstIndex: 7, frames: 1620, words: ['飛燕卷軸'] },
  { name: 'starting-village-residents', firstIndex: 15, frames: 1620, words: ['屋頂'] },
  { name: 'starting-village-residents', firstIndex: 16, frames: 1620, words: ['金丹仙人', '庵堂'] },
  { name: 'starting-village-residents', firstIndex: 18, frames: 1620, words: ['神社參拜'] },
  { name: 'starting-village-residents', firstIndex: 22, frames: 1620, words: ['怎麼了'] },
  { name: 'prince-and-mirror-hints', firstIndex: 0, frames: 1620, words: ['迦樓羅', '撫養'] },
  { name: 'prince-and-mirror-hints', firstIndex: 1, frames: 1620, words: ['勇氣之鏡', '沉入海中'] },
  { name: 'festival-face-puzzle', firstIndex: 0, frames: 1620, words: ['牢牢記住'] },
  { name: 'festival-face-puzzle', firstIndex: 1, frames: 1620, words: ['髮髻'] },
  { name: 'festival-face-puzzle', firstIndex: 2, frames: 1620, words: ['瀏海'] },
  { name: 'festival-face-puzzle', firstIndex: 3, frames: 1620, words: ['頭巾'] },
  { name: 'festival-face-puzzle', firstIndex: 5, frames: 1620, words: ['右眼'] },
  { name: 'festival-face-puzzle', firstIndex: 7, frames: 1620, words: ['右耳'] },
  { name: 'festival-face-puzzle', firstIndex: 8, frames: 1620, words: ['禍從口出'] },
  { name: 'festival-face-puzzle', firstIndex: 9, frames: 1620, words: ['傑作'] },
  { name: 'festival-face-puzzle', firstIndex: 14, frames: 1620, words: ['漫畫家'] },
  { name: 'festival-face-puzzle', firstIndex: 15, frames: 1620, words: ['藝術家'] },
  { name: 'festival-face-puzzle', firstIndex: 16, frames: 1620, words: ['太厲害'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 0, frames: 1620, words: ['神諭'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 3, frames: 1620, words: ['祓除'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 12, frames: 1620, words: ['旅途日記'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 21, frames: 1620, words: ['地藏菩薩'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 25, frames: 1620, words: ['銘記在心'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 27, frames: 1620, words: ['心值'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 38, frames: 1620, words: ['九十九段'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 53, frames: 1620, words: ['童子鬼'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 62, frames: 1620, words: ['奧柯比奇'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 67, frames: 1620, words: ['黑河童'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 69, frames: 1620, words: ['鯨魚'] },
  { name: 'shrines-and-fortune-tellers', firstIndex: 70, frames: 1620, words: ['鋸緣青蟹'] },
  { name: 'village-interactions', firstIndex: 23, frames: 1620, words: ['篝火'] },
  { name: 'village-interactions', firstIndex: 30, frames: 1620, words: ['抽個籤'] },
  { name: 'village-interactions', firstIndex: 34, frames: 1620, words: ['末吉'] },
  { name: 'village-interactions', firstIndex: 50, frames: 1620, words: ['香油錢箱'] },
  { name: 'village-interactions', firstIndex: 57, frames: 1620, words: ['伐折羅王', '迦樓羅'] },
  { name: 'village-interactions', firstIndex: 61, frames: 1620, words: ['堅持不懈'] },
  { name: 'village-interactions', firstIndex: 71, frames: 1620, words: ['鯉魚'] },
  { name: 'village-interactions', firstIndex: 73, frames: 1620, words: ['釣竿'] },
  { name: 'village-interactions', firstIndex: 78, frames: 1620, words: ['知識問答'] },
  { name: 'village-interactions', firstIndex: 81, frames: 1620, words: ['撈金魚'] },
  { name: 'village-interactions', firstIndex: 87, frames: 1620, words: ['夜市券'] },
  { name: 'village-interactions', firstIndex: 90, frames: 1620, words: ['紅白機'] },
  { name: 'village-interactions', firstIndex: 95, frames: 1620, words: ['地鼠'] },
  { name: 'village-interactions', firstIndex: 96, frames: 1620, words: ['十五塊'] },
  { name: 'shared-village-services', firstIndex: 38, frames: 1620, words: ['想買些什麼'] },
  { name: 'shared-village-services', firstIndex: 42, frames: 1620, words: ['要由誰攜帶'] },
  { name: 'shared-village-services', firstIndex: 46, frames: 1620, words: ['謝謝惠顧'] },
  { name: 'shared-village-services', firstIndex: 52, frames: 1620, words: ['想賣出什麼'] },
  { name: 'shared-village-services', firstIndex: 53, frames: 1620, words: ['收購魚類'] },
  { name: 'shared-village-services', firstIndex: 69, frames: 1620, words: ['裝備'] },
  { name: 'shared-village-services', firstIndex: 122, frames: 1620, words: ['寄存多少錢'] },
  { name: 'shared-village-services', firstIndex: 124, frames: 1620, words: ['領出多少錢'] },
  { name: 'shared-village-services', firstIndex: 142, frames: 1620, words: ['我是醫生'] },
  { name: 'shared-village-services', firstIndex: 145, frames: 1620, words: ['要替誰解毒'] },
  { name: 'shared-village-services', firstIndex: 175, frames: 1620, words: ['客房全滿了'] },
  { name: 'shared-village-services', firstIndex: 177, frames: 1620, words: ['住宿券'] },
  { name: 'moon-palace-guard', frames: 1620, words: ['你是誰', '不准通行', '迦樓羅', '大人的命令'] },
  { name: 'battle-messages', firstIndex: 2, frames: 4200, words: ['造成了', '點傷害'] },
  { name: 'moon-challenge-dialogue', frames: 14400, words: ['迦樓羅', '鬼神', '達伊達', '輝夜姬', '鳳凰'] },
  { name: 'awakening-dialogue', frames: 12000, words: ['奶奶', '振作一點', '爺爺', '銀次', '天之仙人', '愛與勇氣'] },
  { name: 'moon-challenge-dialogue', firstIndex: 13, frames: 14400, words: ['龍宮城', '乙姬', '寧靜村', '夢之村', '珍寶'] },
  { name: 'awakening-dialogue', firstIndex: 12, frames: 14400, words: ['愛與勇氣', '旅途中', '銀次加入了隊伍', '三天', '平安無事'] },
  { name: 'boss-battle-dialogue', firstIndex: 225, frames: 14400, words: ['伐折羅王', '吸走了', '擊飛了', '達伊達', '阿闍世', '夜叉姬'] },
  { name: 'boss-battle-dialogue', firstIndex: 236, frames: 7800, words: ['風神', '閻魔大人', '同伴關係'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 126, frames: 9000, words: ['羅生門', '同伴的力量', '蘆葦', '真正的強大'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 138, frames: 12000, words: ['右魂鬼', '左魂鬼', '身為鬼的尊嚴', '永世長存', '月亮之王', '地獄之王', '大地之王', '天上之王'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 152, frames: 4200, words: ['腳越來越硬', '村民的聲音', '強烈的怨恨', '達伊達', '別再叫了'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 201, frames: 1620, words: ['怎麼回事', '腰勢'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 202, frames: 1620, words: ['刀揮得這麼慢', '蒼蠅'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 203, frames: 1620, words: ['一點力氣', '黍糰'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 204, frames: 1620, words: ['這點身手', '惡鬼打倒'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 205, frames: 1620, words: ['手臂揮動', '越來越快'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 206, frames: 1620, words: ['進步不少'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 207, frames: 1620, words: ['剛才那一擊', '真夠勁'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 208, frames: 1620, words: ['就是這樣', '哇哈哈'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 209, frames: 1620, words: ['差不多', '認真上了'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 210, frames: 1620, words: ['依賴術法', '打不贏'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 211, frames: 1620, words: ['消滅惡鬼', '懲治牠們'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 212, frames: 1620, words: ['了解對手', '找到出路'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 213, frames: 1620, words: ['冷靜', '辦不成'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 214, frames: 1620, words: ['這一招', '承受得住'] },
  { name: 'prince-and-karura-dialogue', firstIndex: 215, frames: 1620, words: ['就是這樣'] },
];
if (!isolatedRecords) {
for (const name of ['item-descriptions', 'equipment-effects', 'boss-battle-dialogue']) {
  const definition = manifest.textBlocks.find(block => block.name === name);
  const block = metadata.textBlocks.find(block => block.name === name);
  const records = splitRecords(original.subarray(block.sourceStart + 1, block.sourceEnd));
  const battle = name === 'boss-battle-dialogue';
  if (!battle) assert.equal(definition.entries.length, records.length, `Incomplete ${name} translation`);
  for (const record of records) {
    if (cases.some(entry => entry.name === name && (entry.firstIndex ?? 0) === record.index)) continue;
    const entry = definition.entries.find(entry => Number(entry.offset) === block.sourceStart + 1 + record.decodedOffset);
    if (battle && !entry) continue;
    assert.ok(entry, `Missing ${name} ${record.index}`);
    assert.equal(entry.originalHex, record.originalHex);
    let words = [...new Set(entry.segments.flatMap(segment => segment.text
      ? segment.text.split(/[，。！：？「」〈〉（）…、\s]+/).filter(word => [...word].length >= (battle ? 1 : 2)) : []))];
    if (battle && words.length > 3) {
      const longest = words.reduce((first, second) => [...first].length >= [...second].length ? first : second);
      words = [...new Set([words[0], longest, words.at(-1)])];
    }
    assert.ok(words.length, `No visible text for ${name} ${record.index}`);
    const controls = entry.segments.flatMap(segment => segment.hex ? [...Buffer.from(segment.hex, 'hex')] : []);
    const pauses = controls.filter(byte => byte === 0x0f || byte === 0x0b).length;
    const lines = controls.filter(byte => byte === 1).length;
    const frames = battle ? Math.max(1620, (Math.ceil((lines + 1) / 3) + pauses) * 600 + 1200)
      : Math.max(1620, (pauses - 1) * 1800 + 1620, lines > 8 ? 15000 : 0);
    cases.push({ name, firstIndex: record.index, frames, words });
  }
}
for (const [name, indexes] of [
  ['village-rescue-rumors', null],
  ['waterfall-confrontation', null],
  ['village-cough-remedy', [2, 6]],
  ['field-messages', Array.from({ length: 192 }, (_, index) => index).filter(index => ![3, 5, 7, 9].includes(index))],
  ['ooeyama-rock-puzzle', null],
  ['ooeyama-direction-cipher', null],
  ['ooeyama-crushing-rocks', null],
  ['ooeyama-karura-taunts', null],
  ['ooeyama-rainbow-puzzle', null],
  ['ooeyama-shuten-confrontation', null],
  ['ice-tower-yashahime', null],
  ['battle-messages', [21]],
  ['battle-effects', Array.from({ length: 18 }, (_, index) => index + 36)],
  ['spell-chants', [11, 51, 52, 53, 54, 55, 56]],
  ['battle-effects', [2, 6, 7, 8, 9, 10, 11, 12, 68]],
  ['dragon-palace-entry', null],
  ['dragon-palace-rescue', null],
  ['dragon-palace-moon', null],
  ['kintarou-festival-farewell', null],
  ['moon-treasure-hall', null],
  ['quiet-village-residents', null],
  ['garyuu-trial', null],
  ['yuuzuki-moon-events', null],
  ['moon-karura-history', null],
  ['moon-princess-history', null],
  ['prince-and-karura-dialogue', [183, 184]],
  ['hidden-passage-training', null],
  ['avoid-encounters-training', null],
  ['prince-and-mirror-hints', null],
]) {
  const definition = manifest.textBlocks.find(block => block.name === name);
  const block = metadata.textBlocks.find(block => block.name === name);
  const bytes = block.sourceType === 2
    ? decodeHuffman(original, original.subarray(block.sourceStart + 1, block.sourceEnd), definition.decodedBytes).bytes
    : block.sourceType === 1 ? decodeLz(original.subarray(block.sourceStart + 1, block.sourceEnd)).bytes
      : original.subarray(block.sourceStart + 1, block.sourceEnd);
  for (const record of splitRecords(bytes)) {
    if (indexes && !indexes.includes(record.index)) continue;
    if (cases.some(entry => entry.name === name && (entry.firstIndex ?? 0) === record.index)) continue;
    const offset = record.decodedOffset + (block.sourceType === 0 ? block.sourceStart + 1 : 0);
    const entry = definition.entries.find(entry => Number(entry.offset) === offset);
    assert.ok(entry, `Missing screenshot translation: ${name}-${record.index}`);
    assert.equal(entry.originalHex, record.originalHex);
    const phrases = [...new Set(entry.segments.flatMap(segment => segment.text
      ? segment.text.split(/[，。！：？「」〈〉（）…、\s]+/).filter(Boolean) : []))];
    assert.ok(phrases.length);
    const longest = phrases.reduce((first, second) => [...first].length >= [...second].length ? first : second);
    const words = [...new Set([phrases[0], longest, phrases.at(-1)])];
    if (name === 'moon-princess-history' && [13, 16].includes(record.index)) {
      const boundaryWord = record.index === 13 ? '也開始失去秩序了' : '遭遇不測';
      assert.ok(phrases.includes(boundaryWord));
      if (!words.includes(boundaryWord)) words.push(boundaryWord);
    }
    const controls = entry.segments.flatMap(segment => segment.hex ? [...Buffer.from(segment.hex, 'hex')] : []);
    const lines = controls.filter(byte => byte === 1).length;
    const pauses = controls.filter(byte => byte === 0x0f || byte === 0x0b).length;
    const frames = Math.max(1620, (Math.ceil((lines + 1) / 3) + pauses) * 600 + 1200);
    cases.push({ name, firstIndex: record.index, frames, words });
  }
}
}
if (isolatedRecords) {
  const generated = screenshotDialogueCases(root, original, manifest, metadata, draftFiles);
  cases.splice(0, cases.length, ...generated.cases);
  if (screenshotOnly) report.screenshotCoverage = generated.coverage;
  if (draftFiles) report.draftFiles = draftFiles;
  report.screenshotOnly = screenshotOnly;
  report.isolatedRecords = true;
}
const selectedBlocks = process.env.MOMOTARO_DIALOGUE_BLOCKS?.split(',');
if (selectedBlocks) {
  for (const name of selectedBlocks) assert.ok(cases.some(entry => entry.name === name), `Unknown dialogue test block: ${name}`);
  report.selectedBlocks = selectedBlocks;
}
const selectedIndex = process.env.MOMOTARO_DIALOGUE_INDEX;
if (selectedIndex !== undefined) assert.match(selectedIndex, /^\d+$/, 'Dialogue index must be a nonnegative integer');
let selectedCases = cases.filter(entry => (!selectedBlocks || selectedBlocks.includes(entry.name))
  && (selectedIndex === undefined || (entry.firstIndex ?? 0) === Number(selectedIndex)));
if (process.env.MOMOTARO_DIALOGUE_SHARD) {
  assert.match(process.env.MOMOTARO_DIALOGUE_SHARD, /^\d+\/\d+$/);
  const [index, count] = process.env.MOMOTARO_DIALOGUE_SHARD.split('/').map(Number);
  const start = Number(process.env.MOMOTARO_DIALOGUE_START_CASE ?? 0);
  assert.ok(Number.isSafeInteger(start) && start >= 0 && start < selectedCases.length);
  assert.ok(count > 0 && index >= 0 && index < count);
  report.shard = { index, count, start, total: selectedCases.length };
  selectedCases = selectedCases.slice(start).filter((entry, position) => position % count === index);
}
assert.ok(selectedCases.length, 'No matching dialogue test cases');
if (dictionaryReference) {
  for (const scene of selectedCases) assert.equal(Number(scene.pointerOffset), 0x70000, 'Reference probes only support the shared dictionary');
  report.dictionaryReferenceProbes = selectedCases.map(scene => ({ index: scene.firstIndex,
    referenceHex: Buffer.from([2, 0xa0 + scene.firstIndex]).toString('hex') }));
}
report.plannedScenes = selectedCases.length;
if (isolatedRecords) {
  const glyphCodes = new Map(metadata.glyphs.map(glyph => [glyph.character, glyph.code]));
  const decodedBlocks = new Map();
  for (const scene of selectedCases) {
    const block = metadata.textBlocks.find(item => item.name === scene.name);
    const definition = manifest.textBlocks.find(item => item.name === scene.name);
    if (!decodedBlocks.has(block.name)) {
      const decode = (rom, start, end, size) => splitRecords(block.sourceType === 2
        ? decodeHuffman(rom, rom.subarray(start + 1, end), size).bytes
        : block.sourceType === 1 ? decodeLz(rom.subarray(start + 1, end)).bytes : rom.subarray(start + 1, end));
      const before = decode(original, block.sourceStart, block.sourceEnd, definition.decodedBytes);
      const after = decode(target, Number(block.relocatedOffset), Number(block.relocatedOffset) + block.storedBytes, block.decodedBytes);
      assert.equal(after.length, before.length, `Screenshot record indexes changed: ${block.name}`);
      const selected = new Set(definition.entries.map(entry => Number(entry.offset)));
      for (const record of before) {
        const offset = record.decodedOffset + (block.sourceType === 0 ? block.sourceStart + 1 : 0);
        if (!selected.has(offset)) assert.equal(after[record.index].originalHex, record.originalHex,
          `Unselected screenshot record changed: ${block.name}:${record.index}`);
      }
      decodedBlocks.set(block.name, { before, after });
    }
    const { before, after } = decodedBlocks.get(block.name);
    const offset = before[scene.firstIndex].decodedOffset + (block.sourceType === 0 ? block.sourceStart + 1 : 0);
    const entry = definition.entries.find(item => Number(item.offset) === offset);
    const expected = (entry.segments ?? [{ text: entry.translation }]).map(segment => segment.hex ??
      [...segment.text].map(character => {
        assert.ok(glyphCodes.has(character), `Missing screenshot glyph ${character}`);
        return glyphCodes.get(character);
      }).join('')).join('');
    assert.equal(after[scene.firstIndex].originalHex, expected,
      `Candidate differs from screenshot manifest: ${block.name}:${scene.firstIndex}`);
  }
  report.exactCandidateRecordsVerified = selectedCases.length;
}
if (resume) {
  assert.ok(!fs.existsSync(path.join(outputDirectory, 'verification.json')), 'Verification already completed');
  const progress = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'verification-progress.json')));
  assert.deepEqual({ ...progress, scenes: [] }, report, 'Resume metadata differs from current verification');
  assert.ok(progress.scenes.length <= selectedCases.length);
  for (const [index, completed] of progress.scenes.entries()) {
    const { changedFrames, originalRelocationFramesIdentical, renderedWords: matches, ...definition } = completed;
    assert.deepEqual(definition, { ...selectedCases[index], firstIndex: selectedCases[index].firstIndex ?? 0 });
    assert.ok(changedFrames > 0 && originalRelocationFramesIdentical === true);
    const directory = path.join(outputDirectory, `${completed.name}-${completed.firstIndex}-translated`);
    assert.deepEqual(renderedWords(directory, completed.words), matches);
  }
  report.scenes.push(...progress.scenes);
  const pending = selectedCases[report.scenes.length];
  if (pending) for (const kind of ['source', 'control', 'translated']) {
    const filename = path.join(outputDirectory, `${pending.name}-${pending.firstIndex ?? 0}-${kind}`);
    fs.rmSync(filename, { recursive: true, force: true });
    fs.rmSync(`${filename}.sfc`, { force: true });
  }
}
const title = resume ? path.join(outputDirectory, 'title')
  : run(path.join(previewDirectory, metadata.romFilename), 'title', 1380, metadata.welcome ? '30:3:start,1201:2:start' : '1201:2:start');
function cleanCapture(directory, keep = []) {
  if (!cleanup) return;
  for (const filename of fs.readdirSync(directory)) {
    if ((/^(?:frame-\d+\.ppm|(?:vram|wram)-\d+\.bin)$/.test(filename) || ['audio.wav', 'state.bin', 'sram.bin'].includes(filename))
      && !keep.includes(filename)) fs.unlinkSync(path.join(directory, filename));
  }
}
cleanCapture(title, ['state.bin']);
for (const scene of selectedCases.slice(report.scenes.length)) {
  const { name, frames, words, firstIndex = 0 } = scene;
  const block = metadata.textBlocks.find(entry => entry.name === name);
  assert.ok(block, `Missing dialogue block: ${name}`);
  if (block.sourceType !== 0) {
    if (block.complete) assert.equal(block.translatedNames, block.strings);
    else {
      const definition = manifest.textBlocks.find(entry => entry.name === name);
      const decode = (rom, start, end, count) => splitRecords(block.sourceType === 2
        ? decodeHuffman(rom, rom.subarray(start + 1, end), count).bytes
        : decodeLz(rom.subarray(start + 1, end)).bytes);
      const before = decode(original, block.sourceStart, block.sourceEnd, definition.decodedBytes);
      const after = decode(target, Number(block.relocatedOffset), Number(block.relocatedOffset) + block.storedBytes, block.decodedBytes);
      assert.equal(after.length, before.length);
      const selected = new Set(definition.entries.map(entry => Number(entry.offset)));
      assert.ok(selected.has(before[firstIndex]?.decodedOffset), 'Test starts at an untranslated record');
      for (const record of before) if (!selected.has(record.decodedOffset)) {
        assert.equal(after[record.index].originalHex, record.originalHex, `Unselected record changed: ${name}-${record.index}`);
      }
    }
  }
  const label = `${name}-${firstIndex}`;
  const probeOffset = Number(scene.pointerOffset) === 0x70000 || ['screenshot-locations', 'main-messages'].includes(name)
    ? 0x3f8000 : Number(block.relocatedOffset);
  const bounded = isolatedRecords || firstIndex || block.strings < 16 || ['screenshot-locations', 'main-messages'].includes(name);
  const sourceProbe = bounded ? rotatedProbe(`${label}-source`, block, true, firstIndex, 0x3f0000) : writeProbe(`${label}-source`, block.sourceStart);
  const controlProbe = bounded ? rotatedProbe(`${label}-control`, block, true, firstIndex, probeOffset) : writeProbe(`${label}-control`, Number(block.relocatedOffset), block);
  const translatedProbe = bounded ? rotatedProbe(`${label}-translated`, block, false, firstIndex, probeOffset) : writeProbe(`${label}-translated`, Number(block.relocatedOffset));
  const state = path.join(title, 'state.bin');
  const sceneInputs = isolatedRecords
    ? ['1:2:a', ...Array.from({ length: Math.ceil(frames / 600) }, (_, index) => `${1800 + index * 600}:3:a`)].join(',') : inputs;
  const source = run(sourceProbe, `${label}-source`, frames, sceneInputs, state);
  const control = run(controlProbe, `${label}-control`, frames, sceneInputs, state);
  const translated = run(translatedProbe, `${label}-translated`, frames, sceneInputs, state);
  let changedFrames = 0;
  for (let frame = 60; frame <= frames; frame += 60) {
    const image = `frame-${frame}.ppm`;
    assert.ok(fs.readFileSync(path.join(source, image)).equals(fs.readFileSync(path.join(control, image))), `Original dialogue relocation changed rendering: ${name} frame ${frame}`);
    if (!fs.readFileSync(path.join(source, image)).equals(fs.readFileSync(path.join(translated, image)))) changedFrames++;
  }
  assert.ok(changedFrames > 0, `Dialogue translation never rendered: ${name}`);
  const matches = renderedWords(translated, words);
  report.scenes.push({ ...scene, firstIndex, changedFrames, originalRelocationFramesIdentical: true, renderedWords: matches });
  fs.writeFileSync(path.join(outputDirectory, 'verification-progress.json'), `${JSON.stringify(report, null, 2)}\n`);
  cleanCapture(source);
  cleanCapture(control);
  cleanCapture(translated, [...new Set(Object.values(matches).map(match => match.frame))]);
  if (cleanup) for (const filename of [sourceProbe, controlProbe, translatedProbe]) fs.unlinkSync(filename);
  console.log(`PASS ${label}: ${words.length} exact words; source/control frames identical`);
}
fs.writeFileSync(path.join(outputDirectory, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ targetSha256: report.targetSha256, scenes: report.scenes.length,
  words: report.scenes.reduce((total, scene) => total + Object.keys(scene.renderedWords).length, 0),
  actualStoryRouteVerified: report.actualStoryRouteVerified, report: path.join(outputDirectory, 'verification.json') }, null, 2));